import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preflight } from "./preflight";

/**
 * QA, M1: the preflight check (C2: "checks /healthz + demo site first"; the lead's brief: "demo
 * site down, API down, image missing: preflight must list ALL problems"). It had no tests.
 * Real sockets, no mocks of fetch: what the check sees is what a person starting the runner sees.
 */

const docker = (
  ping: () => Promise<void> = async () => undefined,
  hasImage = async () => true,
) => ({
  ping,
  hasImage,
});

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections(); // a "hang" server still holds its sockets
          server.close(resolve);
        }),
    ),
  );
});

/** A server that answers every request with the given status (or never, for `hang`). */
async function serve(status: number | "hang"): Promise<string> {
  const server = createServer((_request, response) => {
    if (status === "hang") return; // never answer
    response.writeHead(status, { "content-type": "application/json" });
    response.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A port that nothing listens on (it was free a moment ago). */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Does Node on this machine fail a refused `localhost` connection with an empty message? (QA-M1-02)
const emptyMessageHere = await fetch(`http://localhost:${await closedPort()}`).then(
  () => false,
  (error: { cause?: { message?: string } }) => error.cause?.message === "",
);

const checks = (problems: Array<{ check: string }>) => problems.map((p) => p.check).sort();

describe("preflight", () => {
  it("finds nothing wrong when everything answers", async () => {
    const ok = await serve(200);
    const problems = await preflight({
      apiUrl: ok,
      demoSiteUrl: ok,
      browserImage: "img:1",
      docker: docker(),
    });
    expect(problems).toEqual([]);
  });

  it("reports an API or demo site that answers with an error status", async () => {
    const bad = await serve(503);
    const ok = await serve(200);
    const problems = await preflight({
      apiUrl: bad,
      demoSiteUrl: bad,
      browserImage: "img:1",
      docker: docker(),
    });
    expect(checks(problems)).toEqual(["api", "demo-site"]);
    expect(problems[0]?.message).toMatch(/HTTP 503/);
    expect(
      checks(
        await preflight({ apiUrl: ok, demoSiteUrl: bad, browserImage: "img:1", docker: docker() }),
      ),
    ).toEqual(["demo-site"]);
  });

  it("reports an API that accepts the connection and never answers, after about 3 seconds", async () => {
    const hang = await serve("hang");
    const ok = await serve(200);
    const t0 = Date.now();
    const problems = await preflight({
      apiUrl: hang,
      demoSiteUrl: ok,
      browserImage: "img:1",
      docker: docker(),
    });
    expect(checks(problems)).toEqual(["api"]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
    expect(Date.now() - t0).toBeLessThan(6000);
  }, 15_000);

  it("reports an address nobody listens on: 127.0.0.1 gives a plain connection error", async () => {
    const port = await closedPort();
    const ok = await serve(200);
    const problems = await preflight({
      apiUrl: `http://127.0.0.1:${port}`,
      demoSiteUrl: ok,
      browserImage: "img:1",
      docker: docker(),
    });
    expect(checks(problems)).toEqual(["api"]);
    expect(problems[0]?.message).toMatch(/ECONNREFUSED/);
  });

  // QA-M1-02. `localhost` (the default of FLEETSCOPE_API_URL and DEMO_SITE_URL) resolves to ::1
  // and 127.0.0.1; when both refuse, Node's fetch fails with a TypeError("fetch failed") whose
  // cause is an AggregateError with an EMPTY message (code ECONNREFUSED). fetchOk() returns that
  // empty string, and `if (problem)` treats "" as "no problem". So a stopped API or demo site is
  // not reported at all, and the run starts.
  //
  // The first test fakes exactly that error, so it behaves the same on every machine. The second
  // uses real sockets; it only means something where Node really produces the empty message (this
  // Windows machine, dual-stack localhost), so it is skipped elsewhere.
  const nodeError = () =>
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new AggregateError([new Error(), new Error()]), {
        code: "ECONNREFUSED",
      }),
    });

  it.fails("QA-M1-02: reports an API and a demo site whose connection fails with Node's empty AggregateError", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(nodeError()));
    try {
      const problems = await preflight({
        apiUrl: "http://localhost:4000",
        demoSiteUrl: "http://localhost:3100",
        browserImage: "img:1",
        docker: docker(),
      });
      expect(checks(problems)).toEqual(["api", "demo-site"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  (emptyMessageHere ? it.fails : it.skip)(
    "QA-M1-02: (real sockets) reports an API and a demo site that are down when they are addressed as localhost",
    async () => {
      const problems = await preflight({
        apiUrl: `http://localhost:${await closedPort()}`,
        demoSiteUrl: `http://localhost:${await closedPort()}`,
        browserImage: "img:1",
        docker: docker(),
      });
      expect(checks(problems)).toEqual(["api", "demo-site"]);
      for (const problem of problems) expect(problem.message).toMatch(/(S.*)/); // says why
    },
  );

  it("reports an unreachable Docker, and does not look for the image then", async () => {
    const ok = await serve(200);
    let imageLookups = 0;
    const problems = await preflight({
      apiUrl: ok,
      demoSiteUrl: ok,
      browserImage: "img:1",
      docker: docker(
        () => Promise.reject(new Error("connect ENOENT //./pipe/docker_engine")),
        async () => {
          imageLookups++;
          return true;
        },
      ),
    });
    expect(checks(problems)).toEqual(["docker"]);
    expect(problems[0]?.message).toContain("ENOENT");
    expect(problems[0]?.message).toContain("Docker Desktop");
    expect(imageLookups).toBe(0);
  });

  it("reports a missing image with the command that builds it, and an image lookup that fails", async () => {
    const ok = await serve(200);
    const missing = await preflight({
      apiUrl: ok,
      demoSiteUrl: ok,
      browserImage: "fleetscope/playwright-chromium:9.9.9",
      docker: docker(undefined, async () => false),
    });
    expect(checks(missing)).toEqual(["image"]);
    expect(missing[0]?.message).toContain("fleetscope/playwright-chromium:9.9.9");
    expect(missing[0]?.message).toContain("pnpm browsers:build");

    const broken = await preflight({
      apiUrl: ok,
      demoSiteUrl: ok,
      browserImage: "img:1",
      docker: docker(undefined, () => Promise.reject(new Error("daemon is busy"))),
    });
    expect(checks(broken)).toEqual(["image"]);
    expect(broken[0]?.message).toContain("daemon is busy");
  });

  it("lists every problem in one go: API error, hanging demo site, and a missing image", async () => {
    const bad = await serve(500);
    const hang = await serve("hang");
    const problems = await preflight({
      apiUrl: bad,
      demoSiteUrl: hang,
      browserImage: "img:1",
      docker: docker(undefined, async () => false),
    });
    expect(checks(problems)).toEqual(["api", "demo-site", "image"]);
  }, 15_000);
});

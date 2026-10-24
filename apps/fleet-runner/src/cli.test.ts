import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import { afterAll, describe, expect, it } from "vitest";

/**
 * QA, M1: the real command line, as a process. Exit codes are part of the contract:
 * 0 ok, 1 something failed (preflight, infra error, undelivered events), 2 wrong usage, 130 Ctrl+C.
 * Nothing here starts a browser. The tests that need Docker are skipped when it is not running.
 */

const packageDir = fileURLToPath(new URL("..", import.meta.url));

// Each test starts a fresh Node + tsx process, and the usage tests start 14 of them at once.
// On a 2-4 core CI runner that cold start alone can pass vitest's 5 s default, so give each
// test the same budget as the process itself (runCli's 60 s).
const CLI_TEST_TIMEOUT_MS = 60_000;

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<Outcome> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      {
        cwd: packageDir,
        env: { ...process.env, LOG_LEVEL: "warn", ...env },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === "number" ? code : 1, stdout, stderr, ms: Date.now() - t0 });
      },
    );
  });
}

const dockerUp = await new Docker()
  .ping()
  .then(() => true)
  .catch(() => false);

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
});
async function okServer(): Promise<string> {
  const server = createServer((_req, res) => res.end("{}"));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe("pnpm fleet: usage errors exit with 2 and print the usage", () => {
  it.concurrent.each([
    [["run", "--sessions", "0"], "--sessions must be a whole number from 1 to 100000"],
    [["run", "--sessions", "1.5"], "--sessions must be a whole number"],
    [["run", "--sessions", "100001"], "--sessions must be a whole number"],
    [["run", "--concurrency", "0"], "--concurrency must be a whole number from 1 to 64"],
    [["run", "--engines", "chrome"], 'did you mean "chromium"?'],
    [["run", "--engines", "firefox"], "unknown engine"],
    [["run", "--engines", ","], "needs at least one engine"],
    [["run", "--scenario", "nope"], "unknown scenario"],
    [["run", "--seed", "1.5"], "--seed must be a non-negative whole number"],
    [["run", "--seed", "-1"], "--seed"],
    [["run", "--bogus"], "Unknown option"],
    [["run", "stray"], "positional"],
    [["nonsense"], 'unknown command "nonsense"'],
    [[], "Usage:"],
  ])(
    "%j",
    async (args, message) => {
      const out = await runCli(args);
      expect(out.code).toBe(2);
      expect(out.stderr + out.stdout).toContain(message);
      expect(out.stderr + out.stdout).toContain("pnpm fleet run");
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "help exits 0 and documents every flag",
    async () => {
      const out = await runCli(["--help"]);
      expect(out.code).toBe(0);
      for (const flag of [
        "--engines",
        "--sessions",
        "--concurrency",
        "--scenario",
        "--seed",
        "--agent",
        "--session-timeout",
        "cleanup",
      ]) {
        expect(out.stdout).toContain(flag);
      }
    },
    CLI_TEST_TIMEOUT_MS,
  );
});

describe("pnpm fleet run: preflight", () => {
  it("exits 1 before starting anything when Docker cannot be reached, and says so", async () => {
    const ok = await okServer();
    const out = await runCli(["run", "--sessions", "2"], {
      FLEETSCOPE_API_URL: ok,
      DEMO_SITE_URL: ok,
      DOCKER_HOST: `tcp://127.0.0.1:${await closedPort()}`,
    });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("Cannot start the run:");
    expect(out.stderr).toMatch(/cannot reach Docker \(connect ECONNREFUSED/);
    expect(out.stderr).toContain("Is Docker Desktop running?");
    expect(out.stdout).toBe(""); // no run summary: nothing was started
  });

  it("a DOCKER_HOST that is not an address at all is a clean message, not a stack trace", async () => {
    const ok = await okServer();
    const out = await runCli(["run", "--sessions", "2"], {
      FLEETSCOPE_API_URL: ok,
      DEMO_SITE_URL: ok,
      DOCKER_HOST: "banana",
    });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("cannot reach Docker");
    expect(out.stderr).not.toContain("    at ");
  });

  it.skipIf(!dockerUp)("names a missing browser image and the command that builds it", async () => {
    const ok = await okServer();
    const out = await runCli(["run", "--sessions", "2"], {
      FLEETSCOPE_API_URL: ok,
      DEMO_SITE_URL: ok,
      FLEET_BROWSER_IMAGE: "fleetscope/qa-image-that-does-not-exist:0.0.0",
    });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("browser image fleetscope/qa-image-that-does-not-exist:0.0.0");
    expect(out.stderr).toContain("pnpm browsers:build");
    // exactly one problem: API and demo site were fine
    expect(out.stderr.match(/^ {2}- /gm)).toHaveLength(1);
  });

  // QA-M1-02 (verified in the re-test), end to end: API, demo site and Docker all down, addressed the way the defaults
  // are (localhost). All three must be listed (it used to be only Docker, see preflight.test.ts).
  it("QA-M1-02: lists the API, the demo site and Docker when all three are down", async () => {
    const out = await runCli(["run", "--sessions", "2"], {
      FLEETSCOPE_API_URL: `http://localhost:${await closedPort()}`,
      DEMO_SITE_URL: `http://localhost:${await closedPort()}`,
      DOCKER_HOST: `tcp://127.0.0.1:${await closedPort()}`,
    });
    expect(out.code).toBe(1);
    expect(out.stderr.match(/^ {2}- /gm)).toHaveLength(3);
    expect(out.stderr).toMatch(/API not healthy at http:\/\/localhost:\d+\/healthz/);
    expect(out.stderr).toMatch(/demo site not answering at http:\/\/localhost:\d+/);
  });
});

describe("pnpm fleet cleanup", () => {
  it("says it cannot reach Docker and exits 1", async () => {
    const out = await runCli(["cleanup"], { DOCKER_HOST: `tcp://127.0.0.1:${await closedPort()}` });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("Cannot reach Docker");
  });

  // `cleanup` removes EVERY container labelled fleetscope.session, including those of a run someone
  // else has going. So this one only runs on request: FLEET_E2E=1.
  it.skipIf(!dockerUp || !process.env.FLEET_E2E)(
    "removes only containers carrying the session label, and is safe to repeat",
    async () => {
      const docker = new Docker();
      const image = process.env.FLEET_BROWSER_IMAGE ?? "fleetscope/playwright-chromium:1.64.1";
      const hasImage = await docker
        .getImage(image)
        .inspect()
        .then(() => true)
        .catch(() => false);
      if (!hasImage) return; // nothing to start; the unit tests cover removeAllOwned with fakes
      const make = async (labels: Record<string, string>) => {
        const c = await docker.createContainer({ Image: image, Labels: labels });
        return c; // created, never started: enough for `listContainers({ all: true })`
      };
      const ours = await make({
        "fleetscope.session": "qa-cleanup-1",
        "fleetscope.engine": "chromium",
      });
      const theirs = await make({ "qa.unrelated": "1" });
      try {
        const first = await runCli(["cleanup"]);
        expect(first.code).toBe(0);
        expect(first.stdout).toMatch(/Removed \d+ containers? labelled fleetscope.session\./);
        const left = (await docker.listContainers({ all: true })).map((c) => c.Id);
        expect(left).not.toContain(ours.id);
        expect(left).toContain(theirs.id); // not ours, not touched

        const second = await runCli(["cleanup"]);
        expect(second.code).toBe(0);
        expect(second.stdout).toContain("Removed 0 containers");
      } finally {
        await theirs.remove({ force: true }).catch(() => undefined);
        await ours.remove({ force: true }).catch(() => undefined);
      }
    },
    60_000,
  );
});

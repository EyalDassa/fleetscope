import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Docker from "dockerode";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerFleet, LABEL_ROLE, readEngineVersion } from "./docker";

const logger = pino({ level: "silent" });
let server: Server | undefined;

afterEach(async () => {
  const closing = server;
  server = undefined;
  if (!closing) return;
  closing.closeAllConnections();
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

/** Answers every path with `body` and remembers which paths were asked. */
async function fakeBrowser(body: string): Promise<{ port: number; paths: string[] }> {
  const paths: string[] = [];
  const created = createServer((req, res) => {
    paths.push(req.url ?? "");
    res.end(body);
  });
  server = created;
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  return { port: (created.address() as AddressInfo).port, paths };
}

const logFrame = (text: string) => {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 2;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

function browserContainer(containerPort: number, hostPort: number, order: string[]) {
  return {
    id: "browser-1",
    start: vi.fn(async () => undefined),
    inspect: vi.fn(async () => ({
      NetworkSettings: {
        Ports: { [`${containerPort}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(hostPort) }] },
      },
      State: { Running: true, ExitCode: 0, StartedAt: "2026-10-24T12:00:00Z" },
    })),
    remove: vi.fn(async () => void order.push("browser")),
    stats: vi.fn(),
    logs: vi.fn(async () => Buffer.from("")),
  };
}

function sidecarContainer(
  order: string[],
  { logs, running = true, exitCode = 0 }: { logs: string; running?: boolean; exitCode?: number },
) {
  return {
    id: "sidecar-1",
    start: vi.fn(async () => undefined),
    inspect: vi.fn(async () => ({ State: { Running: running, ExitCode: exitCode } })),
    remove: vi.fn(async () => void order.push("sidecar")),
    logs: vi.fn(async () => logFrame(logs)),
  };
}

function setup(
  containerPort: number,
  hostPort: number,
  sidecar: ReturnType<typeof sidecarContainer>,
  order: string[],
) {
  const browser = browserContainer(containerPort, hostPort, order);
  const createContainer = vi.fn().mockResolvedValueOnce(browser).mockResolvedValueOnce(sidecar);
  return { browser, createContainer, docker: { createContainer } as unknown as Docker };
}

const LISTENING = "forward-port: 127.0.0.1:3100 -> host.docker.internal:3100\n";

describe("DockerFleet with a forwarder sidecar", () => {
  it("starts the sidecar in the browser's network namespace, labelled, with its own env", async () => {
    const order: string[] = [];
    const { port } = await fakeBrowser("{}");
    const sidecar = sidecarContainer(order, { logs: LISTENING });
    const { createContainer, docker } = setup(3000, port, sidecar, order);
    const fleet = new DockerFleet("browser:1", "chromium", logger, {
      docker,
      runId: "run1",
      forwarder: { image: "fwd:1", env: ["DEMO_SITE_UPSTREAM=host.docker.internal:3100"] },
    });

    const started = await fleet.startBrowser({ sessionId: "s1" });

    expect(createContainer).toHaveBeenCalledTimes(2);
    const browserOptions = createContainer.mock.calls[0]?.[0];
    expect(browserOptions.Labels[LABEL_ROLE]).toBe("browser");
    expect(browserOptions.HostConfig.ExtraHosts).toEqual(["host.docker.internal:host-gateway"]);
    const sidecarOptions = createContainer.mock.calls[1]?.[0];
    expect(sidecarOptions).toMatchObject({
      Image: "fwd:1",
      Env: ["DEMO_SITE_UPSTREAM=host.docker.internal:3100"],
      Labels: {
        [LABEL_ROLE]: "forwarder",
        "fleetscope.session": "s1",
        "fleetscope.run": "run1",
        "fleetscope.engine": "chromium",
      },
      HostConfig: { NetworkMode: "container:browser-1" },
    });
    expect(sidecarOptions.HostConfig.ExtraHosts).toBeUndefined();

    // Teardown order: the sidecar first, then the browser.
    await started.remove();
    expect(order).toEqual(["sidecar", "browser"]);
  });

  it("a taken port is a hard error: the browser image runs its own forwarder (R-M3-02)", async () => {
    const order: string[] = [];
    const { port } = await fakeBrowser("{}");
    const sidecar = sidecarContainer(order, {
      logs: "forward-port: cannot listen on 127.0.0.1:3100: listen EADDRINUSE: address already in use 127.0.0.1:3100\n",
      running: false,
      exitCode: 1,
    });
    const { docker } = setup(3000, port, sidecar, order);
    const fleet = new DockerFleet("browser:1", "chromium", logger, {
      docker,
      forwarder: { image: "fwd:1" },
    });
    await expect(fleet.startBrowser({ sessionId: "s1" })).rejects.toThrow(
      /already taken inside the browser container.*pnpm browsers:build/,
    );
    expect(order).toEqual(["sidecar", "browser"]);
  });

  it("reports whether the sidecar is still running", async () => {
    const order: string[] = [];
    const { port } = await fakeBrowser("{}");
    const sidecar = sidecarContainer(order, { logs: LISTENING });
    const { docker } = setup(3000, port, sidecar, order);
    const started = await new DockerFleet("browser:1", "chromium", logger, {
      docker,
      forwarder: { image: "fwd:1" },
    }).startBrowser({ sessionId: "s1" });
    expect(await started.forwarderExited()).toBe(false);
    sidecar.inspect.mockResolvedValue({ State: { Running: false, ExitCode: 1 } });
    expect(await started.forwarderExited()).toBe(true);
  });

  it("fails the session, and removes both containers, if the sidecar dies for another reason", async () => {
    const order: string[] = [];
    const { port } = await fakeBrowser("{}");
    const sidecar = sidecarContainer(order, {
      logs: 'forward-port: expected <host>:<port>, got "x"\n',
      running: false,
      exitCode: 2,
    });
    const { docker } = setup(3000, port, sidecar, order);
    const fleet = new DockerFleet("browser:1", "chromium", logger, {
      docker,
      forwarder: { image: "fwd:1" },
    });
    await expect(fleet.startBrowser({ sessionId: "s1" })).rejects.toThrow(
      /forwarder sidecar exited with code 2/,
    );
    expect(order).toEqual(["sidecar", "browser"]);
  });

  it("starts no sidecar when none is configured", async () => {
    const order: string[] = [];
    const { port } = await fakeBrowser("{}");
    const { createContainer, docker } = setup(
      3000,
      port,
      sidecarContainer(order, { logs: "" }),
      order,
    );
    await new DockerFleet("browser:1", "chromium", logger, { docker }).startBrowser({
      sessionId: "s1",
    });
    expect(createContainer).toHaveBeenCalledTimes(1);
  });
});

describe("engine table in DockerFleet", () => {
  it.each([
    ["chromium", 3000, "/", "playwright-server", /^ws:\/\/127\.0\.0\.1:\d+\/$/],
    ["chrome-headless-shell", 9222, "/json/version", "cdp-http", /^http:\/\/127\.0\.0\.1:\d+$/],
    ["lightpanda", 9222, "/json/version", "cdp-ws", /^ws:\/\/127\.0\.0\.1:\d+\/$/],
  ] as const)(
    "%s: port %i, ready at %s, connect %s",
    async (engine, containerPort, path, mode, endpoint) => {
      const order: string[] = [];
      const { port, paths } = await fakeBrowser('{"Lightpanda-Version":"1.0.2"}');
      const { createContainer, docker } = setup(
        containerPort,
        port,
        sidecarContainer(order, { logs: LISTENING }),
        order,
      );
      const started = await new DockerFleet("img", engine, logger, { docker }).startBrowser({
        sessionId: "s1",
      });

      expect(createContainer.mock.calls[0]?.[0].ExposedPorts).toEqual({
        [`${containerPort}/tcp`]: {},
      });
      expect(paths[0]).toBe(path);
      expect(started.connectMode).toBe(mode);
      expect(started.endpoint).toMatch(endpoint);
    },
  );

  it("Lightpanda's version comes from /json/version", () => {
    expect(readEngineVersion('{"Browser":"Lightpanda/1.0","Lightpanda-Version":"1.0.2"}')).toBe(
      "1.0.2",
    );
    expect(readEngineVersion('{"Browser":"Chrome/156"}')).toBeUndefined();
    expect(readEngineVersion("not json")).toBeUndefined();
  });
});

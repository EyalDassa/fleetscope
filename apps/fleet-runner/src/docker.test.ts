import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Docker from "dockerode";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerFleet, LABEL_ENGINE, LABEL_SESSION } from "./docker";

const logger = pino({ level: "silent" });

let server: Server | undefined;

afterEach(async () => {
  const closing = server;
  server = undefined;
  if (!closing) return;
  closing.closeAllConnections();
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

/** Stands in for Playwright's run-server: answers 200 "Running" after `failFirst` bad answers. */
async function fakeBrowserServer(failFirst = 0): Promise<number> {
  let calls = 0;
  const created = createServer((_req, res) => {
    if (calls++ < failFirst) {
      res.writeHead(502);
      res.end("not yet");
    } else {
      res.end("Running");
    }
  });
  server = created;
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  return (created.address() as AddressInfo).port;
}

function fakeContainer(hostPort: number | null, overrides: Record<string, unknown> = {}) {
  return {
    id: "container-1",
    start: vi.fn(async () => undefined),
    inspect: vi.fn(async () => ({
      NetworkSettings: {
        Ports: {
          "3000/tcp":
            hostPort === null ? null : [{ HostIp: "127.0.0.1", HostPort: String(hostPort) }],
        },
      },
      State: { Running: true, ExitCode: 0 },
    })),
    remove: vi.fn(async () => undefined),
    stats: vi.fn(async () => ({ memory_stats: { usage: 1 } })),
    logs: vi.fn(async () => Buffer.from("")),
    ...overrides,
  };
}

function fakeDocker(container: ReturnType<typeof fakeContainer>) {
  const createContainer = vi.fn(async (_options: unknown) => container);
  const docker = { createContainer } as unknown as Docker;
  return { docker, createContainer };
}

describe("DockerFleet.startBrowser", () => {
  it("creates the container the contract describes", async () => {
    const port = await fakeBrowserServer();
    const container = fakeContainer(port);
    const { docker, createContainer } = fakeDocker(container);
    const fleet = new DockerFleet("fleetscope/playwright-chromium:1.64.1", "chromium", logger, {
      docker,
      env: ["DEMO_SITE_UPSTREAM=host.docker.internal:3100"],
    });

    const browser = await fleet.startBrowser({ sessionId: "sess-1" });

    expect(createContainer).toHaveBeenCalledTimes(1);
    expect(createContainer.mock.calls[0]?.[0]).toMatchObject({
      Image: "fleetscope/playwright-chromium:1.64.1",
      Env: ["DEMO_SITE_UPSTREAM=host.docker.internal:3100"],
      Labels: { [LABEL_ENGINE]: "chromium", [LABEL_SESSION]: "sess-1" },
      ExposedPorts: { "3000/tcp": {} },
      HostConfig: {
        Init: true,
        IpcMode: "host",
        // random host port (empty HostPort), bound to loopback only
        PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
    });
    expect(container.start).toHaveBeenCalled();
    expect(browser.wsEndpoint).toBe(`ws://127.0.0.1:${port}/`);
    expect(browser.id).toBe("container-1");
    expect(browser.startupMs).toBeGreaterThanOrEqual(0);
    expect(container.remove).not.toHaveBeenCalled();
  });

  it("passes no Env when none is configured", async () => {
    const port = await fakeBrowserServer();
    const { docker, createContainer } = fakeDocker(fakeContainer(port));
    await new DockerFleet("img", "chromium", logger, { docker }).startBrowser({ sessionId: "s" });
    expect(createContainer.mock.calls[0]?.[0]).toMatchObject({ Env: [] });
  });

  it("waits until the server answers, however early the port accepts connections", async () => {
    const port = await fakeBrowserServer(3);
    const { docker } = fakeDocker(fakeContainer(port));
    const browser = await new DockerFleet("img", "chromium", logger, { docker }).startBrowser({
      sessionId: "s",
    });
    expect(browser.startupMs).toBeGreaterThanOrEqual(250); // three 100 ms polls
  });

  it("removes the container and throws if the server never answers", async () => {
    const container = fakeContainer(1); // nothing listens on port 1
    const { docker } = fakeDocker(container);
    await expect(
      new DockerFleet("img", "chromium", logger, { docker }).startBrowser({
        sessionId: "s",
        readyTimeoutMs: 400,
      }),
    ).rejects.toThrow(/did not answer within 400 ms/);
    expect(container.remove).toHaveBeenCalledWith({ force: true, v: true });
  });

  it("removes the container if Docker published no port", async () => {
    const container = fakeContainer(null);
    const { docker } = fakeDocker(container);
    await expect(
      new DockerFleet("img", "chromium", logger, { docker }).startBrowser({ sessionId: "s" }),
    ).rejects.toThrow(/did not publish/);
    expect(container.remove).toHaveBeenCalled();
  });

  it("removes the container if it was interrupted while starting", async () => {
    const container = fakeContainer(1);
    const { docker } = fakeDocker(container);
    const abort = new AbortController();
    abort.abort();
    await expect(
      new DockerFleet("img", "chromium", logger, { docker }).startBrowser({
        sessionId: "s",
        signal: abort.signal,
      }),
    ).rejects.toThrow(/interrupted/);
    expect(container.remove).toHaveBeenCalled();
  });

  it("reports the exit code and last log lines if the container dies while starting", async () => {
    const container = fakeContainer(1, {
      inspect: vi.fn(async () => ({
        NetworkSettings: { Ports: { "3000/tcp": [{ HostPort: "1" }] } },
        State: { Running: false, ExitCode: 137 },
      })),
      logs: vi.fn(async () => Buffer.from("Error: out of memory\n")),
    });
    const { docker } = fakeDocker(container);
    await expect(
      new DockerFleet("img", "chromium", logger, { docker }).startBrowser({
        sessionId: "s",
        readyTimeoutMs: 5000,
      }),
    ).rejects.toThrow(/exited with code 137.*out of memory/);
    expect(container.remove).toHaveBeenCalled();
  });

  it("remove() treats 'no such container' and 'already being removed' as done", async () => {
    const port = await fakeBrowserServer();
    for (const statusCode of [404, 409]) {
      const container = fakeContainer(port, {
        remove: vi.fn(async () => {
          throw Object.assign(new Error("gone"), { statusCode });
        }),
      });
      const { docker } = fakeDocker(container);
      const browser = await new DockerFleet("img", "chromium", logger, { docker }).startBrowser({
        sessionId: "s",
      });
      await expect(browser.remove()).resolves.toBeUndefined();
    }
  });

  it("remove() reports a real failure", async () => {
    const port = await fakeBrowserServer();
    const container = fakeContainer(port, {
      remove: vi.fn(async () => {
        throw Object.assign(new Error("daemon error"), { statusCode: 500 });
      }),
    });
    const { docker } = fakeDocker(container);
    const browser = await new DockerFleet("img", "chromium", logger, { docker }).startBrowser({
      sessionId: "s",
    });
    await expect(browser.remove()).rejects.toThrow("daemon error");
  });

  it("readStats asks Docker for a non-streaming reading", async () => {
    const port = await fakeBrowserServer();
    const container = fakeContainer(port);
    const { docker } = fakeDocker(container);
    const browser = await new DockerFleet("img", "chromium", logger, { docker }).startBrowser({
      sessionId: "s",
    });
    await browser.readStats();
    expect(container.stats).toHaveBeenCalledWith({ stream: false });
  });
});

describe("DockerFleet cleanup and checks", () => {
  it("removeAllOwned finds containers by the session label, in any state, and removes them", async () => {
    const remove = vi.fn(async () => undefined);
    const listContainers = vi.fn(async () => [{ Id: "a" }, { Id: "b" }]);
    const getContainer = vi.fn(() => ({ remove }));
    const fleet = new DockerFleet("img", "chromium", logger, {
      docker: { listContainers, getContainer } as unknown as Docker,
    });

    expect(await fleet.removeAllOwned()).toBe(2);
    expect(listContainers).toHaveBeenCalledWith({ all: true, filters: { label: [LABEL_SESSION] } });
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith({ force: true, v: true });
  });

  it("removeAllOwned keeps going when one container is already gone or fails", async () => {
    const listContainers = vi.fn(async () => [{ Id: "gone" }, { Id: "broken" }, { Id: "ok" }]);
    const getContainer = vi.fn((id: string) => ({
      remove: vi.fn(async () => {
        if (id === "gone") throw Object.assign(new Error("no such container"), { statusCode: 404 });
        if (id === "broken") throw Object.assign(new Error("boom"), { statusCode: 500 });
      }),
    }));
    const fleet = new DockerFleet("img", "chromium", logger, {
      docker: { listContainers, getContainer } as unknown as Docker,
    });
    expect(await fleet.removeAllOwned()).toBe(1);
  });

  it("hasImage is false for a missing image and rethrows other errors", async () => {
    const inspect = vi.fn();
    const fleet = new DockerFleet("img:1", "chromium", logger, {
      docker: { getImage: () => ({ inspect }) } as unknown as Docker,
    });
    inspect.mockResolvedValueOnce({});
    expect(await fleet.hasImage()).toBe(true);
    inspect.mockRejectedValueOnce(Object.assign(new Error("no such image"), { statusCode: 404 }));
    expect(await fleet.hasImage()).toBe(false);
    inspect.mockRejectedValueOnce(Object.assign(new Error("daemon down"), { statusCode: 500 }));
    await expect(fleet.hasImage()).rejects.toThrow("daemon down");
  });
});

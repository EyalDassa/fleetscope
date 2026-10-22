import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function appWithLogs(ping: () => Promise<boolean>) {
  const lines: Array<Record<string, unknown>> = [];
  const app = buildApp({
    ping,
    logLevel: "info",
    logStream: { write: (line) => lines.push(JSON.parse(line)) },
  });
  apps.push(app);
  return { app, lines };
}

describe("request logging", () => {
  it("does not log the probe itself for a healthy /healthz", async () => {
    const { app, lines } = appWithLogs(async () => true);
    await app.inject({ method: "GET", url: "/healthz" });
    await app.inject({ method: "GET", url: "/healthz?probe=1" });
    expect(
      lines.filter((l) => l.msg === "incoming request" || l.msg === "request completed"),
    ).toEqual([]);
  });

  it("still warns when ClickHouse is down", async () => {
    const { app, lines } = appWithLogs(async () => false);
    await app.inject({ method: "GET", url: "/healthz" });
    expect(lines.some((l) => l.level === 40 && String(l.msg).includes("ClickHouse is down"))).toBe(
      true,
    );
  });

  it("logs ordinary requests as JSON", async () => {
    const { app, lines } = appWithLogs(async () => true);
    await app.inject({ method: "GET", url: "/v1/nothing" });
    expect(lines.filter((l) => l.msg === "request completed")).toHaveLength(1);
  });
});

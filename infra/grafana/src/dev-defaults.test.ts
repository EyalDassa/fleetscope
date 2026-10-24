import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LOCAL_GRAFANA_ADMIN_PASSWORD,
  LOCAL_GRAFANA_ADMIN_USER,
  LOCAL_GRAFANA_PASSWORD,
  LOCAL_GRAFANA_PORT,
  LOCAL_GRAFANA_USER,
} from "./dev-defaults";

/** The uncommented `NAME=value` lines of .env.example. */
function envExample(): Record<string, string> {
  const text = readFileSync(
    fileURLToPath(new URL("../../../.env.example", import.meta.url)),
    "utf8",
  );
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] && match[2] !== undefined) values[match[1]] = match[2].trim();
  }
  return values;
}

// dev-defaults.ts says it mirrors docker-compose and .env.example. This is what keeps it true.
describe("dev-defaults", () => {
  it("are the values documented in .env.example", () => {
    const env = envExample();
    expect(LOCAL_GRAFANA_USER).toBe(env.CLICKHOUSE_GRAFANA_USER);
    expect(LOCAL_GRAFANA_PASSWORD).toBe(env.CLICKHOUSE_GRAFANA_PASSWORD);
    expect(LOCAL_GRAFANA_ADMIN_PASSWORD).toBe(env.GRAFANA_ADMIN_PASSWORD);
    expect(LOCAL_GRAFANA_PORT).toBe(env.GRAFANA_PORT);
  });

  it("match the fallbacks in infra/docker-compose.yml", () => {
    const compose = readFileSync(
      fileURLToPath(new URL("../../docker-compose.yml", import.meta.url)),
      "utf8",
    );
    expect(compose).toContain(`GRAFANA_ADMIN_PASSWORD:-${LOCAL_GRAFANA_ADMIN_PASSWORD}`);
    expect(compose).toContain(`GRAFANA_PORT:-${LOCAL_GRAFANA_PORT}`);
    expect(compose).toContain(`GF_SECURITY_ADMIN_USER: ${LOCAL_GRAFANA_ADMIN_USER}`);
  });
});

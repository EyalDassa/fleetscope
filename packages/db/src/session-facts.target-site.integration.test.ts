import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type EventEnvelope, newEvent } from "@fleetscope/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "./client";
import { ensureGrafanaUser } from "./grafana-user";
import { insertEvents } from "./insert";
import {
  conditionalAll,
  createReaderClient,
  createTestDatabase,
  type TestDatabase,
  testPassword,
} from "./testing";

/**
 * The target and site filters of the README's `session-facts`, run as the read-only user the way
 * Grafana expands them (docs/adr/0007): "All" must not filter, a selection must, and a session of a
 * site that no variable lists must still be in "All".
 */

let db: TestDatabase;
let reader: ClickHouseClient;
const user = `fleetscope_site_test_${randomBytes(4).toString("hex")}`;
const password = testPassword();
const MIN = 60_000;
const T0 = Math.floor(Date.now() / MIN) * MIN - 20 * MIN;

const ctx = (session_id: string): EventEnvelope => ({
  session_id,
  source: "real",
  agent_id: "agent-site",
  engine: "chromium",
  provider: "local-docker",
});
const sessions: Array<[id: string, extra: object]> = [
  ["s-demo", {}],
  ["s-wiki", { target: "public", site: "wikipedia" }],
  ["s-mdn", { target: "public", site: "mdn" }],
  ["s-new", { target: "public", site: "some-new-site" }],
];

beforeAll(async () => {
  db = await createTestDatabase();
  const events = sessions.flatMap(([id, extra], i) => [
    newEvent(
      "session.started",
      ctx(id),
      {
        engine_version: "1",
        scenario: "s",
        region: "local",
        startup_ms: 1,
        connect_ms: 1,
        ...extra,
      },
      T0 + i * MIN,
    ),
    newEvent(
      "session.ended",
      ctx(id),
      { status: "success", reason: null, duration_ms: 1000 },
      T0 + i * MIN + 5000,
    ),
  ]);
  await insertEvents(db.client, events);
  await ensureGrafanaUser(db.client, {
    user,
    password,
    database: db.config.database,
  });
  reader = createReaderClient(db.config, user, password);
});
afterAll(async () => {
  await reader.close();
  await db.client.command({ query: `DROP USER IF EXISTS \`${user}\`` });
  await db.cleanup();
});

async function facts(selected: { target?: string[]; site?: string[] }) {
  const readme = (await readFile(new URL("../README.md", import.meta.url), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const block = /```sql name=session-facts\n([\s\S]*?)\n```/.exec(readme)?.[1] as string;
  const quote = (values: string[]) => values.map((v) => `'${v}'`).join(",");
  const dt = (ms: number) => `toDateTime(${Math.floor(ms / 1000)})`;
  const sql = conditionalAll(block, selected)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Grafana variable syntax, not a template
    .replaceAll("${engine:singlequote}", quote(["chromium"]))
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Grafana variable syntax, not a template
    .replaceAll("${source:singlequote}", quote(["real"]))
    .replaceAll("$__fromTime", dt(T0 - 5 * MIN))
    .replaceAll("$__toTime", dt(Date.now() + MIN));
  const result = await reader.query({
    query: `SELECT session_id, target, site FROM (${sql}) ORDER BY session_id`,
    format: "JSONEachRow",
  });
  return result.json<{ session_id: string; target: string; site: string }>();
}

describe("session-facts target and site filters", () => {
  it("All does not filter, and returns target and site per session (a site no list knows included)", async () => {
    expect(await facts({})).toEqual([
      { session_id: "s-demo", target: "demo", site: "demo-site" },
      { session_id: "s-mdn", target: "public", site: "mdn" },
      { session_id: "s-new", target: "public", site: "some-new-site" },
      { session_id: "s-wiki", target: "public", site: "wikipedia" },
    ]);
  });

  it("a target selection keeps only that target", async () => {
    expect((await facts({ target: ["demo"] })).map((r) => r.session_id)).toEqual(["s-demo"]);
    expect((await facts({ target: ["public"] })).map((r) => r.session_id)).toEqual([
      "s-mdn",
      "s-new",
      "s-wiki",
    ]);
  });

  it("a site selection keeps only those sites, and combines with target", async () => {
    expect((await facts({ site: ["wikipedia", "mdn"] })).map((r) => r.session_id)).toEqual([
      "s-mdn",
      "s-wiki",
    ]);
    expect(await facts({ target: ["demo"], site: ["wikipedia"] })).toEqual([]);
  });

  it("the README block uses conditionalAll for both variables and exposes target and site", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Grafana variable syntax, not a template
    expect(readme).toContain("$__conditionalAll(target IN (${target:singlequote}), $target)");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Grafana variable syntax, not a template
    expect(readme).toContain("$__conditionalAll(site IN (${site:singlequote}), $site)");
    expect(readme).toContain("p.target AS target");
    expect(readme).toContain("p.site AS site");
  });
});

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { newEvent } from "@fleetscope/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "./client";
import { ensureGrafanaUser } from "./grafana-user";
import { dedupTokensFor, insertEvents } from "./insert";
import { createReaderClient, createTestDatabase, type TestDatabase, testPassword } from "./testing";

/**
 * QA edge cases for the `capacity-load` snippet (qa/capacity-report.md): a backfill, an idle range,
 * and the two ends of the time range. Runs as the read-only Grafana user on the real `part_log`.
 */

let db: TestDatabase;
let reader: ClickHouseClient;
const user = `fleetscope_capqa_${randomBytes(4).toString("hex")}`;
const password = testPassword();
const MIN = 60_000;
const sec = (ms: number) => Math.floor(ms / 1000);

interface Row {
  time: string;
  rows_sent: string | number;
  rows_written: string | number;
  sessions_started: string | number;
}

async function load(from: number, to: number): Promise<Row[]> {
  const readme = (await readFile(new URL("../README.md", import.meta.url), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const match = readme.match(/```sql name=capacity-load\n([\s\S]*?)\n```/);
  expect(match, "capacity-load snippet").not.toBeNull();
  const sql = String(match?.[1])
    .replace(/\$__fromTime/g, `toDateTime(${sec(from)})`)
    .replace(/\$__toTime/g, `toDateTime(${sec(to)})`);
  const result = await reader.query({ query: sql, format: "JSONEachRow" });
  return (await result.json()) as Row[];
}

const startOfMinute = (ms: number) => Math.floor(ms / MIN) * MIN;
const total = (rows: Row[], key: "rows_sent" | "rows_written" | "sessions_started") =>
  rows.reduce((sum, row) => sum + Number(row[key]), 0);

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureGrafanaUser(db.client, { user, password, database: db.config.database });
  reader = createReaderClient(db.config, user, password);
});

afterAll(async () => {
  await reader.close();
  await db.client.command({ query: `DROP USER IF EXISTS \`${user}\`` });
  await db.cleanup();
});

describe("capacity-load, QA edge cases", () => {
  it("a backfill is sent in the old minutes and written in the current minute; idle minutes between are rows of zeros", async (task) => {
    const exists = await db.client.query({
      query:
        "SELECT count() AS n FROM system.tables WHERE database = 'system' AND name = 'part_log'",
      format: "JSONEachRow",
    });
    if (Number(((await exists.json()) as Array<{ n: string }>)[0]?.n) === 0) {
      return task.skip("system.part_log does not exist on this ClickHouse");
    }
    const now = Date.now();
    const old = startOfMinute(now - 3 * 60 * MIN) + 10_000; // 3 hours ago, ten seconds into a minute
    const ctx = {
      session_id: "qa-backfill",
      source: "sim" as const,
      agent_id: "qa",
      engine: "chromium" as const,
      provider: "local-docker",
    };
    const events = [
      newEvent(
        "session.started",
        ctx,
        { engine_version: null, scenario: "x", region: "local", startup_ms: 1, connect_ms: 1 },
        old,
      ),
      ...[0, 1, 2].map((seq) =>
        newEvent(
          "action",
          ctx,
          { seq, action_type: "goto", target: "x", duration_ms: 5, ok: true, error_code: null },
          old + 10 * seq,
        ),
      ),
      newEvent("issue", ctx, { kind: "blocked", message: "m" }, old + 5),
    ];
    await insertEvents(db.client, events, { dedupTokens: dedupTokensFor("qa-backfill") });
    await db.client.command({ query: "SYSTEM FLUSH LOGS part_log" });

    const rows = await load(old - 2 * MIN, now + 30_000);
    // 3 hours + 2 minutes + the current minute: every minute of the range has a row
    const first = startOfMinute(old - 2 * MIN);
    const last = startOfMinute(now + 30_000);
    expect(rows).toHaveLength((last - first) / MIN + 1);
    // 3 actions + 1 issue: sent in the old minute, nothing written there
    const oldMinute = rows.find(
      (r) => Date.parse(`${r.time.replace(" ", "T")}Z`) === startOfMinute(old),
    );
    expect(oldMinute && Number(oldMinute.rows_sent)).toBe(4);
    expect(oldMinute && Number(oldMinute.rows_written)).toBe(0);
    expect(total(rows, "rows_sent")).toBe(4);
    expect(total(rows, "rows_written")).toBe(4);
    expect(total(rows, "sessions_started")).toBe(1);
    // the writes landed in the minute of the insert, not in the minute of the event timestamps
    const writtenAt = rows.filter((r) => Number(r.rows_written) > 0).map((r) => r.time);
    expect(writtenAt).toHaveLength(1);
    // idle minutes are true zeros, not missing
    const idle = rows.filter((r) => Number(r.rows_sent) === 0 && Number(r.rows_written) === 0);
    expect(idle.length).toBe(rows.length - 2);
    expect(idle.every((r) => Number(r.sessions_started) === 0)).toBe(true);
  });

  it("a range that ends exactly on a minute boundary stops there, and from = to is the one minute", async () => {
    const edge = startOfMinute(Date.now()) - 10 * MIN;
    const rows = await load(edge - 3 * MIN, edge);
    expect(rows.map((r) => r.time)).toHaveLength(3);
    const one = await load(edge + 20_000, edge + 20_000);
    expect(one).toHaveLength(1);
    expect(total(one, "rows_sent") + total(one, "rows_written")).toBe(0);
  });
});

import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DashboardRunner,
  insertSpecs,
  MIN,
  num,
  type Range,
  type Row,
  type SessionSpec,
} from "../fixtures/dashboards";
import { spec } from "../fixtures/known-fleet";
import type { ClickHouseClient } from "./client";
import { ensureGrafanaUser } from "./grafana-user";
import { insertEvents } from "./insert";
import { createTestDatabase, type TestDatabase, testPassword } from "./testing";

/**
 * QA routing (ADR 0005): the routed-session numbers of the Browsers, Sessions and Session dashboards,
 * run as the read-only user on a fleet whose numbers were worked out by hand.
 *
 * All sessions run heavy-page-crawl and end inside the range unless said otherwise.
 *  id  source engine (ran)            routed_from  status                   counts in the stat?
 *  A1  real   chromium                lightpanda   success                  yes, routed
 *  A2  real   chrome-headless-shell   lightpanda   success                  yes, routed
 *  A3  real   chrome-headless-shell   lightpanda   failed                   yes, routed
 *  A4  real   lightpanda              (absent)     success                  yes
 *  A5  real   lightpanda              null         success                  yes
 *  A6  real   chromium                (absent)     success                  yes
 *  A7  real   chromium                lightpanda   interrupted              no: interrupted sessions are left out
 *  A8  real   chrome-headless-shell   lightpanda   running (never ended)    no: not ended; but listed on Sessions
 *  S1  sim    chromium                lightpanda   success                  only with source sim/all
 *
 * Hand counts for the stat (ended, not interrupted):
 *   real:        6 sessions, 3 routed (A1 A2 A3)        -> "3 · 50%"
 *   real + sim:  7 sessions, 4 routed (+ S1)            -> "4 · 57%"  (57.14 rounds to 57)
 *   lightpanda:  2 sessions (A4 A5), 0 routed           -> "0 · 0%"   (a real zero, not "no data")
 *   sim + lightpanda: nothing ran                        -> NULL       (not "0 · 0%")
 * Per-engine numbers count the engine that ran (never routed_from):
 *   chromium 2 (A1 A6), shell 2 (A2 A3), lightpanda 2 (A4 A5); success 100 / 50 / 100.
 */

let db: TestDatabase;
let admin: ClickHouseClient;
let dash: DashboardRunner;
const user = `fleetscope_qa_rt_${randomBytes(4).toString("hex")}`;
const password = testPassword();

const T0 = Math.floor((Date.now() - 120 * MIN) / (5 * MIN)) * (5 * MIN);
const m = (minutes: number) => T0 + minutes * MIN;
const RANGE: Range = { from: m(0), to: m(60) };

const CHROM = "chromium";
const SHELL = "chrome-headless-shell";
const PANDA = "lightpanda";

const run = (
  s: Partial<SessionSpec> & Pick<SessionSpec, "id" | "engine" | "status">,
  minute: number,
): SessionSpec =>
  spec({
    scenario: "heavy-page-crawl",
    startedAt: m(minute),
    durationMs: 60_000,
    startupMs: 1000,
    connectMs: 500,
    ...s,
  });

const fleet = (): SessionSpec[] => [
  run({ id: "A1", engine: CHROM, status: "success", routedFrom: PANDA }, 5),
  run({ id: "A2", engine: SHELL, status: "success", routedFrom: PANDA }, 6),
  run(
    {
      id: "A3",
      engine: SHELL,
      status: "failed",
      reason: "boom",
      routedFrom: PANDA,
      issue: "timeout",
    },
    7,
  ),
  run({ id: "A4", engine: PANDA, status: "success" }, 8),
  run({ id: "A5", engine: PANDA, status: "success", routedFrom: null, engineVersion: null }, 9),
  run({ id: "A6", engine: CHROM, status: "success" }, 10),
  run({ id: "A7", engine: CHROM, status: "failed", reason: "interrupted", routedFrom: PANDA }, 11),
  run({ id: "A8", engine: SHELL, status: "running", routedFrom: PANDA }, 12),
  run({ id: "S1", engine: CHROM, status: "success", routedFrom: PANDA, source: "sim" }, 13),
];

const REAL = { source: "real" as const };
const STAT = 'panel "Routed sessions ↗", query A';
const SESSIONS = 'panel "Sessions ↗", query A';
const COMPARISON = 'panel "Engine comparison ↗", query A';
const MATRIX = 'panel "Compatibility matrix: scenario × engine ↗", query A';
const SESSION_ENGINE = 'panel "Engine", query A';
const byKey = (rows: Row[], key: string) => new Map(rows.map((r) => [String(r[key]), r]));

beforeAll(async () => {
  db = await createTestDatabase();
  admin = db.client;
  await insertSpecs((events) => insertEvents(admin, events), fleet());
  await ensureGrafanaUser(admin, { user, password, database: db.config.database });
  dash = new DashboardRunner({ url: db.config.url, user, password, database: db.config.database });
});

afterAll(async () => {
  await admin.command({ query: `DROP USER IF EXISTS \`${user}\`` });
  await db.cleanup();
});

describe("Browsers: Routed sessions stat (hand-computed)", () => {
  it("real: 3 of 6 ended sessions, interrupted and running left out", async () => {
    const rows = await dash.run("browsers", STAT, RANGE, REAL);
    expect(rows).toEqual([{ routed: "3 · 50%" }]);
  });

  it("source All: the simulated routed session counts too", async () => {
    expect(await dash.run("browsers", STAT, RANGE)).toEqual([{ routed: "4 · 57%" }]);
  });

  it("engine filter applies to the engine that ran: lightpanda ran nothing routed -> a real 0", async () => {
    expect(await dash.run("browsers", STAT, RANGE, { ...REAL, engines: [PANDA] })).toEqual([
      { routed: "0 · 0%" },
    ]);
  });

  it("chromium only: 1 routed of 2 (A1; A7 is interrupted)", async () => {
    expect(await dash.run("browsers", STAT, RANGE, { ...REAL, engines: [CHROM] })).toEqual([
      { routed: "1 · 50%" },
    ]);
  });

  it("nothing ran -> NULL (the panel says so), never 0 percent", async () => {
    const rows = await dash.run("browsers", STAT, RANGE, { source: "sim", engines: [PANDA] });
    expect(rows).toEqual([{ routed: null }]);
  });

  it("a range with no ended session -> NULL", async () => {
    const before: Range = { from: m(-600), to: m(-540) };
    expect(await dash.run("browsers", STAT, before)).toEqual([{ routed: null }]);
  });
});

describe("Browsers: per-engine numbers count the engine that ran", () => {
  it("comparison: chromium 2, shell 2, lightpanda 2", async () => {
    const rows = byKey(await dash.run("browsers", COMPARISON, RANGE, REAL), "engine");
    expect(num(rows.get(CHROM)?.sessions)).toBe(2);
    expect(num(rows.get(SHELL)?.sessions)).toBe(2);
    expect(num(rows.get(PANDA)?.sessions)).toBe(2);
    expect(num(rows.get(CHROM)?.success_rate)).toBe(100);
    expect(num(rows.get(SHELL)?.success_rate)).toBe(50);
    expect(num(rows.get(PANDA)?.success_rate)).toBe(100);
  });

  it("matrix: heavy-page-crawl has a row for each engine that ran it, none invented", async () => {
    const rows = await dash.run("browsers", MATRIX, RANGE, REAL);
    expect(rows.map((r) => [r.scenario, r.engine, num(r.sessions)])).toEqual([
      ["heavy-page-crawl", SHELL, 2],
      ["heavy-page-crawl", CHROM, 2],
      ["heavy-page-crawl", PANDA, 2],
    ]);
  });
});

describe("Sessions: Routed from column and the routed variable", () => {
  it("All: every session of the range, routed_from NULL where not routed", async () => {
    const rows = byKey(await dash.run("sessions", SESSIONS, RANGE, REAL), "session_id");
    expect(rows.size).toBe(8);
    expect(rows.get("A1")?.routed_from).toBe(PANDA);
    expect(rows.get("A1")?.engine).toBe(CHROM);
    expect(rows.get("A4")?.routed_from).toBeNull();
    expect(rows.get("A5")?.routed_from).toBeNull();
    expect(rows.get("A6")?.routed_from).toBeNull();
  });

  it("Routed only: exactly the sessions with routed_from set, running and interrupted included", async () => {
    const rows = await dash.run("sessions", SESSIONS, RANGE, { ...REAL, routed: "routed" });
    expect(rows.map((r) => r.session_id).sort()).toEqual(["A1", "A2", "A3", "A7", "A8"]);
    for (const r of rows) expect(r.routed_from).toBe(PANDA);
  });

  it("Routed only follows the other filters (source sim, engine shell)", async () => {
    const sim = await dash.run("sessions", SESSIONS, RANGE, { source: "sim", routed: "routed" });
    expect(sim.map((r) => r.session_id)).toEqual(["S1"]);
    const shell = await dash.run("sessions", SESSIONS, RANGE, {
      ...REAL,
      engines: [SHELL],
      routed: "routed",
    });
    expect(shell.map((r) => r.session_id).sort()).toEqual(["A2", "A3", "A8"]);
  });

  it("the stat's routed count is the routed rows that ended and were not interrupted (3 = 5 - A7 - A8)", async () => {
    const listed = await dash.run("sessions", SESSIONS, RANGE, { ...REAL, routed: "routed" });
    const counted = listed.filter((r) => r.status !== "running" && r.status !== "interrupted");
    expect(counted).toHaveLength(3);
  });
});

describe("Session: the Engine stat", () => {
  const engineText = async (id: string) =>
    (await dash.run("session", SESSION_ENGINE, RANGE, { session: id })).map(
      (r) => r.engine_version,
    );

  it("a routed session says where it was routed from", async () => {
    expect(await engineText("A1")).toEqual(["chromium 1.0.0 (routed from lightpanda)"]);
  });

  it("a session that was not routed has no note", async () => {
    expect(await engineText("A6")).toEqual(["chromium 1.0.0"]);
    expect(await engineText("A4")).toEqual(["lightpanda 1.0.0"]);
  });

  it("routed_from null and a version that is not reported", async () => {
    expect(await engineText("A5")).toEqual(["lightpanda version not reported"]);
  });

  it("an unknown session id gives no row", async () => {
    expect(await engineText("nope")).toEqual([]);
  });
});

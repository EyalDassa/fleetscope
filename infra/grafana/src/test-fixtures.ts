// Builders for dashboard JSON used by the tests. Not shipped, not a test itself.
import { randomBytes } from "node:crypto";
import type { JsonObject } from "./json";

/**
 * A fresh random password for a test. Tests never write a password as a literal (secret scanners
 * flag those, and a literal that looks like a real one trains people to ignore the alerts). Call it
 * once per test file or per test and compare against the returned value. The local development
 * defaults live in dev-defaults.ts instead.
 */
export function testPassword(): string {
  return randomBytes(12).toString("base64url");
}

export const CH = { type: "grafana-clickhouse-datasource", uid: "fleetscope-clickhouse" };

// Grafana wants unique panel ids within a dashboard, and the check enforces it, so every panel the
// builders make gets its own id (a test can still pass `id` in `extra`).
let lastPanelId = 1000;
const nextPanelId = (): number => {
  lastPanelId += 1;
  return lastPanelId;
};

export function statPanel(title: string, rawSql: string, extra: JsonObject = {}): JsonObject {
  return {
    id: nextPanelId(),
    type: "stat",
    title,
    datasource: CH,
    targets: [{ refId: "A", rawSql, editorType: "sql", format: 1 }],
    fieldConfig: { defaults: { noValue: "0" }, overrides: [] },
    ...extra,
  };
}

/** A time series that follows every rule of DESIGN.md section 9. */
export function timeSeriesPanel(title: string, rawSql: string): JsonObject {
  const engine = (name: string, color: string): JsonObject => ({
    matcher: { id: "byRegexp", options: `/${name}/` },
    properties: [{ id: "color", value: { mode: "fixed", fixedColor: color } }],
  });
  return {
    id: nextPanelId(),
    type: "timeseries",
    title,
    datasource: CH,
    targets: [{ refId: "A", rawSql, editorType: "sql", format: 0 }],
    fieldConfig: {
      defaults: {
        color: { mode: "fixed", fixedColor: "#9AA9BB" },
        custom: { spanNulls: false },
        noValue: "No data in range",
      },
      overrides: [
        engine("chromium", "#56B4E9"),
        engine("chrome-headless-shell", "#E69F00"),
        engine("lightpanda", "#CC79A7"),
      ],
    },
  };
}

export const DASHBOARD_DS = { type: "datasource", uid: "-- Dashboard --" };

/** A stat that shows one field of another panel's query (Grafana's Dashboard data source). */
export function readerPanel(
  id: number,
  title: string,
  sourcePanelId: number,
  fields: string,
  extra: JsonObject = {},
): JsonObject {
  return {
    id,
    type: "stat",
    title,
    datasource: DASHBOARD_DS,
    targets: [{ datasource: DASHBOARD_DS, panelId: sourcePanelId, refId: "A" }],
    options: { reduceOptions: { fields, calcs: ["lastNotNull"] } },
    fieldConfig: { defaults: { noValue: "0" }, overrides: [] },
    ...extra,
  };
}

export function dashboardJson(overrides: JsonObject = {}): JsonObject {
  return {
    id: null,
    uid: "test-dashboard",
    title: "Test dashboard",
    schemaVersion: 39,
    time: { from: "now-1h", to: "now" },
    templating: { list: [] },
    annotations: { list: [] },
    panels: [],
    ...overrides,
  };
}

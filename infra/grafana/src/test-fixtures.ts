// Builders for dashboard JSON used by the tests. Not shipped, not a test itself.
import type { JsonObject } from "./json";

export const CH = { type: "grafana-clickhouse-datasource", uid: "fleetscope-clickhouse" };

export function statPanel(title: string, rawSql: string, extra: JsonObject = {}): JsonObject {
  return {
    id: 1,
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
  const engine = (name: string, color: string, fill: string): JsonObject => ({
    matcher: { id: "byRegexp", options: `/${name}/` },
    properties: [
      { id: "color", value: { mode: "fixed", fixedColor: color } },
      { id: "custom.lineStyle", value: { fill } },
    ],
  });
  return {
    id: 2,
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
        engine("chromium", "#56B4E9", "solid"),
        engine("chrome-headless-shell", "#E69F00", "dash"),
        engine("lightpanda", "#CC79A7", "dot"),
      ],
    },
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

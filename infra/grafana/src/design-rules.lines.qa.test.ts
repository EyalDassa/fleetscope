import { describe, expect, it } from "vitest";
import { designProblems } from "./design-rules";
import type { JsonObject } from "./json";
import { dashboardJson, timeSeriesPanel } from "./test-fixtures";

/**
 * QA routing: holes in "every time series line is solid" (DESIGN.md section 2) that
 * `pnpm grafana:check` lets through. Open bugs are `it.fails`: they pass while the hole exists and
 * start failing when it is closed, so QA flips them to plain `it` in the re-test.
 */

const messages = (ts: JsonObject): string[] =>
  designProblems(dashboardJson({ panels: [ts] })).map((p) => p.message);

const withThresholdsStyle = (mode: string): JsonObject => {
  const ts = timeSeriesPanel("TS", "SELECT 1");
  const defaults = (ts.fieldConfig as JsonObject).defaults as JsonObject;
  (defaults.custom as JsonObject).thresholdsStyle = { mode };
  return ts;
};

describe("QA-RT-04: threshold lines on a time series are lines too", () => {
  it("accepts thresholds drawn as an area or not at all", () => {
    expect(messages(withThresholdsStyle("off"))).toEqual([]);
    expect(messages(withThresholdsStyle("area"))).toEqual([]);
  });

  it.fails.each(["dashed", "dashed+area"])(
    "rejects thresholdsStyle %s (it draws dashed threshold lines)",
    (mode) => {
      expect(messages(withThresholdsStyle(mode)).length).toBeGreaterThan(0);
    },
  );
});

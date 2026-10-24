import { describe, expect, it } from "vitest";
import { designProblems } from "./design-rules";
import type { JsonObject } from "./json";
import { dashboardJson, timeSeriesPanel } from "./test-fixtures";

/**
 * QA routing: holes in "every time series line is solid" (DESIGN.md section 2) that
 * `pnpm grafana:check` used to let through. QA-RT-03/04 (dashed threshold lines) is closed: the
 * `it.fails` of the QA run are plain `it` now.
 */

const messages = (ts: JsonObject): string[] =>
  designProblems(dashboardJson({ panels: [ts] })).map((p) => p.message);

const withThresholdsStyle = (mode: string): JsonObject => {
  const ts = timeSeriesPanel("TS", "SELECT 1");
  const defaults = (ts.fieldConfig as JsonObject).defaults as JsonObject;
  (defaults.custom as JsonObject).thresholdsStyle = { mode };
  return ts;
};

const withOverrideThresholdsStyle = (mode: string): JsonObject => {
  const ts = timeSeriesPanel("TS", "SELECT 1");
  const overrides = (ts.fieldConfig as JsonObject).overrides as JsonObject[];
  const first = overrides[0] as JsonObject;
  (first.properties as JsonObject[]).push({
    id: "custom.thresholdsStyle",
    value: { mode },
  });
  return ts;
};

describe("QA-RT-04: threshold lines on a time series are lines too", () => {
  it.each(["off", "line", "area", "line+area"])("accepts thresholdsStyle %s", (mode) => {
    expect(messages(withThresholdsStyle(mode))).toEqual([]);
    expect(messages(withOverrideThresholdsStyle(mode))).toEqual([]);
  });

  it("accepts a time series without thresholdsStyle or without a mode", () => {
    expect(messages(timeSeriesPanel("TS", "SELECT 1"))).toEqual([]);
    const ts = timeSeriesPanel("TS", "SELECT 1");
    const defaults = (ts.fieldConfig as JsonObject).defaults as JsonObject;
    (defaults.custom as JsonObject).thresholdsStyle = {};
    expect(messages(ts)).toEqual([]);
  });

  it.each(["dashed", "dashed+area"])(
    "rejects thresholdsStyle %s (it draws dashed threshold lines)",
    (mode) => {
      expect(messages(withThresholdsStyle(mode)).length).toBeGreaterThan(0);
    },
  );

  it("names the source and the mode, in the defaults and in an override", () => {
    expect(messages(withThresholdsStyle("dashed")).join("\n")).toContain(
      'the field defaults sets custom.thresholdsStyle.mode "dashed"',
    );
    expect(messages(withOverrideThresholdsStyle("dashed+area")).join("\n")).toContain(
      'override /chromium/ sets custom.thresholdsStyle.mode "dashed+area"',
    );
  });

  it("rejects a mode Grafana does not know", () => {
    expect(messages(withThresholdsStyle("dotted")).length).toBe(1);
  });
});

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectPanels, loadDashboardFiles } from "./dashboards";
import { asArray, asString, isObject, type JsonObject } from "./json";

/**
 * QA M2 round 2 (QA-M2-18): found by rendering the dashboards in Grafana 13.2.4, not by any SQL check.
 *
 * A stat that maps NaN to a text ("Not available", "running") never shows that text when its reducer is
 * `lastNotNull`: the reducer skips the NaN, the stat has no value, and it prints its "No value" text
 * instead. A `null` mapping does work with `lastNotNull` (the Overview's Estimated cost prints "Not
 * available" for a NULL). The ClickHouse plugin sends NaN as a NaN, and NULL as a null.
 */

const dir = fileURLToPath(new URL("../dashboards", import.meta.url));

interface Stat {
  dashboard: string;
  title: string;
  calcs: string[];
  noValue: string | undefined;
  nanText: string | undefined;
  nullText: string | undefined;
}

const stats: Stat[] = [];
for (const file of loadDashboardFiles(dir)) {
  if (!file.json) continue;
  for (const { panel, title } of collectPanels(file.json)) {
    if (panel.type !== "stat") continue;
    const fieldConfig = isObject(panel.fieldConfig) ? panel.fieldConfig : {};
    const defaults = isObject(fieldConfig.defaults) ? fieldConfig.defaults : {};
    const text = (match: string): string | undefined => {
      for (const mapping of asArray(defaults.mappings).filter(isObject)) {
        if (mapping.type !== "special" || !isObject(mapping.options)) continue;
        if (mapping.options.match !== match) continue;
        const result = mapping.options.result;
        return isObject(result) ? asString(result.text) : undefined;
      }
      return undefined;
    };
    const nanText = text("nan");
    const nullText = text("null");
    if (nanText === undefined && nullText === undefined) continue;
    const options: JsonObject = isObject(panel.options) ? panel.options : {};
    const reduce = isObject(options.reduceOptions) ? options.reduceOptions : {};
    stats.push({
      dashboard: file.file,
      title,
      calcs: asArray(reduce.calcs).map(String),
      noValue: asString(defaults.noValue),
      nanText,
      nullText,
    });
  }
}

describe("stats with a null or NaN mapping", () => {
  it("there are some to check", () => {
    expect(stats.length).toBeGreaterThanOrEqual(9);
  });

  it("the five Session detail stats that map NaN are the ones fixed: they reduce with last", () => {
    const session = stats.filter((s) => s.dashboard.includes("-session.json") && s.nanText);
    expect(session.map((s) => s.title).sort()).toEqual(
      ["Duration", "Est. cost", "Peak CPU", "Peak JS heap", "Peak memory"].sort(),
    );
    for (const stat of session) expect(stat.calcs, stat.title).toEqual(["last"]);
  });

  // QA-M2-18 (fixed in round 2): Session detail's Duration ("running"), Peak CPU, Peak memory, Peak JS
  // heap and Est. cost ("Not available") map only NaN, and their No value text is "—" (an unknown
  // session). With the reducer lastNotNull the NaN was skipped, so a session that exists but has no
  // sample, no end or no price showed "—". The reducer is `last` now. The five panels were also
  // re-rendered in a real Grafana 13.2.4 (see qa/m2-report.md).
  it("a stat that maps NaN to a text can reach the mapping (reducer last, or a null mapping too)", () => {
    for (const stat of stats) {
      if (stat.nanText === undefined || stat.nanText === stat.noValue) continue;
      const reachable =
        stat.nullText === stat.nanText || stat.calcs.every((c) => !/NotNull/.test(c));
      expect(
        reachable,
        `${stat.dashboard}: "${stat.title}" maps NaN to "${stat.nanText}" but reduces with ${stat.calcs.join(",")} and shows "${stat.noValue}"`,
      ).toBe(true);
    }
  });
});

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectPanels, loadDashboardFiles } from "./dashboards";
import { asArray, asString, isObject, type JsonObject } from "./json";

/**
 * QA site-engine-grid: the "Real sites x engines" table on Fleetscope / Browsers. Static checks of the
 * thresholds (mappings), the empty cell and the links. What Grafana really renders and resolves is
 * checked by qa/scripts/site-engine-grid-click.mjs (see qa/site-engine-grid-report.md, QA-SEG-01).
 */

const dir = fileURLToPath(new URL("../dashboards", import.meta.url));
const browsers = loadDashboardFiles(dir).find((f) => f.file.includes("fleetscope-browsers"))
  ?.json as JsonObject;
const panel = collectPanels(browsers).find((p) => p.title.startsWith("Real sites"))
  ?.panel as JsonObject;
const fieldConfig = panel.fieldConfig as JsonObject;
const defaults = fieldConfig.defaults as JsonObject;
const mappings = asArray(defaults.mappings).filter(isObject);

/** The text and colour Grafana picks for a label: the first mapping whose regex matches. */
function colourOf(label: string): string | undefined {
  for (const m of mappings) {
    if (m.type !== "regex" || !isObject(m.options)) continue;
    if (new RegExp(asString(m.options.pattern) as string).test(label)) {
      return asString((m.options.result as JsonObject).color);
    }
  }
  return undefined;
}
const GREEN = "#6EE7A8";
const AMBER = "#FFD95A";
const RED = "#FF7B7B";
/** The label the SQL builds: rate rounded DOWN, whole percent. */
const label = (rate: number) => `${Math.floor(rate)}% · n=12 · site_layout`;

describe("Real sites x engines: thresholds", () => {
  it("95 and above is green, 90 to below 95 amber, below 90 red, for every whole percent", () => {
    for (let pct = 0; pct <= 100; pct++) {
      const expected = pct >= 95 ? GREEN : pct >= 90 ? AMBER : RED;
      expect(colourOf(`${pct}% · n=3`), `${pct}%`).toBe(expected);
      expect(colourOf(`${pct}% · n=3 · timeout`), `${pct}% with cause`).toBe(expected);
    }
  });

  it("94.9 reads 94% and is amber, 89.9 reads 89% and is red, 95 is green, 90 is amber", () => {
    expect(label(94.9)).toMatch(/^94%/);
    expect(colourOf(label(94.9))).toBe(AMBER);
    expect(colourOf(label(89.9))).toBe(RED);
    expect(colourOf(label(95))).toBe(GREEN);
    expect(colourOf(label(90))).toBe(AMBER);
    expect(colourOf(label(99.99))).toBe(GREEN); // 99.99 reads 99%
  });

  it("the dash label has no colour of its own and a missing pair maps to a dash, never 0%", () => {
    expect(colourOf("—")).toBeUndefined();
    const special = (match: string) =>
      mappings.find((m) => m.type === "special" && (m.options as JsonObject).match === match);
    for (const match of ["null", "nan"]) {
      const result = (special(match)?.options as JsonObject | undefined)?.result as JsonObject;
      expect(asString(result?.text), match).toBe("—");
    }
    const matrix = asArray(panel.transformations)
      .filter(isObject)
      .find((t) => t.id === "groupingToMatrix")?.options as JsonObject;
    expect(matrix.emptyValue).toBe("null");
    expect(matrix.rowField).toBe("site");
    expect(matrix.columnField).toBe("engine");
  });

  it("the rate in the SQL is floored and the lookup colours text, not the cell background", () => {
    const sql = asString(
      (asArray(panel.targets).filter(isObject)[0] as JsonObject).rawSql,
    ) as string;
    expect(sql).toContain("toUInt8(floor(success_rate))");
    expect(sql).not.toMatch(/round\(/i);
  });
});

describe("Real sites x engines: links", () => {
  const overrides = asArray(fieldConfig.overrides).filter(isObject);
  const urlOf = (engine: string): string => {
    const o = overrides.find((x) => (x.matcher as JsonObject).options === engine);
    const links = asArray(
      asArray(o?.properties)
        .filter(isObject)
        .find((p) => p.id === "links")?.value,
    ).filter(isObject);
    expect(links, engine).toHaveLength(1);
    return asString(links[0]?.url) as string;
  };
  const count = (url: string, name: string) =>
    url.split(/[?&]/).filter((p) => p.startsWith(`${name}=`)).length;

  it("each engine column links to Sessions with exactly one site, engine and target, and keeps range and source", () => {
    for (const engine of ["chromium", "chrome-headless-shell", "lightpanda"]) {
      const url = urlOf(engine);
      expect(url.startsWith("/d/fleetscope-sessions?"), engine).toBe(true);
      for (const v of ["var-site", "var-engine", "var-target"]) {
        expect(count(url, v), `${engine} ${v}`).toBe(1);
      }
      expect(count(url, "var-source"), engine).toBe(0); // it comes from ${source:queryparam}
      expect(url).toContain("${__url_time_range}");
      expect(url).toContain("${source:queryparam}");
      expect(url).toContain("var-target=public");
      expect(url).toContain(`var-engine=${engine}`);
      expect(url).not.toContain("${engine:queryparam}");
    }
  });

  it("the site column links with the engine filter and no fixed engine", () => {
    const o = overrides.find((x) => (x.matcher as JsonObject).options === "site");
    const url = asString(
      (
        asArray(
          asArray(o?.properties)
            .filter(isObject)
            .find((p) => p.id === "links")?.value,
        )[0] as JsonObject
      ).url,
    ) as string;
    expect(count(url, "var-site")).toBe(1);
    expect(count(url, "var-target")).toBe(1);
    expect(url).not.toMatch(/var-engine=\w/); // only the :queryparam expansion
  });
});

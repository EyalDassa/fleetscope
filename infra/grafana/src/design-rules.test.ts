import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { designProblems, sqlRuleProblems, zeroDefaults } from "./design-rules";
import type { JsonObject } from "./json";
import { ALLOWED_COLORS } from "./palette";
import { dashboardJson, statPanel, timeSeriesPanel } from "./test-fixtures";

describe("palette", () => {
  // design/DESIGN.md section 2 is the source of truth. If someone adds a Dark colour there and
  // forgets palette.ts, the dashboards that use it would be rejected: catch that here.
  it("contains every Dark colour of the tables in DESIGN.md section 2", () => {
    const spec = readFileSync(
      fileURLToPath(new URL("../../../design/DESIGN.md", import.meta.url)),
      "utf8",
    );
    const section = spec.slice(spec.indexOf("## 2. Colours"), spec.indexOf("## 3."));
    // Each table has a header cell that starts with "Dark"; the colours are in that column.
    const darkCells: string[] = [];
    let darkColumn = -1;
    for (const line of section.split("\n")) {
      if (!line.startsWith("|")) {
        darkColumn = -1;
        continue;
      }
      const cells = line.split("|").map((cell) => cell.trim().replace(/`/g, ""));
      const header = cells.findIndex((cell) => cell.startsWith("Dark"));
      if (header !== -1) darkColumn = header;
      else if (darkColumn !== -1 && /^#[0-9A-Fa-f]{6}$/.test(cells[darkColumn] ?? "")) {
        darkCells.push(cells[darkColumn] as string);
      }
    }
    expect(darkCells.length).toBeGreaterThanOrEqual(9); // 3 engines + 6 statuses
    for (const color of darkCells) expect(ALLOWED_COLORS.has(color.toLowerCase())).toBe(true);
  });
});

describe("designProblems: colours", () => {
  const messages = (dashboard: JsonObject): string[] =>
    designProblems(dashboard).map((p) => `${p.where}: ${p.message}`);

  it("accepts the Dark palette, text and transparent", () => {
    const panel = statPanel("P", "SELECT 1", {
      fieldConfig: {
        defaults: {
          noValue: "0",
          thresholds: {
            steps: [
              { color: "text", value: null },
              { color: "#ff7b7b", value: 1 },
              { color: "transparent", value: 2 },
            ],
          },
        },
      },
    });
    expect(messages(dashboardJson({ panels: [panel] }))).toEqual([]);
  });

  it("rejects a hex colour outside the palette, wherever it is", () => {
    const panel = statPanel("P", "SELECT 1", {
      fieldConfig: { defaults: { noValue: "0", color: { mode: "fixed", fixedColor: "#123456" } } },
    });
    const found = messages(dashboardJson({ panels: [panel] }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/#123456.*not in the Dark palette/);
  });

  it("rejects named colours except text and transparent", () => {
    const panel = statPanel("P", "SELECT 1", {
      fieldConfig: {
        defaults: { noValue: "0", thresholds: { steps: [{ color: "green", value: null }] } },
      },
    });
    expect(messages(dashboardJson({ panels: [panel] }))[0]).toMatch(/"green" is a named colour/);
  });

  it("does not mistake colour modes for colours", () => {
    const panel = statPanel("P", "SELECT 1", {
      fieldConfig: { defaults: { noValue: "0", color: { mode: "thresholds" } } },
    });
    expect(messages(dashboardJson({ panels: [panel] }))).toEqual([]);
  });
});

describe("designProblems: panels", () => {
  it("wants noValue on stats and tables", () => {
    const stat = statPanel("S", "SELECT 1", { fieldConfig: { defaults: {}, overrides: [] } });
    const table = {
      ...statPanel("T", "SELECT 1"),
      type: "table",
      fieldConfig: { defaults: { noValue: "" } },
    };
    const problems = designProblems(dashboardJson({ panels: [stat, table] }));
    expect(problems.map((p) => p.where)).toEqual(['panel "S"', 'panel "T"']);
    expect(problems[0]?.message).toMatch(/noValue/);
  });

  it("accepts a time series that follows the spec", () => {
    expect(designProblems(dashboardJson({ panels: [timeSeriesPanel("TS", "SELECT 1")] }))).toEqual(
      [],
    );
  });

  it("wants spanNulls false, a fixed default colour and the three engine overrides", () => {
    const ts = timeSeriesPanel("TS", "SELECT 1");
    ts.fieldConfig = {
      defaults: { custom: { spanNulls: true }, color: { mode: "palette-classic" } },
      overrides: [],
    };
    const text = designProblems(dashboardJson({ panels: [ts] }))
      .map((p) => p.message)
      .join("\n");
    expect(text).toMatch(/spanNulls/);
    expect(text).toMatch(/default field colour/);
    expect(text).toMatch(/\/chromium\//);
    expect(text).toMatch(/\/chrome-headless-shell\//);
    expect(text).toMatch(/\/lightpanda\//);
  });

  it("checks the colour inside an engine override", () => {
    const ts = timeSeriesPanel("TS", "SELECT 1");
    const overrides = (ts.fieldConfig as JsonObject).overrides as JsonObject[];
    (overrides[0] as JsonObject).properties = [
      { id: "color", value: { mode: "fixed", fixedColor: "#000000" } },
    ];
    const text = designProblems(dashboardJson({ panels: [ts] })).map((p) => p.message);
    expect(text.some((m) => m.includes("override /chromium/ must set the colour"))).toBe(true);
  });

  describe("every line is solid", () => {
    const withStyle = (place: "override" | "defaults", fill: string): JsonObject => {
      const ts = timeSeriesPanel("TS", "SELECT 1");
      const config = ts.fieldConfig as JsonObject;
      if (place === "defaults") {
        (config.defaults as JsonObject).custom = { spanNulls: false, lineStyle: { fill } };
      } else {
        const first = (config.overrides as JsonObject[])[0] as JsonObject;
        (first.properties as JsonObject[]).push({ id: "custom.lineStyle", value: { fill } });
      }
      return ts;
    };
    const messages = (ts: JsonObject): string[] =>
      designProblems(dashboardJson({ panels: [ts] })).map((p) => p.message);

    it("accepts an explicit solid line style, in an override or in the defaults", () => {
      expect(messages(withStyle("override", "solid"))).toEqual([]);
      expect(messages(withStyle("defaults", "solid"))).toEqual([]);
    });

    it("rejects dash and dot in an engine override", () => {
      for (const fill of ["dash", "dot"]) {
        const text = messages(withStyle("override", fill)).join("\n");
        expect(text, fill).toContain(`custom.lineStyle with fill "${fill}"`);
        expect(text, fill).toContain("override /chromium/");
      }
    });

    it("rejects dash and dot in the field defaults", () => {
      for (const fill of ["dash", "dot"]) {
        const text = messages(withStyle("defaults", fill)).join("\n");
        expect(text, fill).toContain(
          `the field defaults sets custom.lineStyle with fill "${fill}"`,
        );
      }
    });

    it("rejects a dash in an override that is not an engine one", () => {
      const ts = timeSeriesPanel("TS", "SELECT 1");
      ((ts.fieldConfig as JsonObject).overrides as JsonObject[]).push({
        matcher: { id: "byName", options: "other" },
        properties: [{ id: "custom.lineStyle", value: { fill: "dash", dash: [10, 10] } }],
      });
      expect(messages(ts).join("\n")).toMatch(
        /override other sets custom.lineStyle with fill "dash"/,
      );
    });
  });

  it("rejects two series overrides with the same colour", () => {
    const ts = timeSeriesPanel("TS", "SELECT 1");
    const overrides = (ts.fieldConfig as JsonObject).overrides as JsonObject[];
    (overrides[2] as JsonObject).properties = [
      { id: "color", value: { mode: "fixed", fixedColor: "#e69f00" } }, // same as /chrome-headless-shell/, other case
    ];
    const text = designProblems(dashboardJson({ panels: [ts] })).map((p) => p.message);
    expect(text.some((m) => m.includes("override") || m.includes("both use the colour"))).toBe(
      true,
    );
    expect(text.join("\n")).toMatch(
      /\/chrome-headless-shell\/ and \/lightpanda\/ both use the colour #e69f00/,
    );
  });
});

describe("zeroDefaults", () => {
  it("finds ifNull and coalesce with a 0 default", () => {
    expect(zeroDefaults("SELECT ifNull(x, 0) FROM t")).toEqual(["ifNull(x, 0)"]);
    expect(zeroDefaults("SELECT COALESCE(sum(a), 0.0)")).toEqual(["COALESCE(sum(a), 0.0)"]);
    expect(zeroDefaults("SELECT coalesce(a, b, 0)")).toHaveLength(1);
    expect(zeroDefaults("SELECT ifNull(x, toUInt64(0))")).toHaveLength(1);
    expect(zeroDefaults("SELECT ifNull(f(x, y),\n  0)")).toHaveLength(1);
  });

  it("allows other defaults, the first argument being 0, and mentions in strings or comments", () => {
    expect(zeroDefaults("SELECT ifNull(x, 'unknown')")).toEqual([]);
    expect(zeroDefaults("SELECT coalesce(duration_ms, dateDiff('ms', a, b))")).toEqual([]);
    expect(zeroDefaults("SELECT ifNull(0, x)")).toEqual([]);
    expect(zeroDefaults("SELECT 'ifNull(x, 0)' AS s")).toEqual([]);
    expect(zeroDefaults("SELECT 1 -- ifNull(x, 0)")).toEqual([]);
    expect(zeroDefaults("SELECT ifNull(x, 10)")).toEqual([]);
  });

  it("explains the problem for a query", () => {
    const [problem] = sqlRuleProblems("SELECT ifNull(x, 0)", 'panel "P", query A');
    expect(problem?.where).toBe('panel "P", query A');
    expect(problem?.message).toMatch(/turns a missing value into 0/);
  });
});

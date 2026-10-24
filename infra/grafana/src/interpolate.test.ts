import { describe, expect, it } from "vitest";
import {
  applyConditionalAll,
  formatVariable,
  InterpolationError,
  interpolate,
  replaceVariables,
  type VariableState,
} from "./interpolate";

const ctx = {
  from: new Date(Date.UTC(2024, 0, 1, 0, 0, 0)),
  to: new Date(Date.UTC(2024, 0, 1, 1, 0, 0)),
  intervalMs: 60_000,
};

function state(partial: Partial<VariableState> & { name: string }): VariableState {
  return { multi: false, all: false, allValue: undefined, selected: [], options: [], ...partial };
}

const engine = state({
  name: "engine",
  multi: true,
  options: ["chromium", "lightpanda"],
  selected: ["chromium"],
});
const engineAll = state({ ...engine, all: true, selected: [] });
const source = state({ name: "source", options: ["real", "sim"], selected: ["real"] });

describe("formatVariable", () => {
  it("writes a multi-value variable as a quoted list by default", () => {
    expect(formatVariable(engine, undefined)).toBe("'chromium'");
    expect(formatVariable(engineAll, undefined)).toBe("'chromium','lightpanda'");
  });

  it("writes a single-value variable as it is", () => {
    expect(formatVariable(source, undefined)).toBe("real");
  });

  it("knows the named formats", () => {
    expect(formatVariable(engineAll, "singlequote")).toBe("'chromium','lightpanda'");
    expect(formatVariable(engineAll, "csv")).toBe("chromium,lightpanda");
    expect(formatVariable(engineAll, "pipe")).toBe("chromium|lightpanda");
    expect(formatVariable(engineAll, "doublequote")).toBe('"chromium","lightpanda"');
    expect(formatVariable(state({ name: "x", selected: ["it's"] }), "sqlstring")).toBe("'it''s'");
    expect(formatVariable(state({ name: "x", selected: ["it's"] }), "singlequote")).toBe(
      "'it\\'s'",
    );
    expect(formatVariable(source, "singlequote")).toBe("'real'");
  });

  it("uses a custom All value untouched", () => {
    const all = state({ ...engineAll, allValue: ".*" });
    expect(formatVariable(all, undefined)).toBe(".*");
    expect(formatVariable(all, "singlequote")).toBe("'.*'");
  });

  it("rejects formats it cannot reproduce", () => {
    expect(() => formatVariable(source, "lucene")).toThrow(InterpolationError);
  });
});

describe("applyConditionalAll", () => {
  const sql = "WHERE $__conditionalAll(engine IN ($engine), $engine) AND x";

  it("keeps the condition when something is selected", () => {
    expect(applyConditionalAll(sql, new Map([["engine", engine]]))).toBe(
      "WHERE engine IN ($engine) AND x",
    );
  });

  it("becomes 1=1 for All", () => {
    expect(applyConditionalAll(sql, new Map([["engine", engineAll]]))).toBe("WHERE 1=1 AND x");
  });

  it("accepts the ${var} form and several uses", () => {
    const twice =
      "$__conditionalAll(a = 1, ${engine}) AND $__conditionalAll(b IN (${source}), $source)";
    const variables = new Map([
      ["engine", engineAll],
      ["source", source],
    ]);
    expect(applyConditionalAll(twice, variables)).toBe("1=1 AND b IN (${source})");
  });

  it("needs two arguments", () => {
    expect(() => applyConditionalAll("$__conditionalAll(a)", new Map())).toThrow(/2 arguments/);
  });
});

describe("replaceVariables", () => {
  const variables = new Map([
    ["engine", engine],
    ["source", source],
  ]);

  it("replaces $var, ${var}, ${var:fmt} and [[var]]", () => {
    expect(
      replaceVariables("a $source b ${source} c ${engine:csv} d [[source]]", variables, new Map()),
    ).toBe("a real b real c chromium d real");
  });

  it("leaves unknown names, and macros, in place", () => {
    expect(replaceVariables("$nope ${nope} $__timeFilter(x)", variables, new Map())).toBe(
      "$nope ${nope} $__timeFilter(x)",
    );
  });

  it("replaces built-ins", () => {
    const builtins = new Map([
      ["__from", "1"],
      ["__interval", "1m"],
    ]);
    expect(replaceVariables("$__from-$__interval", variables, builtins)).toBe("1-1m");
  });
});

describe("interpolate", () => {
  const variables = new Map([
    ["engine", engineAll],
    ["source", source],
  ]);
  const builtins = new Map([["__interval", "1m"]]);

  it("runs the three steps in the plugin's order", () => {
    const sql =
      "SELECT 1 FROM t WHERE $__timeFilter(ts) AND $__conditionalAll(engine IN (${engine:singlequote}), $engine) AND source = '$source'";
    expect(interpolate({ sql, variables, builtins, macros: ctx })).toBe(
      "SELECT 1 FROM t WHERE ts >= toDateTime(1704067200) AND ts <= toDateTime(1704070800) AND 1=1 AND source = 'real'",
    );
  });

  it("reports a variable the dashboard does not have", () => {
    expect(() => interpolate({ sql: "SELECT $nothing", variables, builtins, macros: ctx })).toThrow(
      /"\$nothing" is neither a variable/,
    );
  });

  it("reports an unknown macro", () => {
    expect(() =>
      interpolate({ sql: "SELECT $__nonsense(1)", variables, builtins, macros: ctx }),
    ).toThrow(/\$__nonsense/);
  });

  it("does not mind a dollar sign inside a string or a comment", () => {
    const sql = "SELECT match(x, '^a$') -- costs $5\n";
    expect(interpolate({ sql, variables, builtins, macros: ctx })).toContain("'^a$'");
  });

  it("turns macro errors into InterpolationError", () => {
    expect(() =>
      interpolate({ sql: "SELECT $__timeFilter()", variables, builtins, macros: ctx }),
    ).toThrow(InterpolationError);
  });
});

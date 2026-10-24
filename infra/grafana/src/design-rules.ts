// The "Dashboard JSON" checks of design/DESIGN.md section 9, kept apart from the structural rules
// in dashboards.ts: they come from the design spec, not from how Grafana works.
//   - every colour is a Dark hex from section 2 (or `text` / `transparent`)
//   - every stat and table sets `noValue`
//   - every time series has `spanNulls: false`, the three engine overrides and a fixed default colour,
//     only solid lines (no `custom.lineStyle` dash or dot) and no two overrides with the same colour
//   - no rawSql uses ifNull(x, 0) or coalesce(x, 0) (a missing value must not turn into a 0)
import { collectPanels, type Problem } from "./dashboards";
import { asArray, asString, isObject, type JsonObject } from "./json";
import { ALLOWED_COLOR_NAMES, ALLOWED_COLORS, ENGINES, FIELD_DEFAULT_COLOR } from "./palette";
import { codeOnly, findClosingParen, splitArgs, stripComments } from "./sql-text";

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const COLOR_KEYS = new Set(["color", "fixedColor", "iconColor"]);

/** Every hex colour, and every string under a colour key, anywhere in the dashboard. */
function colorProblems(dashboard: JsonObject): Problem[] {
  const problems: Problem[] = [];
  const reported = new Set<string>();
  const report = (path: string, value: string, why: string): void => {
    const key = `${value}|${why}`;
    if (reported.has(key)) return;
    reported.add(key);
    problems.push({ where: `colour at ${path || "dashboard"}`, message: `"${value}" ${why}` });
  };
  const walk = (value: unknown, path: string, key: string): void => {
    if (typeof value === "string") {
      if (HEX_COLOR.test(value)) {
        if (!ALLOWED_COLORS.has(value.toLowerCase())) {
          report(path, value, "is not in the Dark palette of DESIGN.md section 2");
        }
      } else if (COLOR_KEYS.has(key) && !ALLOWED_COLOR_NAMES.has(value)) {
        report(
          path,
          value,
          'is a named colour. Use a hex value from DESIGN.md section 2 (only "text" and "transparent" are allowed by name)',
        );
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, `${path}[${index}]`, key);
      });
    } else if (isObject(value)) {
      for (const [childKey, child] of Object.entries(value)) {
        walk(child, path === "" ? childKey : `${path}.${childKey}`, childKey);
      }
    }
  };
  walk(dashboard, "", "");
  return problems;
}

function defaultsOf(panel: JsonObject): JsonObject {
  const fieldConfig = isObject(panel.fieldConfig) ? panel.fieldConfig : {};
  return isObject(fieldConfig.defaults) ? fieldConfig.defaults : {};
}

function overridesOf(panel: JsonObject): JsonObject[] {
  const fieldConfig = isObject(panel.fieldConfig) ? panel.fieldConfig : {};
  return asArray(fieldConfig.overrides).filter(isObject);
}

function overridePropertyValue(override: JsonObject, id: string): unknown {
  const property = asArray(override.properties)
    .filter(isObject)
    .find((p) => p.id === id);
  return property?.value;
}

function timeSeriesProblems(panel: JsonObject, where: string): Problem[] {
  const problems: Problem[] = [];
  const defaults = defaultsOf(panel);
  const custom = isObject(defaults.custom) ? defaults.custom : {};
  if (custom.spanNulls !== false) {
    problems.push({
      where,
      message:
        'a time series must set "spanNulls": false (fieldConfig.defaults.custom), so a missing value shows as a gap',
    });
  }
  const color = isObject(defaults.color) ? defaults.color : {};
  const fixedDefault = asString(color.fixedColor)?.toLowerCase();
  if (color.mode !== "fixed" || fixedDefault !== FIELD_DEFAULT_COLOR.toLowerCase()) {
    problems.push({
      where,
      message: `the default field colour must be fixed ${FIELD_DEFAULT_COLOR}, so no series falls back to Grafana's classic palette`,
    });
  }
  const overrides = overridesOf(panel);
  for (const engine of ENGINES) {
    const override = overrides.find((o) => {
      const matcher = isObject(o.matcher) ? o.matcher : {};
      const options = asString(matcher.options)?.replace(/^\/|\/$/g, "");
      return matcher.id === "byRegexp" && options === engine.name;
    });
    if (!override) {
      problems.push({
        where,
        message: `missing the "Fields with name matching regex" override /${engine.name}/ (colour ${engine.color})`,
      });
      continue;
    }
    const overrideColor = overridePropertyValue(override, "color");
    const fixed = isObject(overrideColor) ? asString(overrideColor.fixedColor) : undefined;
    if (
      overrideColorMode(overrideColor) !== "fixed" ||
      fixed?.toLowerCase() !== engine.color.toLowerCase()
    ) {
      problems.push({
        where,
        message: `override /${engine.name}/ must set the colour {"mode":"fixed","fixedColor":"${engine.color}"}`,
      });
    }
  }
  problems.push(...lineStyleProblems(defaults, overrides, where));
  problems.push(...thresholdsStyleProblems(defaults, overrides, where));
  problems.push(...sharedColorProblems(overrides, where));
  return problems;
}

/**
 * Every time series line is solid (DESIGN.md section 2): series differ by colour, never by dash or
 * dot. A `custom.lineStyle` is allowed only as {"fill":"solid"}, in the defaults or in any override.
 */
function lineStyleProblems(
  defaults: JsonObject,
  overrides: JsonObject[],
  where: string,
): Problem[] {
  const problems: Problem[] = [];
  const check = (lineStyle: unknown, source: string): void => {
    if (lineStyle === undefined) return;
    const fill = isObject(lineStyle) ? lineStyle.fill : undefined;
    if (fill !== "solid") {
      problems.push({
        where,
        message: `${source} sets custom.lineStyle with fill ${JSON.stringify(fill ?? null)}. Every time series line is solid: tell series apart by colour, and leave custom.lineStyle out`,
      });
    }
  };
  const custom = isObject(defaults.custom) ? defaults.custom : {};
  check(custom.lineStyle, "the field defaults");
  for (const override of overrides) {
    const matcher = isObject(override.matcher) ? override.matcher : {};
    const label = `override ${asString(matcher.options) ?? asString(matcher.id) ?? "?"}`;
    check(overridePropertyValue(override, "custom.lineStyle"), label);
  }
  return problems;
}

/** The threshold styles that draw no dashed line. `dashed` and `dashed+area` are the ones Grafana adds. */
const SOLID_THRESHOLD_MODES: ReadonlySet<string> = new Set(["off", "line", "area", "line+area"]);

/**
 * Threshold lines are lines too (DESIGN.md section 2): `custom.thresholdsStyle.mode` may only be
 * off, line, area or line+area, never dashed or dashed+area. A missing mode is Grafana's default, off.
 */
function thresholdsStyleProblems(
  defaults: JsonObject,
  overrides: JsonObject[],
  where: string,
): Problem[] {
  const problems: Problem[] = [];
  const check = (style: unknown, source: string): void => {
    if (style === undefined) return;
    const mode = isObject(style) ? style.mode : undefined;
    if (mode === undefined) return;
    if (typeof mode !== "string" || !SOLID_THRESHOLD_MODES.has(mode)) {
      problems.push({
        where,
        message: `${source} sets custom.thresholdsStyle.mode ${JSON.stringify(mode)}. Every time series line is solid, threshold lines too: use off, line, area or line+area`,
      });
    }
  };
  const custom = isObject(defaults.custom) ? defaults.custom : {};
  check(custom.thresholdsStyle, "the field defaults");
  for (const override of overrides) {
    const matcher = isObject(override.matcher) ? override.matcher : {};
    const label = `override ${asString(matcher.options) ?? asString(matcher.id) ?? "?"}`;
    check(overridePropertyValue(override, "custom.thresholdsStyle"), label);
  }
  return problems;
}

/** No two series overrides of a panel may share a colour: colour is the only way to tell them apart. */
function sharedColorProblems(overrides: JsonObject[], where: string): Problem[] {
  const problems: Problem[] = [];
  const seen = new Map<string, string>();
  for (const override of overrides) {
    const value = overridePropertyValue(override, "color");
    const fixed = isObject(value) ? asString(value.fixedColor)?.toLowerCase() : undefined;
    if (!fixed) continue;
    const matcher = isObject(override.matcher) ? override.matcher : {};
    const label = `/${(asString(matcher.options) ?? "?").replace(/^\/|\/$/g, "")}/`;
    const first = seen.get(fixed);
    if (first !== undefined) {
      problems.push({
        where,
        message: `overrides ${first} and ${label} both use the colour ${fixed}. Series are told apart by colour alone, so each needs its own`,
      });
    } else {
      seen.set(fixed, label);
    }
  }
  return problems;
}

function overrideColorMode(value: unknown): string | undefined {
  return isObject(value) ? asString(value.mode) : undefined;
}

const ZERO_LITERAL = /^(?:to\w+\(\s*)?0+(?:\.0*)?\s*\)?$/;

/** Finds ifNull(x, 0) and coalesce(x, 0): a zero default for something that may be missing. */
export function zeroDefaults(sql: string): string[] {
  const text = stripComments(sql);
  // Same length as `text`, with the contents of strings blanked, so a name inside a string never matches.
  const code = codeOnly(sql);
  const found: string[] = [];
  for (const match of code.matchAll(/\b(?:ifNull|coalesce)\s*\(/gi)) {
    const start = match.index as number;
    const open = start + match[0].length - 1;
    const close = findClosingParen(code, open);
    if (close === -1) continue;
    const args = splitArgs(text.slice(open + 1, close));
    if (args.slice(1).some((arg) => ZERO_LITERAL.test(arg))) {
      found.push(text.slice(start, close + 1).replace(/\s+/g, " "));
    }
  }
  return found;
}

/**
 * The only settings the read-only Grafana user may change (packages/db/src/grafana-user.ts:
 * CHANGEABLE_IN_READONLY). Anything else in a SETTINGS clause is refused by ClickHouse for that user.
 */
const SETTINGS_GRAFANA_MAY_CHANGE = new Set(["max_execution_time", "additional_table_filters"]);

/** Names of the settings in SETTINGS clauses that the read-only Grafana user is not allowed to change. */
export function disallowedSettings(sql: string): string[] {
  const found: string[] = [];
  // codeOnly blanks strings and comments, so the word inside a string or comment does not count.
  for (const match of codeOnly(sql).matchAll(/\bSETTINGS\b([^)]*)/gi)) {
    for (const part of splitArgs(match[1] ?? "")) {
      const name = /^\s*(\w+)\s*=/.exec(part)?.[1];
      if (name && !SETTINGS_GRAFANA_MAY_CHANGE.has(name.toLowerCase())) found.push(name);
    }
  }
  return found;
}

export function sqlRuleProblems(sql: string, where: string): Problem[] {
  const problems: Problem[] = zeroDefaults(sql).map((snippet) => ({
    where,
    message: `${snippet} turns a missing value into 0. Return NULL and let the panel's noValue or mapping show "Not available" or "-" (DESIGN.md section 3, Honest SQL)`,
  }));
  // Checked here as well as by running the query as the read-only user (grafana:check does that by
  // default), so that --admin and --static-only cannot hide it.
  const settings = disallowedSettings(sql);
  if (settings.length > 0) {
    problems.push({
      where,
      message: `has a SETTINGS clause for ${[...new Set(settings)].join(", ")}. The read-only Grafana user may not change that setting, so Grafana would refuse the query; dashboard SQL must not need one (packages/db/README.md)`,
    });
  }
  return problems;
}

export function designProblems(dashboard: JsonObject): Problem[] {
  const problems = colorProblems(dashboard);
  for (const { panel, title } of collectPanels(dashboard)) {
    const where = `panel "${title}"`;
    const type = asString(panel.type);
    if (type === "stat" || type === "table") {
      const noValue = defaultsOf(panel).noValue;
      if (typeof noValue !== "string" || noValue === "") {
        problems.push({
          where,
          message: `a ${type} must set fieldConfig.defaults.noValue, so an empty result never shows Grafana's bare "No data" (DESIGN.md section 6)`,
        });
      }
    }
    if (type === "timeseries") problems.push(...timeSeriesProblems(panel, where));
  }
  return problems;
}

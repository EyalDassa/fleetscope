// Turns the SQL stored in a dashboard into the SQL ClickHouse receives, in the same three steps
// the ClickHouse data source takes (frontend: src/data/CHDatasource.ts applyTemplateVariables,
// backend: pkg/macros, both plugin v4.23.2):
//   1. `$__conditionalAll(condition, $var)`: the condition, or `1=1` when $var is "All".
//   2. Template variables: `$var`, `${var}`, `${var:singlequote}` ... and Grafana's built-in
//      `$__from`, `$__to`, `$__interval` ... Unknown names are left in place.
//   3. The backend macros (macros.ts).
// Anything still starting with `$` afterwards is reported, because ClickHouse would reject it with
// a much less helpful message.
import { expandMacros, type MacroContext, MacroError } from "./macros";
import { codeOnly, findClosingParen, splitArgs } from "./sql-text";

export class InterpolationError extends Error {
  override name = "InterpolationError";
}

export type VariableMode = "default" | "filtered";

/** What a dashboard variable is set to for one run of the check. */
export interface VariableState {
  name: string;
  /** Multi-value variables, and "All", are interpolated as a list: 'a','b'. */
  multi: boolean;
  /** "All" is selected. */
  all: boolean;
  /** The variable's custom "All" value (allValue), if the dashboard defines one. */
  allValue: string | undefined;
  /** The selected values when "All" is not selected. */
  selected: string[];
  /** Every value the variable offers. "All" expands to these. */
  options: string[];
}

export const ALL_VALUE = "$__all";

// ---------------------------------------------------------------- formatting

const quote = (s: string, q: string, escapeValue: (v: string) => string): string =>
  `${q}${escapeValue(s)}${q}`;

/** How a variable value is written into SQL. `fmt` is the part after the colon in ${var:fmt}. */
export function formatVariable(state: VariableState, fmt: string | undefined): string {
  // With a custom "All" value, Grafana inserts that string untouched instead of the option list.
  const useAllValue = state.all && state.allValue !== undefined && state.allValue !== "";
  const values = useAllValue
    ? [state.allValue as string]
    : state.all
      ? state.options
      : state.selected;
  const isList = !useAllValue && (state.multi || state.all);

  switch (fmt) {
    case undefined:
      // The ClickHouse data source's own format function: lists become 'a','b', a single value is raw.
      return isList ? values.map((v) => quote(v, "'", (s) => s)).join(",") : (values[0] ?? "");
    case "raw":
    case "text":
      return isList ? values.join(",") : (values[0] ?? "");
    case "csv":
      return values.join(",");
    case "pipe":
      return values.join("|");
    case "singlequote":
      return values.map((v) => quote(v, "'", (s) => s.replace(/'/g, "\\'"))).join(",");
    case "doublequote":
      return values.map((v) => quote(v, '"', (s) => s.replace(/"/g, '\\"'))).join(",");
    case "sqlstring":
      return values.map((v) => quote(v, "'", (s) => s.replace(/'/g, "''"))).join(",");
    default:
      throw new InterpolationError(
        `variable format "${fmt}" is not supported by the check (supported: raw, csv, pipe, singlequote, doublequote, sqlstring, text)`,
      );
  }
}

// ---------------------------------------------------------------- $__conditionalAll

/** Replaces every `$__conditionalAll(condition, $var)`. Innermost (last) occurrence first. */
export function applyConditionalAll(sql: string, variables: Map<string, VariableState>): string {
  const macro = "$__conditionalAll(";
  let text = sql;
  let at = text.lastIndexOf(macro);
  while (at !== -1) {
    const open = at + macro.length - 1;
    const close = findClosingParen(text, open);
    if (close === -1) throw new InterpolationError("$__conditionalAll( has no closing parenthesis");
    const args = splitArgs(text.slice(open + 1, close));
    if (args.length !== 2) {
      throw new InterpolationError(
        `$__conditionalAll expects 2 arguments (condition, $variable), got ${args.length}`,
      );
    }
    const [condition, variableArg] = args as [string, string];
    const name = /(?<=\$\{)\w+(?=\})|(?<=\$)\w+/.exec(variableArg)?.[0];
    const state = name ? variables.get(name) : undefined;
    // Same rule as the plugin: the condition is dropped when the variable is "All" or empty.
    const dropCondition = state !== undefined && (state.all || state.selected.join(",") === "");
    text = text.slice(0, at) + (dropCondition ? "1=1" : condition) + text.slice(close + 1);
    at = text.lastIndexOf(macro);
  }
  return text;
}

// ---------------------------------------------------------------- template variables

// Grafana's own variable pattern (templateSrv): $var, [[var:fmt]] and ${var.field:fmt}.
const VARIABLE_PATTERN =
  /\$(\w+)|\[\[(\w+?)(?::(\w+))?\]\]|\$\{(\w+)(?:\.([^:^}]+))?(?::([^}]+))?\}/g;

export function replaceVariables(
  sql: string,
  variables: Map<string, VariableState>,
  builtins: Map<string, string>,
): string {
  return sql.replace(
    VARIABLE_PATTERN,
    (
      match,
      plain?: string,
      legacy?: string,
      legacyFmt?: string,
      braced?: string,
      field?: string,
      bracedFmt?: string,
    ) => {
      const name = plain ?? legacy ?? braced;
      if (name === undefined || field !== undefined) return match;
      const builtin = builtins.get(name);
      if (builtin !== undefined) {
        const fmt = legacyFmt ?? bracedFmt;
        if (fmt !== undefined) {
          throw new InterpolationError(
            `format "${fmt}" on the built-in $${name} is not supported by the check`,
          );
        }
        return builtin;
      }
      const state = variables.get(name);
      if (!state) return match;
      return formatVariable(state, legacyFmt ?? bracedFmt);
    },
  );
}

// ---------------------------------------------------------------- the whole pipeline

export interface InterpolationInput {
  sql: string;
  variables: Map<string, VariableState>;
  builtins: Map<string, string>;
  macros: MacroContext;
}

export function interpolate({ sql, variables, builtins, macros }: InterpolationInput): string {
  let result: string;
  try {
    result = expandMacros(
      replaceVariables(applyConditionalAll(sql, variables), variables, builtins),
      macros,
    );
  } catch (error) {
    if (error instanceof MacroError) throw new InterpolationError(error.message);
    throw error;
  }
  const leftover = /\$\{?[A-Za-z_]\w*/.exec(codeOnly(result));
  if (leftover) {
    throw new InterpolationError(
      `"${leftover[0]}" is neither a variable of this dashboard nor a known macro, so ClickHouse would receive it as it is`,
    );
  }
  return result;
}

// R-M2-19: how a text box variable may appear in SQL.
//
// A text box (`type: "textbox"`, the Session dashboard's `session` and the Sessions dashboard's
// `cause`) takes whatever a person types or whatever is in the URL. Grafana's `singlequote` format
// turns ' into \' but leaves a backslash alone, so a value ending in \' leaves the SQL string
// (QA-M2-05). `percentencode` leaves no quote, backslash or space in the value (it also encodes
// ! ' ( ) *), so the only safe way in is
//
//     decodeURLComponent('${name:percentencode}')
//
// Anything else is reported: ${name:singlequote}, '${name}', a bare $name, [[name]] and so on.
//
// Not covered, on purpose: the multi-select query variables (`engine`, `source`, `agent`,
// `scenario`) may keep `singlequote`. Their values come from the database, not from a person, and
// ingest restricts those fields to SAFE_LABEL_PATTERN (letters, digits and a few separators, no
// quote or backslash), so a stored value cannot break out of the string.
//
// The read-only ClickHouse user still bounds what an injected query could do, so this is a
// guard rail against a future panel that forgets, not the security boundary.
import { findClosingParen, splitArgs, stripComments } from "./sql-text";

export interface VariableRuleProblem {
  message: string;
  detail: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `$__conditionalAll(condition, $var)` names its variable as the second argument. That is an
 * argument to the macro, not text that reaches ClickHouse, so it is not a use of the variable.
 * Overwrites that argument with filler of the same length, so the positions, and the snippets shown
 * in a message, still match the SQL in the dashboard.
 */
function withoutConditionalAllArguments(text: string): string {
  const macro = "$__conditionalAll(";
  let out = text;
  let at = out.lastIndexOf(macro);
  while (at !== -1) {
    const open = at + macro.length - 1;
    const close = findClosingParen(out, open);
    if (close !== -1) {
      const inner = out.slice(open + 1, close);
      const args = splitArgs(inner);
      const variable = args.length === 2 ? args[1] : undefined;
      if (variable) {
        const from = open + 1 + inner.lastIndexOf(variable);
        out = out.slice(0, from) + "_".repeat(variable.length) + out.slice(from + variable.length);
      }
    }
    at = at === 0 ? -1 : out.lastIndexOf(macro, at - 1);
  }
  return out;
}

/** About `width` characters of SQL on each side of a match, on one line. */
function snippet(text: string, start: number, end: number, width = 36): string {
  const flat = (s: string): string => s.replace(/\s+/g, " ");
  const before = flat(text.slice(Math.max(0, start - width), start));
  const after = flat(text.slice(end, end + width));
  return `${start > width ? "..." : ""}${before}${flat(text.slice(start, end))}${after}${end + width < text.length ? "..." : ""}`;
}

/**
 * The places in `sql` where a text box variable is used other than as
 * `decodeURLComponent('${name:percentencode}')`.
 */
export function textboxProblems(sql: string, textboxNames: string[]): VariableRuleProblem[] {
  const text = withoutConditionalAllArguments(stripComments(sql));
  const problems: VariableRuleProblem[] = [];
  for (const name of textboxNames) {
    const n = escapeRegExp(name);
    // ${name}, ${name:format}, [[name]], [[name:format]] and a bare $name (not $name_other)
    const reference = new RegExp(
      `\\$\\{${n}(?::[^}]*)?\\}|\\[\\[${n}(?::\\w+)?\\]\\]|\\$${n}(?![\\w])`,
      "g",
    );
    for (const match of text.matchAll(reference)) {
      const start = match.index as number;
      const end = start + match[0].length;
      const wrapped =
        match[0] === `\${${name}:percentencode}` &&
        /decodeURLComponent\(\s*'$/.test(text.slice(0, start)) &&
        /^'\s*\)/.test(text.slice(end));
      if (wrapped) continue;
      problems.push({
        message: `uses the text box variable ${match[0]} in SQL. A text box takes any text, and singlequote does not escape a backslash, so a value ending in \\' can leave the string. Write decodeURLComponent('\${${name}:percentencode}') instead (percentencode leaves no quote or backslash in the value)`,
        detail: `Found: ${snippet(text, start, end)}`,
      });
    }
  }
  return problems;
}

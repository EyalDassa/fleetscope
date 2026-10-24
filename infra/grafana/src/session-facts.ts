// R-M2-05: every copy of the `session-facts` query in the dashboards must be the README's.
//
// packages/db/README.md ("Grafana data rules") holds the one definition of a session's display status,
// cause, cost and so on, as the block ```sql name=session-facts. Dashboard panels can't share SQL, so
// each panel that needs it pastes the block as `WITH facts AS ( <block> )`. CI used to check only that
// every copy *runs*; if one copy were edited (say the cause rule), CI stayed green and two panels would
// quietly disagree. This rule compares every copy with the README block.
//
// Comments, whitespace and the spacing around ( ) , are ignored; everything else must be equal. The one
// allowed difference: on the Session dashboard `picked` selects one session, so its WHERE may be a
// single `session_id = ...${session...}...` condition instead of the README's range filter, and it has
// no engine or source variable, so the two lines `AND engine IN (...)` / `AND source IN (...)` may be
// left out of `issue_facts` and `action_facts` (and from nowhere else). packages/db/README.md
// ("How the dashboards relate to these snippets") documents both exceptions.
import { codeOnly, findClosingParen, skipQuoted, stripComments } from "./sql-text";

const README_BLOCK = /```sql name=session-facts\r?\n([\s\S]*?)\r?\n```/;

/** The session-facts block of the README, or undefined if there is none. */
export function readSessionFacts(readme: string): string | undefined {
  return README_BLOCK.exec(readme)?.[1];
}

/**
 * SQL without comments, whitespace collapsed to single spaces and no space next to ( ) or a comma.
 * Quoted strings and identifiers are copied exactly.
 */
export function normalizeSql(sql: string): string {
  const text = stripComments(sql);
  let out = "";
  let plain = "";
  const flush = (): void => {
    out += plain.replace(/\s+/g, " ").replace(/ ?([(),]) ?/g, "$1");
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "'" || ch === '"' || ch === "`") {
      flush();
      const end = skipQuoted(text, i);
      out += text.slice(i, end);
      i = end;
    } else {
      plain += ch;
      i += 1;
    }
  }
  flush();
  return out.trim();
}

/** The text inside each `facts AS ( ... )` of a query, normalised. */
export function factsBodies(sql: string): string[] {
  const text = stripComments(sql);
  // Search the view with strings blanked (same length as `text`), so "facts AS (" inside a string
  // literal is not taken for a CTE; read the body from `text`.
  const bodies: string[] = [];
  for (const match of codeOnly(sql).matchAll(/\bfacts\s+AS\s*\(/gi)) {
    const open = (match.index as number) + match[0].length - 1;
    const close = findClosingParen(text, open);
    bodies.push(normalizeSql(close === -1 ? text.slice(open + 1) : text.slice(open + 1, close)));
  }
  return bodies;
}

/** Splits normalised session-facts into the part before `picked`'s WHERE condition, the condition, and the rest. */
function splitPickedFilter(normalized: string): [string, string, string] | undefined {
  const start = /\bpicked AS\(/i.exec(normalized);
  if (!start) return undefined;
  const open = start.index + start[0].length - 1;
  const close = findClosingParen(normalized, open);
  if (close === -1) return undefined;
  const inside = normalized.slice(open + 1, close);
  const where = / WHERE /i.exec(inside);
  if (!where) return undefined;
  const conditionStart = open + 1 + where.index + where[0].length;
  return [
    normalized.slice(0, conditionStart),
    normalized.slice(conditionStart, close),
    normalized.slice(close),
  ];
}

/** On the Session dashboard `picked` may select the one session the page is about. */
const ONE_SESSION_FILTER = /^session_id = .*\$\{session(?::\w+)?\}/;

/** The two filter lines that Session detail may leave out (normalised, as they appear in the README). */
const ENGINE_SOURCE_LINES =
  "AND engine IN(${engine:singlequote})AND source IN(${source:singlequote})";
/** The CTEs of the block that those lines may be left out of. */
const ENGINE_SOURCE_OPTIONAL_IN = ["issue_facts", "action_facts"];

/** The normalised block with the engine/source lines removed from `issue_facts` and `action_facts` only. */
export function withoutEngineSourceLines(normalized: string): string {
  let text = normalized;
  for (const name of ENGINE_SOURCE_OPTIONAL_IN) {
    const start = new RegExp(String.raw`\b${name} AS\(`, "i").exec(text);
    if (!start) continue;
    const open = start.index + start[0].length - 1;
    const close = findClosingParen(text, open);
    if (close === -1) continue;
    const inside = text
      .slice(open + 1, close)
      .split(ENGINE_SOURCE_LINES)
      .join("");
    text = text.slice(0, open + 1) + inside + text.slice(close);
  }
  return text;
}

/** A short description of the first difference between two normalised texts, or undefined if equal. */
export function describeDifference(expected: string, actual: string): string | undefined {
  if (expected === actual) return undefined;
  let start = 0;
  const shortest = Math.min(expected.length, actual.length);
  while (start < shortest && expected[start] === actual[start]) start += 1;
  let endExpected = expected.length;
  let endActual = actual.length;
  while (
    endExpected > start &&
    endActual > start &&
    expected[endExpected - 1] === actual[endActual - 1]
  ) {
    endExpected -= 1;
    endActual -= 1;
  }
  // Show whole words: [failed] and [blocked], not [fail] and [block].
  const isWord = (c: string | undefined): boolean => c !== undefined && /[\w$]/.test(c);
  while (start > 0 && isWord(expected[start - 1])) start -= 1;
  while (isWord(expected[endExpected])) endExpected += 1;
  while (isWord(actual[endActual])) endActual += 1;
  const context = 36;
  const show = (text: string, end: number): string => {
    const before = text.slice(Math.max(0, start - context), start);
    const middle = text.slice(start, end);
    const after = text.slice(end, end + context);
    const clipped = middle.length > 120 ? `${middle.slice(0, 120)}...` : middle;
    return `${start > context ? "..." : ""}${before}[${clipped}]${after}${end + context < text.length ? "..." : ""}`;
  };
  return `README: ${show(expected, endExpected)}\n    panel:  ${show(actual, endActual)}`;
}

export interface FactsProblem {
  message: string;
  detail: string | undefined;
}

/**
 * Compares every `facts AS (...)` in `sql` with the README block. `dashboardUid` decides whether the
 * Session dashboard's one-session `picked` filter is allowed.
 */
export function sessionFactsProblems(
  sql: string,
  readmeBlock: string,
  dashboardUid: string,
): FactsProblem[] {
  const expected = normalizeSql(readmeBlock);
  const problems: FactsProblem[] = [];
  for (const body of factsBodies(sql)) {
    let wanted = expected;
    let found = body;
    // Texts the copy may equal. The README's own text always; on Session detail also the form
    // without the engine/source lines.
    let accepted = [expected];
    if (dashboardUid === "fleetscope-session") {
      const wantedParts = splitPickedFilter(expected);
      const foundParts = splitPickedFilter(body);
      if (wantedParts && foundParts && ONE_SESSION_FILTER.test(foundParts[1])) {
        wanted = `${wantedParts[0]}<picked filter>${wantedParts[2]}`;
        found = `${foundParts[0]}<picked filter>${foundParts[2]}`;
      }
      const stripped = withoutEngineSourceLines(wanted);
      accepted = [wanted, stripped];
      wanted = stripped; // the form Session detail uses is the one a mismatch is explained against
    }
    if (accepted.includes(found)) continue;
    const difference = describeDifference(wanted, found);
    if (difference) {
      problems.push({
        message:
          'its "WITH facts AS (...)" differs from the session-facts block of packages/db/README.md. Every panel pastes that block unchanged, so that all panels share one definition of status, cause and cost: change the README and every copy together',
        detail: `First difference:\n    ${difference}`,
      });
    }
  }
  return problems;
}

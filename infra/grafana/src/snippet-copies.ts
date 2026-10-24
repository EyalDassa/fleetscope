// Every SQL that a dashboard panel or an alert rule copies from packages/db/README.md must equal the
// README block it copies. session-facts has its own, finer rule (session-facts.ts: a pasted
// `WITH facts AS (...)` with two allowed differences). This one is for queries copied whole:
//
//   -- snippet: capacity-alerts-mem-pct      (a comment anywhere in the SQL names the block)
//   SELECT ...
//
// - A query that names a block must equal it (comments, whitespace and the spacing around ( ) , are
//   ignored; anything else is a difference).
// - On the Capacity dashboard and in the alert rules, EVERY ClickHouse query must be a copy: it names
//   a block, or, if it names none, it must equal one of the README blocks. A query that is neither is
//   an edited copy (or new SQL that belongs in the README first).
// - Elsewhere the marker is optional: a query without it is not looked at.
import type { Problem } from "./dashboards";
import { describeDifference, normalizeSql } from "./session-facts";

const MARKER = /^\s*--\s*snippet:\s*([\w-]+)\s*$/m;

/** The block name in a `-- snippet: <name>` comment, if any. */
export function snippetNameOf(sql: string): string | undefined {
  return MARKER.exec(sql)?.[1];
}

/** Every named ```sql name=<x> block of the README. */
export function readNamedSnippets(readme: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of readme.matchAll(/```sql name=([\w-]+)\r?\n([\s\S]*?)\r?\n```/g)) {
    out.set(match[1] as string, match[2] as string);
  }
  return out;
}

/** The problems of one query. `requireCopy`: the query must be a copy of some block. */
export function snippetCopyProblems(
  sql: string,
  snippets: Map<string, string>,
  options: { where: string; requireCopy: boolean },
): { problems: Problem[]; used: string | undefined } {
  const { where } = options;
  const name = snippetNameOf(sql);
  if (name === "session-facts") return { problems: [], used: undefined }; // its own rule
  const normalized = normalizeSql(sql);
  if (name !== undefined) {
    const block = snippets.get(name);
    if (block === undefined) {
      return {
        problems: [
          {
            where,
            message: `names the snippet "${name}", which packages/db/README.md does not have (blocks: ${[...snippets.keys()].join(", ") || "none"})`,
          },
        ],
        used: undefined,
      };
    }
    const difference = describeDifference(normalizeSql(block), normalized);
    return difference === undefined
      ? { problems: [], used: name }
      : {
          problems: [
            {
              where,
              message: `is not the README block \`${name}\`. Copy the block again: packages/db/README.md is the definition`,
              detail: difference,
            },
          ],
          used: undefined,
        };
  }
  if (!options.requireCopy) return { problems: [], used: undefined };
  for (const [blockName, block] of snippets) {
    if (blockName !== "session-facts" && normalizeSql(block) === normalized) {
      return { problems: [], used: blockName };
    }
  }
  return {
    problems: [
      {
        where,
        message:
          "is not a copy of any packages/db/README.md block (a copy was edited, or this is new SQL). Put the query in the README first, then paste it here; add `-- snippet: <name>` to say which block it is",
      },
    ],
    used: undefined,
  };
}

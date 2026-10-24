// Text helpers shared by the macro expander and the dashboard rules. They know just enough SQL to
// skip quoted strings and comments; they are not a parser.

/**
 * Returns the index just after the quoted region that starts at `start` (a `'`, `"` or backtick),
 * or the end of the text when the quote is never closed. ClickHouse allows both `\'` and `''`
 * inside a string.
 */
export function skipQuoted(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && quote !== "`") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (text[i + 1] === quote) {
        i += 2; // a doubled quote is an escaped quote
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

/**
 * Replaces `-- line` and block comments with spaces (newlines stay, so error positions line up).
 * Grafana's macro engine does the same before it looks for macros, so a macro inside a comment is
 * never expanded.
 */
export function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = skipQuoted(sql, i);
      out += sql.slice(i, end);
      i = end;
    } else if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        out += " ";
        i += 1;
      }
    } else if (ch === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      const end = close === -1 ? sql.length : close + 2;
      out += sql.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Index of the `)` that closes the `(` at `open`, skipping quoted text. -1 when there is none. */
export function findClosingParen(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(text, i);
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** Splits `a, f(b, c), 'd,e'` at the top-level commas. Each part is trimmed. */
export function splitArgs(raw: string): string[] {
  if (raw.trim() === "") return [];
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i] as string;
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = skipQuoted(raw, i);
      current += raw.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
    i += 1;
  }
  parts.push(current.trim());
  return parts;
}

/** The SQL with comments removed and every quoted string or identifier blanked out. */
export function codeOnly(sql: string): string {
  const noComments = stripComments(sql);
  let out = "";
  let i = 0;
  while (i < noComments.length) {
    const ch = noComments[i] as string;
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = skipQuoted(noComments, i);
      out += `${ch}${" ".repeat(Math.max(0, end - i - 2))}${ch}`;
      i = end;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

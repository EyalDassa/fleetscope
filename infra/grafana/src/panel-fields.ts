// Which fields (columns) does a panel refer to by name, and do they exist in the data it gets?
//
// Needed for panels that read another panel's query through Grafana's Dashboard data source
// (R-M2-01): the panel has no SQL of its own, so a typo in `reduceOptions.fields` (or a renamed
// column in the source query) would not fail anywhere. The panel would just show "No data". We
// know the source query's columns from running it, so we can check.
//
// What counts as a reference:
//   - options.reduceOptions.fields   "Value options > Fields": a /regex/ or a field name
//   - fieldConfig.overrides[].matcher  byName (a column name) and byRegexp
//   - ${__data.fields.NAME} in data links (fieldConfig and panel links)
// Names are matched against the field's display name, which a `displayName` override can change
// (the Outcomes bar gauge shows "✓ Healthy" for the column `healthy`), and against the raw column.
// Panels with transformations are skipped: they can rename or drop fields in ways we cannot see.
import { asArray, asString, isObject, type JsonObject } from "./json";

export interface FieldReference {
  /** Where in the panel JSON, for the message. */
  at: string;
  kind: "name" | "pattern";
  /** A column name, or a regular expression source. */
  value: string;
  flags: string;
  /** byName and ${__data.fields.x} use the raw column name; reduceOptions.fields uses the display name. */
  matches: "column" | "display" | "either";
}

/** `/regex/flags` as Grafana writes it, or a plain pattern. Returns undefined if it is not valid. */
export function parseFieldPattern(text: string): { source: string; flags: string } | undefined {
  let source = text;
  let flags = "";
  if (text.startsWith("/")) {
    const end = text.lastIndexOf("/");
    if (end > 0) {
      source = text.slice(1, end);
      flags = text.slice(end + 1);
    }
  }
  try {
    new RegExp(source, flags);
  } catch {
    return undefined;
  }
  return { source, flags };
}

const DATA_FIELD = /\$\{__data\.fields(?:\.(\w+)|\["([^"]+)"\]|\[([^\]"\d][^\]]*)\])/g;

/** Walks every string in a value, with the path to it. */
function strings(value: unknown, path: string, visit: (text: string, path: string) => void): void {
  if (typeof value === "string") visit(value, path);
  else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) strings(item, `${path}[${i}]`, visit);
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) strings(child, `${path}.${key}`, visit);
  }
}

export function fieldReferences(panel: JsonObject): FieldReference[] {
  const refs: FieldReference[] = [];

  const options = isObject(panel.options) ? panel.options : {};
  const reduce = isObject(options.reduceOptions) ? options.reduceOptions : {};
  const fields = asString(reduce.fields);
  if (fields) {
    const slashed = fields.startsWith("/") && fields.lastIndexOf("/") > 0;
    refs.push({
      at: "options.reduceOptions.fields",
      kind: slashed ? "pattern" : "name",
      value: slashed ? (parseFieldPattern(fields)?.source ?? fields) : fields,
      flags: slashed ? (parseFieldPattern(fields)?.flags ?? "") : "",
      matches: "display",
    });
  }

  const fieldConfig = isObject(panel.fieldConfig) ? panel.fieldConfig : {};
  asArray(fieldConfig.overrides)
    .filter(isObject)
    .forEach((override, index) => {
      const matcher = isObject(override.matcher) ? override.matcher : {};
      const options = asString(matcher.options);
      if (!options) return;
      const at = `fieldConfig.overrides[${index}].matcher`;
      if (matcher.id === "byName") {
        refs.push({ at, kind: "name", value: options, flags: "", matches: "column" });
      } else if (matcher.id === "byRegexp") {
        const pattern = parseFieldPattern(options);
        if (pattern) {
          refs.push({
            at,
            kind: "pattern",
            value: pattern.source,
            flags: pattern.flags,
            matches: "either",
          });
        }
      }
    });

  for (const [holder, path] of [
    [fieldConfig, "fieldConfig"],
    [panel.links, "links"],
  ] as const) {
    strings(holder, path, (text, at) => {
      for (const match of text.matchAll(DATA_FIELD)) {
        const name = match[1] ?? match[2] ?? match[3];
        if (name) refs.push({ at, kind: "name", value: name, flags: "", matches: "either" });
      }
    });
  }
  return refs;
}

/** column -> display name, after `displayName` overrides (byName) on the panel. */
export function displayNames(panel: JsonObject, columns: string[]): Map<string, string> {
  const fieldConfig = isObject(panel.fieldConfig) ? panel.fieldConfig : {};
  const renamed = new Map<string, string>();
  for (const override of asArray(fieldConfig.overrides).filter(isObject)) {
    const matcher = isObject(override.matcher) ? override.matcher : {};
    if (matcher.id !== "byName") continue;
    const name = asArray(override.properties)
      .filter(isObject)
      .find((p) => p.id === "displayName");
    const column = asString(matcher.options);
    if (column && typeof name?.value === "string") renamed.set(column, name.value);
  }
  return new Map(columns.map((c) => [c, renamed.get(c) ?? c]));
}

/**
 * The references of `panel` that match nothing in `columns`, as messages. A pattern of the form
 * `^(a|b|c)$` must match every alternative, because that is how a panel lists the fields it needs.
 */
export function unmatchedFieldReferences(panel: JsonObject, columns: string[]): string[] {
  const display = displayNames(panel, columns);
  const raw = [...display.keys()];
  const shown = [...display.values()];
  const messages: string[] = [];

  for (const ref of fieldReferences(panel)) {
    const pool =
      ref.matches === "column" ? raw : ref.matches === "display" ? shown : [...raw, ...shown];
    const available = `available: ${[...new Set(ref.matches === "column" ? raw : shown)].join(", ") || "(no columns)"}`;
    if (ref.kind === "name") {
      if (!pool.includes(ref.value)) {
        messages.push(
          `${ref.at} names the field "${ref.value}", which the source query does not return (${available})`,
        );
      }
      continue;
    }
    const regex = new RegExp(ref.value, ref.flags);
    if (!pool.some((name) => regex.test(name))) {
      messages.push(
        `${ref.at} is /${ref.value}/, which matches no field of the source query (${available})`,
      );
      continue;
    }
    const alternatives = /^\^\((.+)\)\$$/.exec(ref.value)?.[1]?.split("|");
    if (alternatives?.every((a) => /^[^\\()[\]{}.*+?^$|]+$/.test(a))) {
      const missing = alternatives.filter((a) => !pool.includes(a));
      if (missing.length > 0) {
        messages.push(
          `${ref.at} lists ${missing.map((m) => `"${m}"`).join(", ")}, which the source query does not return (${available})`,
        );
      }
    }
  }
  return messages;
}

export function hasTransformations(panel: JsonObject): boolean {
  return asArray(panel.transformations).length > 0;
}

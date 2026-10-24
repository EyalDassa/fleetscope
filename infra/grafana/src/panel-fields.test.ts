import { describe, expect, it } from "vitest";
import type { JsonObject } from "./json";
import {
  displayNames,
  fieldReferences,
  hasTransformations,
  parseFieldPattern,
  unmatchedFieldReferences,
} from "./panel-fields";

const columns = ["ended", "healthy", "degraded", "failed", "blocked", "session_count", "verdict"];

/** A stat that selects one field of the shared summary query. */
function stat(fields: string, extra: JsonObject = {}): JsonObject {
  return { type: "stat", options: { reduceOptions: { fields } }, ...extra };
}

describe("parseFieldPattern", () => {
  it("reads /regex/flags and plain patterns, and rejects broken ones", () => {
    expect(parseFieldPattern("/^a$/i")).toEqual({ source: "^a$", flags: "i" });
    expect(parseFieldPattern("^a$")).toEqual({ source: "^a$", flags: "" });
    expect(parseFieldPattern("/(/")).toBeUndefined();
  });
});

describe("fieldReferences", () => {
  it("finds the fields selected by value options, overrides and data links", () => {
    const panel = stat("/^session_count$/", {
      fieldConfig: {
        defaults: {
          links: [
            {
              url: '/d/x?a=${__data.fields.session_id}&b=${__data.fields["from ms"]}&c=${__data.fields.t:percentencode}',
            },
            { url: "/d/x?first=${__data.fields[0]}" },
          ],
        },
        overrides: [
          { matcher: { id: "byName", options: "healthy" }, properties: [] },
          { matcher: { id: "byRegexp", options: "/^c/" }, properties: [] },
          { matcher: { id: "byType", options: "number" }, properties: [] },
        ],
      },
      links: [{ url: "/d/y?q=${__data.fields.verdict}" }],
    });
    const found = fieldReferences(panel).map((r) => [r.kind, r.value]);
    expect(found).toEqual([
      ["pattern", "^session_count$"],
      ["name", "healthy"],
      ["pattern", "^c"],
      ["name", "session_id"],
      ["name", "from ms"],
      ["name", "t"],
      ["name", "verdict"],
    ]);
  });

  it("finds nothing in a panel that selects no fields", () => {
    expect(fieldReferences({ type: "stat", options: { reduceOptions: { fields: "" } } })).toEqual(
      [],
    );
    expect(fieldReferences({ type: "text" })).toEqual([]);
  });
});

describe("unmatchedFieldReferences", () => {
  it("accepts fields that exist, as a regex or as a plain name", () => {
    expect(unmatchedFieldReferences(stat("/^session_count$/"), columns)).toEqual([]);
    expect(unmatchedFieldReferences(stat("verdict"), columns)).toEqual([]);
    expect(unmatchedFieldReferences(stat(""), columns)).toEqual([]);
  });

  it("names a field that the source query does not return, and what it does return", () => {
    const [message] = unmatchedFieldReferences(stat("/^session_cnt$/"), columns);
    expect(message).toMatch(
      /options\.reduceOptions\.fields is \/\^session_cnt\$\/.*matches no field/,
    );
    expect(message).toContain("available: ended, healthy");
    expect(unmatchedFieldReferences(stat("nope"), columns)[0]).toMatch(/names the field "nope"/);
  });

  it("matches value options against display names, after a displayName override", () => {
    const outcomes = stat("/^(✓ Healthy|▲ Degraded|✕ Failed|⊘ Blocked)$/", {
      fieldConfig: {
        overrides: [
          ["healthy", "✓ Healthy"],
          ["degraded", "▲ Degraded"],
          ["failed", "✕ Failed"],
          ["blocked", "⊘ Blocked"],
        ].map(([column, name]) => ({
          matcher: { id: "byName", options: column },
          properties: [{ id: "displayName", value: name }],
        })),
      },
    });
    expect(unmatchedFieldReferences(outcomes, columns)).toEqual([]);
    // the same panel without the renames selects names that no column has
    expect(unmatchedFieldReferences({ ...outcomes, fieldConfig: {} }, columns)[0]).toMatch(
      /matches no field/,
    );
  });

  it("wants every alternative of ^(a|b|c)$ to exist, not just one", () => {
    const [message] = unmatchedFieldReferences(
      stat("/^(healthy|degraded|failed|crashed)$/"),
      columns,
    );
    expect(message).toMatch(/lists "crashed", which the source query does not return/);
    // not a list of plain names: one match is enough
    expect(unmatchedFieldReferences(stat("/^(healthy|d.*)$/"), columns)).toEqual([]);
  });

  it("checks byName overrides against the raw column and data links against either", () => {
    const panel = stat("/^verdict$/", {
      fieldConfig: {
        overrides: [{ matcher: { id: "byName", options: "helthy" }, properties: [] }],
        defaults: {
          links: [{ url: "/d/x?v=${__data.fields.verdict}&w=${__data.fields.nothing}" }],
        },
      },
    });
    const messages = unmatchedFieldReferences(panel, columns);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/overrides\[0\]\.matcher names the field "helthy"/);
    expect(messages[1]).toMatch(/names the field "nothing"/);
  });
});

describe("displayNames and hasTransformations", () => {
  it("maps each column to its display name", () => {
    const panel: JsonObject = {
      fieldConfig: {
        overrides: [
          {
            matcher: { id: "byName", options: "a" },
            properties: [{ id: "displayName", value: "Alpha" }],
          },
          { matcher: { id: "byName", options: "b" }, properties: [{ id: "color", value: {} }] },
        ],
      },
    };
    expect([...displayNames(panel, ["a", "b"]).entries()]).toEqual([
      ["a", "Alpha"],
      ["b", "b"],
    ]);
  });

  it("knows whether a panel has transformations", () => {
    expect(hasTransformations({ transformations: [{ id: "organize" }] })).toBe(true);
    expect(hasTransformations({ transformations: [] })).toBe(false);
    expect(hasTransformations({})).toBe(false);
  });
});

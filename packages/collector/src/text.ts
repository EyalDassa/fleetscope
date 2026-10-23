/**
 * Text going into events must be well-formed UTF-16: a lone surrogate (half an emoji) is valid for
 * a JavaScript string and for the schema, but ClickHouse refuses it when it reads the JSON
 * (error 25, and it refuses the same flush on every retry). So everything the collector cuts or
 * copies from a page goes through here.
 */

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replaces each unpaired surrogate with U+FFFD, the Unicode replacement character. */
export function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, "�");
}

/**
 * At most `max` UTF-16 units of `text`, never ending in the first half of a surrogate pair, and
 * well-formed whatever the input was.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return wellFormed(text);
  let end = Math.max(0, max);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // the cut would split a pair: leave the pair out
  return wellFormed(text.slice(0, end));
}

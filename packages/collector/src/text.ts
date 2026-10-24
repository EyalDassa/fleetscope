import { SAFE_LABEL_PATTERN } from "@fleetscope/schema";

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

/**
 * A value for a field that dashboards put into SQL (the schema's "safe labels"): every character
 * outside `A-Z a-z 0-9 . _ : @ / + -` becomes `_` (one per character, so an emoji is one `_`), cut at
 * `max` characters. For strings that come from outside, such as the version a browser reports: the API
 * refuses a bad value with a 400 for the whole batch, and the collector drops a refused batch.
 */
export function safeLabel(text: string, max = 128): string {
  const cleaned = Array.from(text, (char) => (SAFE_LABEL_PATTERN.test(char) ? char : "_"))
    .slice(0, max)
    .join("");
  return cleaned === "" ? "_" : cleaned;
}

/** Throws when `value` is not a safe label. For values the caller chose: say so early, do not change them. */
export function assertSafeLabel(name: string, value: string): void {
  if (!SAFE_LABEL_PATTERN.test(value)) {
    throw new TypeError(
      `${name} must be 1 to 128 characters from A-Z a-z 0-9 . _ : @ / + - (got ${JSON.stringify(value.slice(0, 40))})`,
    );
  }
}

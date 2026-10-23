import { EventBatch, type FleetEvent } from "@fleetscope/schema";
import { describe, expect, it } from "vitest";
import { shortMessage } from "./errors";
import { domainOf } from "./page";
import { FakePage, makeCollector, sessionOptions } from "./test-utils";
import { clip, wellFormed } from "./text";

/** `String.prototype.isWellFormed` exists in Node 22; the project's TS lib predates it. */
const isWellFormed = (text: string): boolean =>
  (text as unknown as { isWellFormed(): boolean }).isWellFormed();

const FACE = "\u{1F600}"; // one character, two UTF-16 units: 😀

describe("clip", () => {
  it("leaves short text alone", () => {
    expect(clip("hello", 10)).toBe("hello");
    expect(clip("", 5)).toBe("");
  });

  it("cuts at the limit", () => {
    expect(clip("abcdef", 3)).toBe("abc");
  });

  it("never ends in the first half of an emoji", () => {
    const text = `ab${FACE}cd`; // units: a b \uD83D \uDE00 c d
    expect(clip(text, 3)).toBe("ab"); // the cut would split the face: leave it out
    expect(clip(text, 4)).toBe(`ab${FACE}`);
    expect(isWellFormed(clip(text, 3))).toBe(true);
  });

  it("every cut point of a string full of emoji is well-formed", () => {
    const text = FACE.repeat(20);
    for (let max = 0; max <= text.length; max++) {
      const cut = clip(text, max);
      expect(isWellFormed(cut), `max ${max}`).toBe(true);
      expect(cut.length).toBeLessThanOrEqual(max);
    }
  });

  it("repairs a lone surrogate that was already in the text, short or long", () => {
    expect(clip("boom \uD83D", 100)).toBe("boom �");
    expect(clip("\uDE00 start", 100)).toBe("� start");
    expect(isWellFormed(clip(`\uD800${"x".repeat(50)}`, 10))).toBe(true);
  });

  it("copes with a zero limit", () => {
    expect(clip("abc", 0)).toBe("");
    expect(clip(FACE, 0)).toBe("");
  });
});

describe("wellFormed", () => {
  it("keeps proper pairs and replaces only the unpaired halves", () => {
    expect(wellFormed(`a${FACE}b`)).toBe(`a${FACE}b`);
    expect(wellFormed("\uD83Dx\uDE00")).toBe("�x�");
    expect(wellFormed("\uD83D😀")).toBe(`�${FACE}`);
  });
});

describe("shortMessage and domainOf", () => {
  it("shortMessage cuts an emoji-heavy first line without splitting a pair", () => {
    const message = `${"x".repeat(498)}${FACE}${FACE}\nCall log:\n  more`;
    const short = shortMessage(new Error(message), 500);
    expect(isWellFormed(short)).toBe(true);
    expect(short.endsWith("…")).toBe(true);
    expect(short.length).toBeLessThanOrEqual(500);
  });

  it("shortMessage is never empty", () => {
    expect(shortMessage(new Error(""))).toBe("Error");
    expect(shortMessage("")).toBe("unknown error");
    expect(shortMessage(new TypeError("\n\ndetails"))).toBe("TypeError");
  });

  it("shortMessage repairs a lone surrogate from a page", () => {
    expect(shortMessage(new Error("boom \uD83D"))).toBe("boom �");
  });

  it("domainOf cuts a long non-URL without splitting a pair", () => {
    const junk = `${"y".repeat(199)}${FACE}`;
    expect(isWellFormed(domainOf(junk))).toBe(true);
    expect(domainOf(junk).length).toBeLessThanOrEqual(200);
    expect(domainOf("http://example.com/path")).toBe("example.com");
  });
});

describe("events built from hostile text are always well-formed (R-M1-01)", () => {
  it("a page error, a selector, a target and a reason with half emoji reach the queue repaired", async () => {
    const { collector, sink } = makeCollector();
    const session = collector.startSession({
      ...sessionOptions,
      scenario: `scenario \uD83D`,
    });
    const fake = new FakePage();
    const page = await session.collectPage(fake.asPage());

    // The page throws a ReferenceError whose message ends in half an emoji, right at the 500 cut.
    fake.emit(
      "pageerror",
      Object.assign(new Error(`${"w".repeat(480)} is not defined ${FACE}${FACE}${FACE}`), {
        name: "ReferenceError",
      }),
    );
    await page.fill(`#field-\uD83D`, "value");
    await page.eval(`1 + ${"1".repeat(1990)}${FACE}`);
    await session.endSession("failed", `${"r".repeat(1999)}${FACE}`);
    await collector.flush();

    const strings = sink.events.flatMap((event) => collectStrings(event));
    expect(strings.length).toBeGreaterThan(10);
    for (const text of strings) expect(isWellFormed(text), text.slice(0, 40)).toBe(true);
    expect(EventBatch.safeParse(sink.events).success).toBe(true);
  });
});

function collectStrings(event: FleetEvent): string[] {
  return Object.values(event).filter((value): value is string => typeof value === "string");
}

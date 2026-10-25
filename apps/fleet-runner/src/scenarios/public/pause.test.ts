import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPauseStore, PAUSE_MS } from "./pause";

const dir = mkdtempSync(join(tmpdir(), "fleetscope-pause-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("pause store", () => {
  it("pauses for an hour", () => {
    expect(PAUSE_MS).toBe(3_600_000);
  });

  it("in memory: a paused site is paused until its time, then free", () => {
    const store = createPauseStore();
    expect(store.isPaused("mdn", 100)).toBe(false);
    store.pause("mdn", 1000);
    expect(store.isPaused("mdn", 999)).toBe(true);
    expect(store.pausedUntil("mdn", 999)).toBe(1000);
    expect(store.isPaused("mdn", 1000)).toBe(false);
    expect(store.isPaused("govuk", 100)).toBe(false);
  });

  it("with a file: writes {site: pausedUntil} and another store (another process) reads it", () => {
    const file = join(dir, "nested", "state.json");
    createPauseStore(file).pause("hackernews", 5000);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ hackernews: 5000 });
    const other = createPauseStore(file);
    expect(other.isPaused("hackernews", 4000)).toBe(true);
    other.pause("wikipedia", 6000);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ hackernews: 5000, wikipedia: 6000 });
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it("a missing, broken or foreign file is an empty state, and unknown sites are ignored", () => {
    const missing = createPauseStore(join(dir, "nope.json"));
    expect(missing.isPaused("mdn", 1)).toBe(false);

    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json");
    expect(createPauseStore(broken).isPaused("mdn", 1)).toBe(false);

    const odd = join(dir, "odd.json");
    writeFileSync(odd, JSON.stringify({ google: 9e12, mdn: "tomorrow", govuk: 9e12 }));
    const store = createPauseStore(odd);
    expect(store.isPaused("mdn", 1)).toBe(false);
    expect(store.isPaused("govuk", 1)).toBe(true);
  });
});

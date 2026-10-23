import { describe, expect, it } from "vitest";
import { RecentIds } from "./recent-ids";

function ids(maxAgeMs: number, maxIds: number) {
  let now = 0;
  const recent = new RecentIds(maxAgeMs, maxIds, () => now);
  return {
    recent,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("RecentIds", () => {
  it("remembers an id until it is older than the window", () => {
    const { recent, tick } = ids(1000, 100);
    recent.add("a");
    tick(1000);
    expect(recent.has("a")).toBe(true); // exactly at the limit: still inside
    tick(1);
    expect(recent.has("a")).toBe(false);
    expect(recent.size).toBe(0);
  });

  it("measures the window from the first time an id was seen", () => {
    const { recent, tick } = ids(1000, 100);
    recent.add("a");
    tick(600);
    recent.add("a"); // seeing it again does not extend its life
    tick(600);
    expect(recent.has("a")).toBe(false);
  });

  it("drops the oldest ids first when the count limit is exceeded", () => {
    const { recent } = ids(1000, 3);
    for (const id of ["a", "b", "c", "d"]) recent.add(id);
    expect(recent.size).toBe(3);
    expect(recent.has("a")).toBe(false);
    expect(["b", "c", "d"].map((id) => recent.has(id))).toEqual([true, true, true]);
  });

  it("expires only the old ones", () => {
    const { recent, tick } = ids(1000, 100);
    recent.add("old");
    tick(800);
    recent.add("new");
    tick(300);
    expect(recent.has("old")).toBe(false);
    expect(recent.has("new")).toBe(true);
  });

  it("compares ids case-insensitively", () => {
    const { recent } = ids(1000, 100);
    recent.add("6F1C2F0E-8F0A-4C1E-9D55-0D2A7E3C1B11");
    expect(recent.has("6f1c2f0e-8f0a-4c1e-9d55-0d2a7e3c1b11")).toBe(true);
    expect(recent.size).toBe(1);
  });

  it("stays correct over many evictions and compactions of its internal arrays", () => {
    const { recent } = ids(1000, 100);
    for (let i = 0; i < 20_000; i++) recent.add(`id-${i}`);
    expect(recent.size).toBe(100);
    expect(recent.has("id-19899")).toBe(false);
    expect(recent.has("id-19900")).toBe(true);
    expect(recent.has("id-19999")).toBe(true);
    expect(recent.has("id-0")).toBe(false);
  });

  it("expires by age across compactions too", () => {
    const { recent, tick } = ids(1000, 1_000_000);
    for (let i = 0; i < 5000; i++) recent.add(`old-${i}`);
    tick(600);
    for (let i = 0; i < 5000; i++) recent.add(`new-${i}`);
    tick(600); // the old ones are now 1200 ms old, the new ones 600 ms
    expect(recent.has("old-0")).toBe(false);
    expect(recent.has("old-4999")).toBe(false);
    expect(recent.size).toBe(5000);
    expect(recent.has("new-0")).toBe(true);
    expect(recent.has("new-4999")).toBe(true);
    tick(500);
    expect(recent.has("new-0")).toBe(false);
    expect(recent.size).toBe(0);
  });

  it("forgets an id and accepts it again as new", () => {
    const { recent } = ids(1000, 2);
    recent.add("a");
    recent.add("b");
    recent.add("c"); // a goes
    expect(recent.has("a")).toBe(false);
    recent.add("a"); // b goes; a is new again
    expect(recent.has("a")).toBe(true);
    expect(recent.has("b")).toBe(false);
    expect(recent.size).toBe(2);
  });
});

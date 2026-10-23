import { describe, expect, it, vi } from "vitest";
import { createInterruptHandler } from "./interrupt";

function setup(debounceMs?: number) {
  let clock = 10_000;
  const calls: string[] = [];
  const handle = createInterruptHandler(
    {
      onFirst: () => calls.push("first"),
      onForce: () => calls.push("force"),
      onExit: () => calls.push("exit"),
    },
    { now: () => clock, debounceMs },
  );
  return { handle, calls, advance: (ms: number) => (clock += ms) };
}

describe("createInterruptHandler", () => {
  it("one Ctrl+C is the first interrupt", () => {
    const { handle, calls } = setup();
    expect(handle()).toBe("first");
    expect(calls).toEqual(["first"]);
  });

  it("the same Ctrl+C arriving again a few milliseconds later (Windows, wrappers) is ignored", () => {
    const { handle, calls, advance } = setup();
    expect(handle()).toBe("first");
    advance(3);
    expect(handle()).toBe("ignored");
    advance(40);
    expect(handle()).toBe("ignored");
    advance(1900);
    expect(handle()).toBe("ignored"); // 1943 ms after the first: still the same interrupt
    expect(calls).toEqual(["first"]);
  });

  it("a Ctrl+C two seconds or more after the first is a second one: exit now, tidily", () => {
    const { handle, calls, advance } = setup();
    handle();
    advance(2000);
    expect(handle()).toBe("force");
    expect(calls).toEqual(["first", "force"]);
  });

  it("duplicates of the second Ctrl+C are ignored too, and a third one exits at once", () => {
    const { handle, calls, advance } = setup();
    handle();
    advance(2500);
    expect(handle()).toBe("force");
    advance(5);
    expect(handle()).toBe("ignored");
    advance(2000);
    expect(handle()).toBe("exit");
    expect(calls).toEqual(["first", "force", "exit"]);
  });

  it("the window is measured from the last interrupt that counted, not from the last signal", () => {
    // A stream of duplicates must not keep postponing the second interrupt.
    const { handle, calls, advance } = setup();
    handle();
    for (let i = 0; i < 30; i++) {
      advance(90);
      handle(); // 2.7 s of duplicates; the ones after the 2 s mark count as the second interrupt
    }
    expect(calls[0]).toBe("first");
    expect(calls).toContain("force");
  });

  it("the window is configurable", () => {
    const { handle, advance } = setup(500);
    handle();
    advance(499);
    expect(handle()).toBe("ignored");
    advance(1);
    expect(handle()).toBe("force");
  });

  it("works with the real clock too", () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const handle = createInterruptHandler({
        onFirst: () => calls.push("first"),
        onForce: () => calls.push("force"),
        onExit: () => calls.push("exit"),
      });
      handle();
      handle();
      vi.advanceTimersByTime(2000);
      handle();
      expect(calls).toEqual(["first", "force"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

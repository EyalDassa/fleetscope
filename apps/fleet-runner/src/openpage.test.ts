import pino from "pino";
import type { Browser } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { openPage } from "./session-runner";

const log = pino({ level: "silent" });

/** A browser whose first context's newPage fails with `firstError`, then works. */
function fakeBrowser(firstError: Error | null) {
  const closed: number[] = [];
  let contexts = 0;
  const newContext = vi.fn(async (_options: unknown) => {
    const n = ++contexts;
    return {
      newPage: vi.fn(async () => {
        if (n === 1 && firstError) throw firstError;
        return { page: n };
      }),
      close: vi.fn(async () => void closed.push(n)),
    };
  });
  return { browser: { newContext } as unknown as Browser, newContext, closed };
}

describe("openPage", () => {
  it("opens one context with the viewport and one page", async () => {
    const { browser, newContext, closed } = fakeBrowser(null);
    await openPage(browser, log);
    expect(newContext).toHaveBeenCalledTimes(1);
    expect(newContext.mock.calls[0]?.[0]).toMatchObject({ viewport: { width: 1280, height: 720 } });
    expect(closed).toEqual([]);
  });

  it("on a viewport refusal closes the first context before the retry without a viewport (R-M3-06)", async () => {
    const refused = new Error(
      "Protocol error (Emulation.setDeviceMetricsOverride): 'Emulation.setDeviceMetricsOverride' wasn't found",
    );
    const { browser, newContext, closed } = fakeBrowser(refused);
    const page = await openPage(browser, log);
    expect(closed).toEqual([1]);
    expect(newContext).toHaveBeenCalledTimes(2);
    expect(newContext.mock.calls[1]?.[0]).toEqual({ viewport: null });
    expect(page).toEqual({ page: 2 });
  });

  it("does not retry for another unsupported method, and throws the real error", async () => {
    const other = new Error("Protocol error (Page.createIsolatedWorld): 'x' wasn't found");
    const { browser, newContext } = fakeBrowser(other);
    await expect(openPage(browser, log)).rejects.toBe(other);
    expect(newContext).toHaveBeenCalledTimes(1);
  });

  it("does not retry for an unrelated error", async () => {
    const boom = new Error("Target closed");
    const { browser } = fakeBrowser(boom);
    await expect(openPage(browser, log)).rejects.toBe(boom);
  });
});

import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { escapeHtml, PERFETTO_PAGE_SCRIPT, traceFileName } from "./perfetto-page";

/**
 * The page script talks to a window it opens, which a unit test cannot do for real. So it runs here
 * in a sandbox whose `window`, `document` and `fetch` are fakes, and the test plays the part of the
 * browser and of the Perfetto UI.
 */

const PERFETTO = "https://ui.perfetto.dev";

interface Harness {
  /** Click the "Open in Perfetto" button. */
  click(): void;
  /** Let the pending promises (the fetch of the trace) settle. */
  settle(): Promise<void>;
  /** Advance the fake clock. */
  tick(ms: number): void;
  /** The Perfetto UI answers (or something else sends a message to our window). */
  receive(origin: string, data: unknown): void;
  button: { disabled: boolean };
  message: { textContent: string; className: string };
  opened: string[];
  /** Everything posted to the Perfetto window: [data, targetOrigin]. */
  posted: Array<[unknown, string]>;
  listeners: number;
  buffer: ArrayBuffer;
}

function start(options: { fetchStatus?: number; popup?: boolean } = {}): Harness {
  const buffer = new TextEncoder().encode('{"traceEvents":[]}').buffer as ArrayBuffer;
  const posted: Array<[unknown, string]> = [];
  const opened: string[] = [];
  const button = { disabled: true };
  const message = { textContent: "", className: "" };
  const clicks: Array<() => void> = [];
  const listeners: Array<(event: { origin: string; data: unknown }) => void> = [];
  const timers = new Map<number, { every: number | null; at: number; fn: () => void }>();
  let nextTimer = 1;
  let now = 0;

  // the button the script sees is the one we hold, so a change of `disabled` is visible to the test
  const elements: Record<string, unknown> = {
    app: { dataset: { title: "Fleetscope session s1", fileName: "fleetscope-s1.json" } },
    open: Object.assign(button, {
      addEventListener: (_type: string, fn: () => void) => clicks.push(fn),
    }),
    message,
  };
  const win = {
    closed: false,
    postMessage: (data: unknown, origin: string) => posted.push([data, origin]),
  };
  const sandbox = {
    document: { getElementById: (id: string) => elements[id] },
    window: {
      open: (url: string) => {
        opened.push(url);
        return options.popup === false ? null : win;
      },
      addEventListener: (_t: string, fn: (event: { origin: string; data: unknown }) => void) =>
        listeners.push(fn),
      removeEventListener: (_t: string, fn: (event: { origin: string; data: unknown }) => void) => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
    fetch: async (url: string) => {
      expect(url).toBe("./trace");
      const status = options.fetchStatus ?? 200;
      return { ok: status < 400, status, arrayBuffer: async () => buffer };
    },
    setInterval: (fn: () => void, every: number) => {
      timers.set(nextTimer, { every, at: now + every, fn });
      return nextTimer++;
    },
    setTimeout: (fn: () => void, after: number) => {
      timers.set(nextTimer, { every: null, at: now + after, fn });
      return nextTimer++;
    },
    clearInterval: (id: number) => timers.delete(id),
    clearTimeout: (id: number) => timers.delete(id),
    Math,
    Error,
  };
  runInNewContext(PERFETTO_PAGE_SCRIPT, sandbox);

  return {
    click: () => {
      for (const fn of clicks) fn();
    },
    settle: async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    tick: (ms) => {
      const target = now + ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.every === null) timers.delete(id);
        else timer.at += timer.every;
        timer.fn();
      }
      now = target;
    },
    receive: (origin, data) => {
      for (const fn of [...listeners]) fn({ origin, data });
    },
    button,
    message,
    opened,
    posted,
    get listeners() {
      return listeners.length;
    },
    buffer,
  };
}

describe("the Perfetto page script", () => {
  it("fetches the trace first and enables the button only when it has it", async () => {
    const page = start();
    expect(page.button.disabled).toBe(true);
    await page.settle();
    expect(page.button.disabled).toBe(false);
    expect(page.message.textContent).toMatch(/^Trace ready/);
  });

  it("keeps the button disabled and says why when the trace cannot be loaded", async () => {
    const page = start({ fetchStatus: 404 });
    await page.settle();
    expect(page.button.disabled).toBe(true);
    expect(page.message.textContent).toBe("Could not load the trace: HTTP 404");
    expect(page.message.className).toBe("error");
  });

  it("opens ui.perfetto.dev on click, sends PING until it gets PONG, then posts the trace", async () => {
    const page = start();
    await page.settle();
    page.click();
    expect(page.opened).toEqual([PERFETTO]);

    // the UI is not ready: PING every 50 ms, nothing else
    page.tick(160);
    expect(page.posted.map(([data]) => data)).toEqual(["PING", "PING", "PING"]);
    expect(page.posted.every(([, origin]) => origin === PERFETTO)).toBe(true);

    page.receive(PERFETTO, "PONG");
    expect(page.posted).toHaveLength(4);
    const [payload, origin] = page.posted[3] ?? [];
    expect(origin).toBe(PERFETTO);
    expect(payload).toEqual({
      perfetto: {
        buffer: page.buffer,
        title: "Fleetscope session s1",
        fileName: "fleetscope-s1.json",
      },
    });

    // the handshake is over: no more PINGs, and the listener is gone
    page.tick(500);
    expect(page.posted).toHaveLength(4);
    expect(page.listeners).toBe(0);
  });

  it("ignores a PONG from another origin and anything that is not PONG", async () => {
    const page = start();
    await page.settle();
    page.click();
    page.receive("https://evil.example", "PONG");
    page.receive(PERFETTO, "hello");
    page.receive(PERFETTO, { perfetto: {} });
    expect(page.posted.filter(([data]) => typeof data !== "string")).toEqual([]);
    page.tick(60);
    expect(page.posted.at(-1)?.[0]).toBe("PING"); // still waiting
  });

  it("tells the user when the browser blocks the new tab", async () => {
    const page = start({ popup: false });
    await page.settle();
    page.click();
    expect(page.message.textContent).toMatch(/blocked the new tab/);
    expect(page.message.className).toBe("error");
    expect(page.posted).toEqual([]);
  });

  it("gives up after 30 seconds without a PONG and stops pinging", async () => {
    const page = start();
    await page.settle();
    page.click();
    page.tick(30_000);
    expect(page.message.textContent).toMatch(/did not answer/);
    const sent = page.posted.length;
    page.tick(1000);
    expect(page.posted).toHaveLength(sent);
    expect(page.listeners).toBe(0);
  });

  it("does nothing on click before the trace has loaded", async () => {
    const page = start();
    page.click(); // the fetch has not settled yet
    expect(page.opened).toEqual([]);
  });
});

describe("page helpers", () => {
  it("escapeHtml escapes the five characters that matter", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;",
    );
  });

  it("traceFileName keeps only safe characters and a sensible length", () => {
    expect(traceFileName("abc-DEF_1.2")).toBe("fleetscope-abc-DEF_1.2.json");
    expect(traceFileName("../../etc/passwd")).toBe("fleetscope-.._.._etc_passwd.json");
    expect(traceFileName("a b\u0000c\n")).toBe("fleetscope-a_b_c_.json");
    expect(traceFileName("x".repeat(500)).length).toBe("fleetscope-.json".length + 80);
  });
});

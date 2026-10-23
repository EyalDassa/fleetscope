import { describe, expect, it, vi } from "vitest";
import { type CdpSessionLike, HeapSampler, readHeapMb } from "./cdp";
import { silentLogger } from "./test-utils";

const MB = 1024 * 1024;

function heapReply(bytes: number) {
  return {
    metrics: [
      { name: "Nodes", value: 10 },
      { name: "JSHeapUsedSize", value: bytes },
    ],
  };
}

function sampler(open: () => Promise<CdpSessionLike>, samples: (number | null)[], intervalMs = 10) {
  return new HeapSampler({
    open,
    onSample: (mb) => samples.push(mb),
    logger: silentLogger,
    intervalMs,
    callTimeoutMs: 100,
  });
}

describe("readHeapMb", () => {
  it("converts JSHeapUsedSize from bytes to MB", () => {
    expect(readHeapMb(heapReply(3 * MB))).toBe(3);
  });

  it("returns null for anything unusable", () => {
    expect(readHeapMb(null)).toBeNull();
    expect(readHeapMb({})).toBeNull();
    expect(readHeapMb({ metrics: [{ name: "Nodes", value: 1 }] })).toBeNull();
    expect(readHeapMb({ metrics: [{ name: "JSHeapUsedSize", value: "big" }] })).toBeNull();
    expect(readHeapMb({ metrics: [{ name: "JSHeapUsedSize", value: -1 }] })).toBeNull();
  });
});

describe("HeapSampler", () => {
  it("takes a sample at start and then every interval", async () => {
    const samples: (number | null)[] = [];
    const session: CdpSessionLike = {
      send: vi.fn(async (method: string) =>
        method === "Performance.getMetrics" ? heapReply(2 * MB) : {},
      ),
      detach: vi.fn(async () => undefined),
    };
    const s = sampler(async () => session, samples);
    await s.start();
    expect(samples).toEqual([2]);

    await new Promise((resolve) => setTimeout(resolve, 80));
    await s.stop();
    expect(samples.length).toBeGreaterThan(2);
    expect(samples.every((v) => v === 2)).toBe(true);
    expect(session.send).toHaveBeenCalledWith("Performance.enable");
    expect(session.detach).toHaveBeenCalled();
  });

  it("stops sampling after stop()", async () => {
    const samples: (number | null)[] = [];
    const s = sampler(
      async () => ({ send: async () => heapReply(MB), detach: async () => undefined }),
      samples,
    );
    await s.start();
    await s.stop();
    const count = samples.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(samples.length).toBe(count);
  });

  it("an engine without CDP gives one null sample and no crash", async () => {
    const samples: (number | null)[] = [];
    const s = sampler(async () => {
      throw new Error("browserContext.newCDPSession: CDP session is only available in Chromium");
    }, samples);

    await expect(s.start()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(samples).toEqual([null]); // said once, then quiet
    await expect(s.stop()).resolves.toBeUndefined();
  });

  it("an engine that rejects the Performance domain gives one null sample", async () => {
    const samples: (number | null)[] = [];
    const s = sampler(
      async () => ({
        send: async () => {
          throw new Error("'Performance.enable' wasn't found");
        },
        detach: async () => undefined,
      }),
      samples,
    );
    await s.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(samples).toEqual([null]);
  });

  it("a getMetrics that fails later gives null and sampling goes on", async () => {
    const samples: (number | null)[] = [];
    let calls = 0;
    const s = sampler(
      async () => ({
        send: async (method: string) => {
          if (method === "Performance.enable") return {};
          calls++;
          if (calls === 2) throw new Error("Protocol error: Execution context was reset");
          return heapReply(MB);
        },
        detach: async () => undefined,
      }),
      samples,
    );
    await s.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await s.stop();
    expect(samples.slice(0, 3)).toEqual([1, null, 1]);
  });

  it("stops asking once the page is gone", async () => {
    const samples: (number | null)[] = [];
    let calls = 0;
    const s = sampler(
      async () => ({
        send: async (method: string) => {
          if (method === "Performance.enable") return {};
          calls++;
          if (calls > 1) throw new Error("Target page, context or browser has been closed");
          return heapReply(MB);
        },
        detach: async () => {
          throw new Error("already detached");
        },
      }),
      samples,
    );
    await s.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(s.stop()).resolves.toBeUndefined();
    expect(samples).toEqual([1, null]);
  });

  it("a CDP call that never answers times out instead of hanging the scenario", async () => {
    const samples: (number | null)[] = [];
    const s = sampler(() => new Promise<CdpSessionLike>(() => undefined), samples);
    const started = Date.now();
    await s.start();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(samples).toEqual([null]);
  });
});

import { describe, expect, it } from "vitest";
import { frame } from "./fake-stream";
import { cpuPercent, parseStatsFrames } from "./stats";

describe("cpuPercent with Docker's stream", () => {
  it("a later frame uses its previous frame, as before", () => {
    // 0.5 s of CPU time in 4 s of host time on 4 CPUs: 0.5/4 * 4 * 100 = 50 %
    expect(
      cpuPercent(
        frame({
          cpuNs: 2_500_000_000,
          previousCpuNs: 2_000_000_000,
          systemNs: 40_000_000_000,
          previousSystemNs: 36_000_000_000,
        }),
      ),
    ).toBeCloseTo(50, 6);
  });

  it("the first frame has zeros as its previous frame: the answer is the average since the container started", () => {
    const first = frame({
      cpuNs: 1_500_000_000, // 1.5 s of CPU time ...
      systemNs: 40_000_000_000,
      read: "2026-10-23T12:00:03.000000000Z",
    });
    // ... in the 3 s since it started: 50 % of one core
    const startedAtMs = Date.parse("2026-10-23T12:00:00.000Z");
    expect(cpuPercent(first, { startedAtMs })).toBeCloseTo(50, 6);
  });

  it("the first frame without a start time, or with nothing to divide by, is 0 (not nonsense)", () => {
    const first = frame({
      cpuNs: 1_500_000_000,
      systemNs: 40_000_000_000,
      read: "2026-10-23T12:00:03Z",
    });
    expect(cpuPercent(first)).toBe(0);
    expect(cpuPercent(first, { startedAtMs: Date.parse("2026-10-23T12:00:03Z") })).toBe(0);
    expect(cpuPercent(first, { startedAtMs: Date.parse("2026-10-23T12:00:04Z") })).toBe(0); // clock skew
    expect(cpuPercent({ ...first, read: undefined }, { startedAtMs: 0 })).toBe(0);
    expect(cpuPercent({ ...first, read: "not a date" }, { startedAtMs: 0 })).toBe(0);
  });

  it("host-wide counters are never mistaken for a baseline when the previous system figure is zero", () => {
    // Docker's first frame: precpu_stats are all zero. Dividing the totals would give a tiny number.
    const first = frame({ cpuNs: 5_000_000_000, systemNs: 900_000_000_000_000 });
    expect(cpuPercent(first)).toBe(0);
  });
});

describe("parseStatsFrames", () => {
  async function collect(chunks: Array<string | Buffer>) {
    async function* source() {
      for (const chunk of chunks) yield chunk;
    }
    const frames = [];
    for await (const f of parseStatsFrames(source())) frames.push(f);
    return frames;
  }

  it("reads one JSON object per line", async () => {
    const frames = await collect(['{"read":"a"}\n{"read":"b"}\n']);
    expect(frames.map((f) => f.read)).toEqual(["a", "b"]);
  });

  it("puts together a frame that arrives in pieces", async () => {
    const frames = await collect(['{"read":', '"a"}\n{"re', 'ad":"b"}', "\n"]);
    expect(frames.map((f) => f.read)).toEqual(["a", "b"]);
  });

  it("handles Buffers and a multi-byte character cut in the middle", async () => {
    const bytes = Buffer.from('{"read":"café"}\n', "utf8");
    const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of the e-acute
    const frames = await collect([bytes.subarray(0, cut), bytes.subarray(cut)]);
    expect(frames[0]?.read).toBe("café");
  });

  it("skips lines that are not JSON, and a last frame without a newline still counts", async () => {
    const frames = await collect(['not json\n{"read":"a"}\n\n"just a string"\n{"read":"b"}']);
    expect(frames.map((f) => f.read)).toEqual(["a", "b"]);
  });

  it("gives nothing for an empty stream", async () => {
    expect(await collect([])).toEqual([]);
  });
});

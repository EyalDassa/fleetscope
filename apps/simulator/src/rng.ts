/**
 * A small seeded random generator (mulberry32), the same one as the fleet runner: the same seed
 * always gives the same sequence, so `pnpm sim run --seed 7` is repeatable.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Whole number in [min, max], both included. */
  int(min: number, max: number): number;
  /** True with the given probability. */
  chance(probability: number): boolean;
  /** Standard normal (mean 0, sd 1), Box-Muller. */
  normal(): number;
  /** Hex string of `bytes` bytes, from the same sequence (so ids are repeatable too). */
  hex(bytes: number): string;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (probability) => next() < probability,
    normal: () => {
      const u = Math.max(next(), Number.MIN_VALUE);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
    hex: (bytes) => {
      let out = "";
      for (let i = 0; i < bytes; i++)
        out += Math.floor(next() * 256)
          .toString(16)
          .padStart(2, "0");
      return out;
    },
  };
}

/** Seed for session number `index` of a run: different per session, still fixed by the run seed. */
export function sessionSeed(runSeed: number, index: number): number {
  return (runSeed + Math.imul(index + 1, 0x9e3779b1)) >>> 0;
}

// Distributions ---------------------------------------------------------------------------------

/**
 * A positive, right-skewed quantity described by its median and 95th percentile (latencies,
 * durations, memory). It is sampled as a log-normal: ln(x) is normal with mean ln(p50) and a
 * standard deviation chosen so that the 95th percentile comes out at p95 (z = 1.645).
 */
export interface Dist {
  p50: number;
  p95: number;
}

const Z95 = 1.6448536269514722;

export function sampleDist(rng: Rng, dist: Dist): number {
  const p50 = Math.max(dist.p50, 1e-6);
  const sigma = dist.p95 > p50 ? Math.log(dist.p95 / p50) / Z95 : 0.05;
  return p50 * Math.exp(sigma * rng.normal());
}

/** The same, rounded to a whole number and at least `min`. */
export function sampleInt(rng: Rng, dist: Dist, min = 0): number {
  return Math.max(min, Math.round(sampleDist(rng, dist)));
}

/** Median and 95th percentile of some numbers (linear interpolation), or undefined if there are none. */
export function fitDist(values: number[]): Dist | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => {
    const pos = q * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
  };
  return { p50: round(at(0.5)), p95: round(at(0.95)) };
}

export const round = (n: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

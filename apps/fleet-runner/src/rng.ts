/**
 * A small seeded random generator (mulberry32). The same seed always gives the same sequence, which
 * is what makes `pnpm fleet run --seed 7` repeatable: same scenario mix, same pages, same chaos.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Whole number in [min, max], both included. */
  int(min: number, max: number): number;
  /** True with the given probability (0 never, 1 always). */
  chance(probability: number): boolean;
  pick<T>(items: readonly [T, ...T[]]): T;
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
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
  };
}

/** Seed for session number `index` of a run: different per session, still fixed by the run seed. */
export function sessionSeed(runSeed: number, index: number): number {
  return (runSeed + Math.imul(index + 1, 0x9e3779b1)) >>> 0;
}

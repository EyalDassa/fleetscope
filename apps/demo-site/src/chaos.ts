/**
 * Chaos logic, kept free of Fastify so it can be unit tested on its own.
 *
 * Four knobs make the site misbehave like the real web does:
 *   latencyMs   wait this long before answering
 *   errorRate   chance that a page answers 500
 *   botwallRate chance that a page is replaced by a bot wall (403, or a fake CAPTCHA)
 *   flakyRate   chance that the page's main action element is missing from the HTML
 *
 * Each request resolves the four values like this: a query parameter wins over the global
 * setting (POST /admin/chaos), which wins over the page's own default.
 */
import { z } from "zod";

/** No page waits longer than this, whatever the query string or the admin API asks for. */
export const MAX_LATENCY_MS = 30_000;

export interface ChaosSettings {
  latencyMs: number;
  flakyRate: number;
  botwallRate: number;
  errorRate: number;
}

export const CHAOS_KEYS = ["latencyMs", "flakyRate", "botwallRate", "errorRate"] as const;

export const NO_CHAOS: Readonly<ChaosSettings> = {
  latencyMs: 0,
  flakyRate: 0,
  botwallRate: 0,
  errorRate: 0,
};

/** Body of POST /admin/chaos. Unknown keys and out-of-range values are rejected, not clamped. */
export const chaosPatchSchema = z
  .object({
    latencyMs: z.number().min(0).max(MAX_LATENCY_MS),
    flakyRate: z.number().min(0).max(1),
    botwallRate: z.number().min(0).max(1),
    errorRate: z.number().min(0).max(1),
  })
  .partial()
  .strict();

export type ChaosPatch = z.infer<typeof chaosPatchSchema>;

/** The global settings, shared by every request. In memory only: a restart resets them. */
export class ChaosStore {
  private current: ChaosSettings = { ...NO_CHAOS };

  get(): ChaosSettings {
    return { ...this.current };
  }

  /** Merges the given fields into the current settings; fields left out keep their value. */
  patch(patch: ChaosPatch): ChaosSettings {
    for (const key of CHAOS_KEYS) {
      const value = patch[key];
      if (value !== undefined) this.current[key] = value;
    }
    return this.get();
  }

  reset(): ChaosSettings {
    this.current = { ...NO_CHAOS };
    return this.get();
  }
}

/** What a route says about itself: its own defaults, and its short names for the knobs. */
export interface ChaosRoute {
  /** Used when neither the query string nor the global settings set a value (0 counts as unset). */
  defaults?: Partial<ChaosSettings>;
  /** Short query parameter for a knob on this page, e.g. { latencyMs: "ms" } for /slow?ms=. */
  aliases?: Partial<Record<keyof ChaosSettings, string>>;
}

type Query = Record<string, unknown>;

function firstValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return firstValue(value[0]);
  return typeof value === "string" ? value : undefined;
}

/** A finite number from a query parameter, or undefined when it is missing or not a number. */
function parseNumber(value: unknown): number | undefined {
  const text = firstValue(value);
  if (text === undefined || text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Reads an integer query parameter, clamped to [min, max]; `fallback` when absent or invalid. */
export function intParam(
  value: unknown,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  const n = parseNumber(value);
  return n === undefined ? fallback : clamp(Math.trunc(n), min, max);
}

/**
 * Works out the settings that apply to one request. Query values are clamped (rates to 0..1,
 * latency to MAX_LATENCY_MS) and ignored when they are not numbers.
 */
export function resolveSettings(
  query: Query,
  global: ChaosSettings,
  route: ChaosRoute = {},
): ChaosSettings {
  const out: ChaosSettings = { ...NO_CHAOS };
  for (const key of CHAOS_KEYS) {
    const max = key === "latencyMs" ? MAX_LATENCY_MS : 1;
    const alias = route.aliases?.[key];
    const fromQuery = parseNumber(alias ? (query[alias] ?? query[key]) : query[key]);
    if (fromQuery !== undefined) {
      out[key] = clamp(fromQuery, 0, max);
    } else if (global[key] > 0) {
      out[key] = global[key];
    } else {
      out[key] = route.defaults?.[key] ?? 0;
    }
  }
  return out;
}

/** Reads `?seed=N`. Only whole numbers count; anything else is ignored (random behaviour). */
export function parseSeed(value: unknown): number | undefined {
  const text = firstValue(value);
  if (text === undefined || !/^-?\d{1,15}$/.test(text)) return undefined;
  return Number.parseInt(text, 10);
}

/** murmur3's 32-bit finalizer: spreads small, consecutive seeds (1, 2, 3...) over all bits. */
function mix32(value: number): number {
  let h = value >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * mulberry32, a small and fast PRNG. The same seed always gives the same sequence in [0, 1).
 * The seed is mixed first: mulberry32 on its own gives similar first numbers for seeds 1, 2, 3...
 * and people will try exactly those seeds.
 */
export function seededRandom(seed: number): () => number {
  let state = mix32(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type BotwallKind = "forbidden" | "captcha";

export interface ChaosDecision {
  /** The page answers 500. */
  error: boolean;
  /** The page is replaced by a bot wall: HTTP 403, or a 200 page with a fake CAPTCHA. */
  botwall: BotwallKind | null;
  /** The page's main action element is left out of the HTML. */
  flaky: boolean;
}

/**
 * Rolls the dice for one request. It always takes exactly four numbers from `random`, in a fixed
 * order, so a seeded request gives the same outcome however the rates are set. A rate of 0 never
 * fires and a rate of 1 always does, because a draw is in [0, 1).
 */
export function decide(settings: ChaosSettings, random: () => number): ChaosDecision {
  const drawError = random();
  const drawBotwall = random();
  const drawKind = random();
  const drawFlaky = random();
  const botwalled = drawBotwall < settings.botwallRate;
  return {
    error: drawError < settings.errorRate,
    botwall: botwalled ? (drawKind < 0.5 ? "forbidden" : "captcha") : null,
    flaky: drawFlaky < settings.flakyRate,
  };
}

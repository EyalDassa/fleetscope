import type { Engine } from "@fleetscope/schema";
import type { ProfileEngine, ProfileFailure, ProfileScenario } from "./profile";
import type { Dist } from "./rng";

/**
 * What the simulator assumes about an engine that has no (or too few) real sessions in ClickHouse.
 * `pnpm sim calibrate` derives such an engine from Chromium's real numbers with these factors, and
 * switches to the engine's own numbers once it has MIN_REAL_SESSIONS real sessions. So the file is
 * a stopgap that replaces itself; every figure here is an assumption, not a measurement, and the
 * profile says so (`basis: "prior"` and the `note`).
 *
 * Sources of the assumptions (PLAN.md section 3 and the M3 research, Oct 2026):
 *  - Lightpanda claims about 9x less memory than Chrome and a much faster start; it has no
 *    `Performance.getMetrics` (no JS heap), no screenshots, partial Web API coverage (its pages
 *    fail with unsupported_api / unsupported_feature).
 *  - chrome-headless-shell is the old headless Chrome: the same engine without the browser UI
 *    layers, typically 20 to 30% less memory than the new headless Chromium.
 */
export const MIN_REAL_SESSIONS = 10;

export interface Prior {
  note: string;
  startup: number;
  connect: Dist;
  mem: number;
  cpu: number;
  /** Action, page and request latency. */
  latency: number;
  /** Session duration (the scenario takes less or more time). */
  duration: number;
  /** Multiplier of the JS heap, or `null` when the engine cannot report it. */
  heap: number | null;
  bytesReported: number;
  /** Replaces the failures of Chromium per scenario; a scenario not listed keeps Chromium's. */
  failures?: Record<string, ProfileFailure[]>;
}

const failure = (
  p: number,
  status: ProfileFailure["status"],
  error_code: string,
  reason: string,
  at: number,
): ProfileFailure => ({ p, status, error_code, reason, at });

export const PRIORS: Partial<Record<Engine, Prior>> = {
  "chrome-headless-shell": {
    note: "prior: startup x1.0 (the browser launches inside the container, so its time is in startup_ms instead of connect_ms), connect 150 ms, memory x0.75, cpu x0.9, latency x0.95, heap x0.9; failures as Chromium",
    startup: 1.0,
    connect: { p50: 150, p95: 400 },
    mem: 0.75,
    cpu: 0.9,
    latency: 0.95,
    duration: 0.95,
    heap: 0.9,
    bytesReported: 1,
  },
  lightpanda: {
    note: "prior: startup x0.45, connect 40 ms, memory x0.1, cpu x0.35, latency x0.6, no JS heap, half of the request sizes unreported; fails checkout-form and js-heavy pages with unsupported_feature / unsupported_api",
    startup: 0.45,
    connect: { p50: 40, p95: 120 },
    mem: 0.1,
    cpu: 0.35,
    latency: 0.6,
    duration: 0.6,
    heap: null,
    bytesReported: 0.5,
    failures: {
      "checkout-form": [
        failure(
          0.55,
          "failed",
          "unsupported_feature",
          "Page.captureScreenshot is not supported by this engine (-32601)",
          0.5,
        ),
        failure(
          0.2,
          "failed",
          "unsupported_api",
          "TypeError: IntersectionObserver is not defined",
          0.4,
        ),
      ],
      "heavy-page-crawl": [
        failure(
          0.45,
          "failed",
          "unsupported_api",
          "ReferenceError: ResizeObserver is not defined",
          0.5,
        ),
        failure(0.1, "timeout", "timeout", "navigation timeout", 0.6),
      ],
      "login-and-search": [
        failure(0.1, "failed", "unsupported_api", "TypeError: crypto.subtle is undefined", 0.5),
        failure(0.03, "failed", "selector_not_found", "selector not found", 0.5),
      ],
    },
  },
};

const scale = (dist: Dist, factor: number): Dist => ({
  p50: round(dist.p50 * factor),
  p95: round(dist.p95 * factor),
});
const round = (n: number): number => Math.round(n * 100) / 100;

/** A scenario of another engine, from Chromium's. */
export function deriveScenario(
  base: ProfileScenario,
  scenario: string,
  prior: Prior,
): ProfileScenario {
  return {
    duration_ms: scale(base.duration_ms, prior.duration),
    peak_mem_mib: scale(base.peak_mem_mib, prior.mem),
    base_ratio: base.base_ratio,
    steps: base.steps.map((step) => ({
      ...step,
      latency_ms: scale(step.latency_ms, prior.latency),
    })),
    network: {
      ...base.network,
      duration_ms: scale(base.network.duration_ms, prior.latency),
      bytes_reported: prior.bytesReported,
    },
    failures: prior.failures?.[scenario] ?? base.failures,
  };
}

/** An engine without real sessions, from Chromium's real numbers. */
export function deriveEngine(
  base: ProfileEngine,
  prior: Prior,
  engineVersion: string | null,
): ProfileEngine {
  return {
    basis: "prior",
    real_sessions: 0,
    derived_from: "chromium",
    note: prior.note,
    engine_version: engineVersion,
    startup_ms: scale(base.startup_ms, prior.startup),
    connect_ms: prior.connect,
    cpu_pct: scale(base.cpu_pct, prior.cpu),
    heap_mb: prior.heap === null || !base.heap_mb ? null : scale(base.heap_mb, prior.heap),
    scenarios: Object.fromEntries(
      Object.entries(base.scenarios).map(([name, scenario]) => [
        name,
        deriveScenario(scenario, name, prior),
      ]),
    ),
  };
}

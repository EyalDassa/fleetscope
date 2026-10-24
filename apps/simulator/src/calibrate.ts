import type {
  CalibrationAction,
  CalibrationData,
  CalibrationRequest,
  CalibrationSample,
  CalibrationSession,
} from "@fleetscope/db";
import { ENGINES, type Engine, ERROR_CODES, type ErrorCode } from "@fleetscope/schema";
import { deriveEngine, deriveScenario, MIN_REAL_SESSIONS, PRIORS } from "./priors";
import type {
  Profile,
  ProfileEngine,
  ProfileFailure,
  ProfileScenario,
  ProfileStep,
} from "./profile";
import { type Dist, fitDist, round } from "./rng";

/**
 * `pnpm sim calibrate`: reads the REAL sessions (source = 'real') from ClickHouse and writes the
 * distributions the simulator draws from. An engine with fewer than MIN_REAL_SESSIONS real
 * sessions is derived from Chromium's with the documented priors (priors.ts).
 */

// Raw rows come from @fleetscope/db (readCalibrationData); the names below keep the code short.
export type RawSession = CalibrationSession;
export type RawAction = CalibrationAction;
export type RawSample = CalibrationSample;
export type RawRequest = CalibrationRequest;
export type RawData = CalibrationData;

// Pure calculation ----------------------------------------------------------------------------------

const FALLBACK: Dist = { p50: 1, p95: 2 };
const fit = (values: number[]): Dist => fitDist(values) ?? FALLBACK;
const median = (values: number[]): number => fitDist(values)?.p50 ?? 0;

function mode(values: string[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = fallback;
  let bestCount = 0;
  for (const [v, n] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    if (n > bestCount) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

const MIN_SCENARIO_SESSIONS = 3;

/**
 * The engine version of the NEWEST session. Not the most common one: when the runner changes how it
 * reads a version (Lightpanda used to report Chrome's number from browser.version(), now its own from
 * /json/version), older sessions would outvote the right value.
 */
export function latestVersion(sessions: RawSession[]): string | null {
  let newest: RawSession | undefined;
  for (const s of sessions) if (!newest || s.started_at > newest.started_at) newest = s;
  return newest?.engine_version || null;
}

/** The profile of one scenario of one engine, from its real sessions. */
export function scenarioProfile(sessions: RawSession[], data: RawData): ProfileScenario {
  const ids = new Set(sessions.map((s) => s.session_id));
  const ok = sessions.filter((s) => s.status === "success");
  const full = ok.length >= MIN_SCENARIO_SESSIONS ? ok : sessions;
  const fullIds = new Set(full.map((s) => s.session_id));

  // Steps, from the successful sessions (they ran the whole scenario).
  const actions = data.actions.filter((a) => fullIds.has(a.session_id));
  const byType = groupBy(actions, (a) => a.action_type);
  const steps: Array<ProfileStep & { position: number }> = [];
  for (const [type, list] of byType) {
    const doneOk = list.filter((a) => a.ok);
    steps.push({
      action_type: type as ProfileStep["action_type"],
      per_session: round(list.length / full.length),
      target: mode(
        list.map((a) => a.target),
        "localhost",
      ),
      latency_ms: fit((doneOk.length > 0 ? doneOk : list).map((a) => a.duration_ms)),
      position: list.reduce((sum, a) => sum + a.seq, 0) / list.length,
    });
  }
  steps.sort((a, b) => a.position - b.position);
  const planLength = steps.reduce((sum, s) => sum + s.per_session, 0) || 1;

  // Memory: the highest container sample of each session, and where the first one starts.
  const samplesBySession = groupBy(
    data.samples.filter(
      (s) => ids.has(s.session_id) && s.origin === "container" && s.mem_mb !== null,
    ),
    (s) => s.session_id,
  );
  const peaks: number[] = [];
  const ratios: number[] = [];
  for (const list of samplesBySession.values()) {
    const mems = list.map((s) => s.mem_mb as number);
    const peak = Math.max(...mems);
    peaks.push(peak);
    if (peak > 0) ratios.push((mems[0] as number) / peak);
  }

  // Network.
  const requests = data.requests.filter((r) => ids.has(r.session_id));
  const sizes = requests.filter((r) => r.bytes !== null).map((r) => r.bytes as number);
  const typeCounts = groupBy(requests, (r) => r.resource_type);

  // Failures: sessions that ended without success (interrupted ones were left out of the data).
  const failuresByClass = groupBy(
    sessions.filter((s) => s.status !== "success"),
    (s) => {
      const failed = data.actions.find((a) => a.session_id === s.session_id && !a.ok);
      return `${s.status}|${failed?.error_code ?? "unknown"}`;
    },
  );
  const failures: ProfileFailure[] = [];
  for (const [key, list] of failuresByClass) {
    const [status, rawCode] = key.split("|") as [ProfileFailure["status"], string];
    // A code outside the shared vocabulary (an old or foreign row) becomes "unknown".
    const code: ErrorCode = (ERROR_CODES as readonly string[]).includes(rawCode)
      ? (rawCode as ErrorCode)
      : "unknown";
    const ats = list.map((s) => {
      const failed = data.actions.find((a) => a.session_id === s.session_id && !a.ok);
      return failed ? Math.min(1, (failed.seq + 1) / planLength) : 1;
    });
    failures.push({
      p: round(list.length / sessions.length, 4),
      status,
      error_code: code,
      reason: mode(
        list.map((s) => s.reason ?? status),
        status,
      ).slice(0, 200),
      at: round(ats.reduce((sum, v) => sum + v, 0) / ats.length),
    });
  }
  failures.sort((a, b) => b.p - a.p || a.error_code.localeCompare(b.error_code));

  return {
    duration_ms: fit(full.map((s) => s.duration_ms)),
    peak_mem_mib: peaks.length > 0 ? fit(peaks) : { p50: 100, p95: 200 },
    // Real sessions are 1 to 5 s long, so they have one or two samples and the first is often the peak
    // (ratio 1): that says nothing about how memory rises. Cap the start at 80% of the peak so that
    // memory still climbs over a simulated session. An assumption, noted in the profile's method.
    base_ratio: round(Math.min(0.8, Math.max(0.3, median(ratios) || 0.6))),
    steps: steps.map(({ position: _position, ...step }) => step),
    network: {
      requests: round(requests.length / sessions.length),
      domain: mode(
        requests.map((r) => r.domain),
        "localhost",
      ),
      duration_ms: fit(requests.map((r) => r.duration_ms)),
      bytes: fit(sizes),
      bytes_reported: requests.length === 0 ? 1 : round(sizes.length / requests.length),
      resource_types: Object.fromEntries(
        [...typeCounts].sort(([a], [b]) => a.localeCompare(b)).map(([t, list]) => [t, list.length]),
      ),
    },
    failures,
  };
}

/** The profile of an engine from its own real sessions, or undefined if there are too few. */
export function engineProfile(
  engine: Engine,
  data: RawData,
  fallbackFor: (scenario: string) => ProfileScenario | undefined,
): ProfileEngine | undefined {
  const sessions = data.sessions.filter((s) => s.engine === engine);
  if (sessions.length < MIN_REAL_SESSIONS) return undefined;
  const ids = new Set(sessions.map((s) => s.session_id));
  const heaps = data.samples
    .filter((s) => ids.has(s.session_id) && s.origin === "cdp" && s.js_heap_mb !== null)
    .map((s) => s.js_heap_mb as number);
  const cpus = data.samples
    .filter((s) => ids.has(s.session_id) && s.origin === "container" && s.cpu_pct !== null)
    .map((s) => s.cpu_pct as number);
  const scenarios: Record<string, ProfileScenario> = {};
  for (const [name, list] of groupBy(sessions, (s) => s.scenario)) {
    const own =
      list.length >= MIN_SCENARIO_SESSIONS ? scenarioProfile(list, data) : fallbackFor(name);
    if (own) scenarios[name] = own;
  }
  return {
    basis: "measured",
    real_sessions: sessions.length,
    note: `measured from ${sessions.length} real sessions`,
    engine_version: latestVersion(sessions),
    startup_ms: fit(sessions.map((s) => s.startup_ms)),
    connect_ms: fit(sessions.map((s) => s.connect_ms)),
    cpu_pct: fit(cpus),
    heap_mb: heaps.length > 0 ? fit(heaps) : null,
    scenarios,
  };
}

/** The whole profile. Throws if Chromium itself has too few real sessions to start from. */
export function buildProfile(data: RawData, now: Date = new Date()): Profile {
  const chromium = engineProfile("chromium", data, () => undefined);
  if (!chromium) {
    throw new Error(
      `need at least ${MIN_REAL_SESSIONS} real chromium sessions to calibrate (run pnpm fleet run first)`,
    );
  }
  const engines = { chromium } as Record<Engine, ProfileEngine>;
  for (const engine of ENGINES) {
    if (engine === "chromium") continue;
    const prior = PRIORS[engine];
    if (!prior) throw new Error(`no prior for ${engine}`);
    const derived = (scenario: string): ProfileScenario | undefined => {
      const base = chromium.scenarios[scenario];
      return base ? deriveScenario(base, scenario, prior) : undefined;
    };
    const own = engineProfile(engine, data, derived);
    engines[engine] =
      own ??
      deriveEngine(
        chromium,
        prior,
        latestVersion(data.sessions.filter((s) => s.engine === engine)),
      );
  }
  const counts = ENGINES.map((e) => `${e} ${engines[e].real_sessions}`).join(", ");
  return {
    version: 1,
    generated_at: now.toISOString(),
    method: `pnpm sim calibrate: distributions (median and 95th percentile, sampled log-normal) of the real sessions (source='real', interrupted and running left out) in the local ClickHouse. Real sessions per engine: ${counts}. An engine with fewer than ${MIN_REAL_SESSIONS} gets Chromium's numbers with the priors of apps/simulator/src/priors.ts (basis: "prior"). Memory starts at most 80% of the way to the peak (real sessions are too short to show the climb). Failure mixes of real Chromium runs include the fleet runner's chaos mode, so they are not the failure rate of the web.`,
    engines,
  };
}

import { randomUUID } from "node:crypto";
import {
  type CollectedSession,
  type Collector,
  isUnsupportedFeatureError,
} from "@fleetscope/collector";
import type { Engine, SessionStatus } from "@fleetscope/schema";
import type { Logger } from "pino";
import { type Browser, chromium, type Page } from "playwright-core";
import type { RunnerConfig } from "./config";
import type { BrowserContainer, DockerFleet } from "./docker";
import { classifyOutcome } from "./outcome";
import { createRng } from "./rng";
import { SCENARIOS, type ScenarioName } from "./scenarios";
import { StatsSampler } from "./stats";

export interface SessionSpec {
  index: number;
  engine: Engine;
  scenario: ScenarioName;
  /** Seeds the scenario's random choices. */
  seed: number;
}

export interface SessionDeps {
  fleet: DockerFleet;
  /** The collector for this engine. */
  collector: Collector;
  config: RunnerConfig;
  sessionTimeoutMs: number;
  logger: Logger;
  /** Aborted by Ctrl+C. */
  signal: AbortSignal;
  /**
   * Sessions that have started and not yet ended. The runner adds and removes them; the "exit now"
   * path of the CLI ends whatever is still in it before it flushes, so no finished or running
   * session stays `running` in the database.
   */
  live?: Set<CollectedSession>;
}

/**
 * What the runner knows about a session. Besides the reported statuses: `infra_error` means the
 * container or browser never came up, `interrupted` means Ctrl+C came before it did. Neither has a
 * session to report.
 */
export type ResultStatus = SessionStatus | "infra_error" | "interrupted";

/** True if the session ran and was reported to the API (so it has a duration and actions). */
export const wasReported = (status: ResultStatus): boolean =>
  status !== "infra_error" && status !== "interrupted";

export interface SessionResult {
  index: number;
  sessionId: string;
  engine: Engine;
  scenario: ScenarioName;
  status: ResultStatus;
  reason: string | null;
  /** The session's own duration (what `session.ended` carries). 0 if it was never reported. */
  durationMs: number;
  startupMs: number | null;
  /** Playwright connect time. With `startupMs` it is the time until the browser is usable. */
  connectMs: number | null;
  actions: number;
  failedActions: number;
  /** Highest container memory reading, `null` if there was none. */
  peakMemMb: number | null;
}

const VIEWPORT = { width: 1280, height: 720 };

/** Playwright's own server takes `connect`; every other engine speaks plain CDP. */
function connectBrowser(container: BrowserContainer): Promise<Browser> {
  const options = { timeout: CONNECT_TIMEOUT_MS };
  return container.connectMode === "playwright-server"
    ? chromium.connect(container.endpoint, options)
    : chromium.connectOverCDP(container.endpoint, options);
}

/**
 * A fresh context and one page. Always `newContext()`, never `contexts()[0]`: Lightpanda allows one
 * context and one page per CDP connection, and a fresh context is what the other engines get too.
 * Viewport emulation is a CDP call some engines refuse; then the page runs with the engine's
 * default viewport (logged, not hidden).
 */
async function openPage(browser: Browser, log: Logger): Promise<Page> {
  try {
    return await (await browser.newContext({ viewport: VIEWPORT })).newPage();
  } catch (error) {
    if (!isUnsupportedFeatureError(error as Error)) throw error;
    log.warn({ err: error }, "engine refused viewport emulation, using its default viewport");
    return await (await browser.newContext({ viewport: null })).newPage();
  }
}
const CONNECT_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5000;

/** Runs `promise`, but gives up waiting after `ms`. Never rejects. */
async function bounded(promise: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (!promise) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * One session, start to finish:
 *  1. start a fresh container and wait for the Playwright server (`startup_ms`)
 *  2. connect to it (`connect_ms`) and tell the collector the session started
 *  3. sample Docker's stats stream every 2 s while the scenario runs
 *  4. take the last sample, report the session's status, close the browser, remove the container
 *
 * The container is removed whatever happens. If the browser never came up, nothing is reported
 * (there is no `startup_ms`/`connect_ms` to put in `session.started`) and the result is `infra_error`.
 */
export async function runSession(deps: SessionDeps, spec: SessionSpec): Promise<SessionResult> {
  const sessionId = randomUUID();
  const log = deps.logger.child({ sessionId, index: spec.index, scenario: spec.scenario });
  const result: SessionResult = {
    index: spec.index,
    sessionId,
    engine: spec.engine,
    scenario: spec.scenario,
    status: "infra_error",
    reason: null,
    durationMs: 0,
    startupMs: null,
    connectMs: null,
    actions: 0,
    failedActions: 0,
    peakMemMb: null,
  };

  let container: BrowserContainer | undefined;
  let browser: Browser | undefined;
  let session: CollectedSession | undefined;
  // True once we close the browser ourselves, so its "disconnected" event is not a crash.
  let closingByUs = false;
  const closeBrowser = (): Promise<void> | undefined => {
    closingByUs = true;
    session?.beginShutdown(); // the action this cuts off is not a crash either
    return browser?.close();
  };

  // Phase 1: infrastructure. A failure here leaves nothing to report.
  let connectMs = 0;
  try {
    container = await deps.fleet.startBrowser({ sessionId, signal: deps.signal });
    result.startupMs = Math.round(container.startupMs);
    const connectStart = performance.now();
    browser = await connectBrowser(container);
    connectMs = performance.now() - connectStart;
    result.connectMs = Math.round(connectMs);
    if (deps.signal.aborted) throw new Error("interrupted before the session started");
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
    if (deps.signal.aborted) {
      result.status = "interrupted";
      log.warn({ reason: result.reason }, "interrupted before the session started");
    } else {
      log.error({ err: error }, "could not get a browser, session not reported");
    }
    await bounded(closeBrowser(), CLOSE_TIMEOUT_MS);
    await bounded(container?.remove(), CLOSE_TIMEOUT_MS * 3);
    return result;
  }

  // Phase 2: the session.
  let disconnected = false;
  let timedOut = false;
  browser.on("disconnected", () => {
    if (!closingByUs) disconnected = true;
  });
  const started = deps.collector.startSession({
    sessionId,
    scenario: spec.scenario,
    region: "local",
    // Lightpanda answers CDP's Browser.getVersion as a Chrome; its own number is in /json/version.
    engineVersion: container.engineVersion ?? browser.version(),
    startupMs: container.startupMs,
    connectMs,
  });
  session = started;
  deps.live?.add(started);
  // Docker's stats stream: the first frame arrives at once, so even a short session is measured.
  // The first sample's CPU is the container's average since it started, which includes the launch.
  const stats = new StatsSampler({
    openStream: container.openStatsStream,
    containerStartedAtMs: container.startedAtMs,
    onSample: (sample) => started.recordContainerSample(sample),
    logger: log,
  });
  stats.start();
  const onAbort = () => void bounded(closeBrowser(), CLOSE_TIMEOUT_MS); // unblocks a running action
  deps.signal.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => {
    timedOut = true;
    void bounded(closeBrowser(), CLOSE_TIMEOUT_MS);
  }, deps.sessionTimeoutMs);

  let error: unknown;
  try {
    const page = await started.collectPage(await openPage(browser, log));
    await SCENARIOS[spec.scenario](page, {
      baseUrl: deps.config.demoSiteBrowserUrl,
      rng: createRng(spec.seed),
      logger: log,
    });
  } catch (caught) {
    error = caught ?? new Error("scenario failed");
  }

  const outcome = classifyOutcome({
    error,
    interrupted: deps.signal.aborted,
    timedOut,
    sessionTimeoutMs: deps.sessionTimeoutMs,
    disconnected,
  });

  clearTimeout(deadline);
  deps.signal.removeEventListener("abort", onAbort);
  await finishSession(started, stats, outcome);
  deps.live?.delete(started);
  await bounded(closeBrowser(), CLOSE_TIMEOUT_MS);
  await bounded(container.remove(), CLOSE_TIMEOUT_MS * 3);

  log.info(
    { status: outcome.status, reason: outcome.reason, actions: started.actionCount },
    "session finished",
  );
  return {
    ...result,
    status: outcome.status,
    reason: outcome.reason,
    durationMs: sessionDurationMs(started),
    actions: started.actionCount,
    failedActions: started.failedActions,
    peakMemMb: stats.sampleCount > 0 ? stats.peakMemMb : null,
  };
}

/**
 * Ends a session in the order that keeps its data whole: the last container reading first (awaited,
 * so a session of half a second still has a measurement), then `session.ended`, which is therefore
 * always the final event of the session.
 */
export async function finishSession(
  session: Pick<CollectedSession, "endSession">,
  sampler: Pick<StatsSampler, "stop">,
  outcome: { status: SessionStatus; reason: string | null },
): Promise<void> {
  await sampler.stop();
  await session.endSession(outcome.status, outcome.reason);
}

function sessionDurationMs(session: CollectedSession): number {
  return session.durationMs ?? 0;
}

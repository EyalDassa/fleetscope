import {
  type ActionType,
  type EventEnvelope,
  type EventFields,
  type EventType,
  type IssueKind,
  newEvent,
  type SessionStatus,
} from "@fleetscope/schema";
import type { Logger } from "pino";
import type { Page } from "playwright-core";
import type { ErrorCode } from "./codes";
import { CollectedPage, type PageConfig, type PageSink } from "./page";
import type { EventQueue } from "./queue";

export interface StartSessionOptions {
  /** Defaults to a fresh UUID. */
  sessionId?: string;
  scenario: string;
  region: string;
  /** `null` when the engine does not report a version. */
  engineVersion: string | null;
  /** Milliseconds from asking for the browser to it being ready. */
  startupMs: number;
  /** Milliseconds to connect the client to it. */
  connectMs: number;
}

/** The numbers the runner takes from Docker for one container, one moment. */
export interface ContainerSample {
  cpuPct: number;
  memMb: number;
  netRxBytes: number;
  netTxBytes: number;
}

const MAX_LABEL = 128;
const MAX_TEXT = 2000;
const clip = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

/**
 * One browser session. Created by `collector.startSession()`, which has already queued
 * `session.started`. Give it pages with `collectPage()`, feed it container samples, and finish with
 * `endSession()`, which queues `session.ended` and closes the session: nothing is recorded after it,
 * so `session.ended` is always the last event of a session.
 */
export class CollectedSession implements PageSink {
  readonly sessionId: string;
  private readonly envelope: EventEnvelope;
  private readonly startedAt = Date.now();
  private readonly pages = new Set<CollectedPage>();
  private readonly issues = new Set<IssueKind>();
  private readonly seenOnce = new Set<string>();
  private seq = 0;
  private failedActionCount = 0;
  private ended = false;
  private recordedDurationMs: number | null = null;

  constructor(
    envelope: Omit<EventEnvelope, "session_id">,
    private readonly queue: EventQueue,
    private readonly config: PageConfig,
    private readonly logger: Logger,
    options: StartSessionOptions,
  ) {
    this.sessionId = options.sessionId ?? crypto.randomUUID();
    this.envelope = { ...envelope, session_id: this.sessionId };
    this.emit(
      "session.started",
      {
        engine_version:
          options.engineVersion === null ? null : clip(options.engineVersion, MAX_LABEL),
        scenario: clip(options.scenario, MAX_LABEL),
        region: clip(options.region, MAX_LABEL),
        startup_ms: wholeMs(options.startupMs),
        connect_ms: wholeMs(options.connectMs),
      },
      this.startedAt,
    );
  }

  /** Kinds of issue raised so far (e.g. `blocked`, `captcha`). The runner reads this to pick a status. */
  get issueKinds(): ReadonlySet<IssueKind> {
    return this.issues;
  }

  get actionCount(): number {
    return this.seq;
  }

  get failedActions(): number {
    return this.failedActionCount;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** The `duration_ms` sent with `session.ended`; `null` until the session has ended. */
  get durationMs(): number | null {
    return this.recordedDurationMs;
  }

  /** Wraps a Playwright page. Its actions, errors, requests and JS heap are recorded here. */
  async collectPage(page: Page): Promise<CollectedPage> {
    const collected = await CollectedPage.attach(page, this, this.config);
    this.pages.add(collected);
    // The session may have ended while the heap sampler was starting.
    if (this.ended) await collected.dispose();
    return collected;
  }

  /** Records one Docker stats reading as a `resource.sample` with `origin: "container"`. */
  recordContainerSample(sample: ContainerSample): void {
    this.emit("resource.sample", {
      origin: "container",
      cpu_pct: sample.cpuPct,
      mem_mb: sample.memMb,
      net_rx_bytes: Math.round(sample.netRxBytes),
      net_tx_bytes: Math.round(sample.netTxBytes),
    });
  }

  /**
   * Queues `session.ended` and closes the session. Duration is measured from `startSession`
   * (browser startup is reported separately as `startup_ms`). Calling it twice does nothing.
   */
  async endSession(status: SessionStatus, reason: string | null = null): Promise<void> {
    if (this.ended) return;
    const endedAt = Date.now();
    const durationMs = wholeMs(endedAt - this.startedAt);
    this.emit(
      "session.ended",
      {
        status,
        reason: reason === null ? null : clip(reason, MAX_TEXT),
        duration_ms: durationMs,
      },
      endedAt,
    );
    this.recordedDurationMs = durationMs;
    this.ended = true;
    await Promise.allSettled([...this.pages].map((page) => page.dispose()));
  }

  // PageSink: called by CollectedPage ---------------------------------------------------------

  nextSeq(): number {
    return this.seq++;
  }

  recordAction(action: {
    seq: number;
    startedAt: number;
    type: ActionType;
    target: string;
    durationMs: number;
    ok: boolean;
    errorCode: ErrorCode | null;
  }): void {
    if (!action.ok) this.failedActionCount++;
    this.emit(
      "action",
      {
        seq: action.seq,
        action_type: action.type,
        target: clip(action.target, MAX_TEXT),
        duration_ms: wholeMs(action.durationMs),
        ok: action.ok,
        error_code: action.errorCode,
      },
      action.startedAt,
    );
  }

  recordIssue(kind: IssueKind, message: string, options: { once?: boolean } = {}): void {
    if (this.ended) return;
    if (options.once) {
      const key = `${kind}:${message}`;
      if (this.seenOnce.has(key)) return;
      this.seenOnce.add(key);
    }
    this.issues.add(kind);
    this.emit("issue", { kind, message: clip(message, MAX_TEXT) });
  }

  recordNetwork(request: {
    domain: string;
    status: number | null;
    bytes: number | null;
    durationMs: number;
    resourceType: string;
  }): void {
    const validStatus =
      request.status !== null && request.status >= 100 && request.status <= 599
        ? request.status
        : null;
    this.emit("network.request", {
      domain: clip(request.domain, MAX_LABEL),
      status: validStatus,
      bytes: request.bytes,
      duration_ms: wholeMs(request.durationMs),
      resource_type: clip(request.resourceType || "other", MAX_LABEL),
    });
  }

  recordCdpSample(jsHeapMb: number | null): void {
    this.emit("resource.sample", {
      origin: "cdp",
      cpu_pct: null,
      mem_mb: null,
      net_rx_bytes: null,
      net_tx_bytes: null,
      js_heap_mb: jsHeapMb,
    });
  }

  // ------------------------------------------------------------------------------------------

  private emit<T extends EventType>(type: T, fields: EventFields<T>, ts = Date.now()): void {
    if (this.ended) {
      this.logger.debug({ type, sessionId: this.sessionId }, "event after session end, dropped");
      return;
    }
    this.queue.push(newEvent(type, this.envelope, fields, ts));
  }
}

/** Durations must be whole, non-negative numbers that fit the schema. */
function wholeMs(ms: number): number {
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
}

import type { Engine, EventEnvelope, Source } from "@fleetscope/schema";
import { type Logger, pino } from "pino";
import { EventQueue, type QueueStats } from "./queue";
import { CollectedSession, type StartSessionOptions } from "./session";
import { assertSafeLabel } from "./text";
import { createHttpTransport, type Transport } from "./transport";

export interface CollectorOptions {
  /** Base URL of the Fleetscope API, e.g. `http://localhost:4000`. Ignored if `transport` is given. */
  apiUrl: string;
  source: Source;
  agentId: string;
  /** Where the browsers run, e.g. `local-docker`. */
  provider: string;
  engine: Engine;
  /** Replaces the HTTP transport (tests, or a collector that writes somewhere else). */
  transport?: Transport;
  logger?: Logger;
  /** Record one `network.request` out of every N. Default 5. */
  networkSampleEvery?: number;
  /** JS heap sampling period in ms; 0 turns it off. Default 2000. */
  heapSampleIntervalMs?: number;
  /** Default timeout for click, fill, extract, wait. Default 10 000 ms. */
  actionTimeoutMs?: number;
  /** Default timeout for goto. Default 30 000 ms. */
  navigationTimeoutMs?: number;
  /** Send as soon as this many events are waiting. Default 500. */
  flushSize?: number;
  /** Otherwise send what is waiting this often. Default 1000 ms. */
  flushIntervalMs?: number;
}

export interface Collector {
  /** Queues `session.started` and returns the session. */
  startSession(options: StartSessionOptions): CollectedSession;
  /** Resolves when everything recorded so far has been sent (or given up on). */
  flush(): Promise<void>;
  /** Flushes, then stops. Gives up after `timeoutMs` (default 10 000) and counts what was lost. */
  close(timeoutMs?: number): Promise<void>;
  stats(): QueueStats;
}

/**
 * One collector per process. It owns the in-order event queue; every session and page created from
 * it records into that queue, and the queue ships batches to the API in the background.
 */
export function createCollector(options: CollectorOptions): Collector {
  // The API refuses an event with another kind of value, for the whole batch (see SAFE_LABEL_PATTERN).
  assertSafeLabel("agentId", options.agentId);
  assertSafeLabel("provider", options.provider);
  const logger =
    options.logger ?? pino({ name: "collector", level: process.env.LOG_LEVEL ?? "info" });
  const transport = options.transport ?? createHttpTransport({ apiUrl: options.apiUrl, logger });
  const queue = new EventQueue({
    transport,
    logger,
    flushSize: options.flushSize,
    flushIntervalMs: options.flushIntervalMs,
  });
  const envelope: Omit<EventEnvelope, "session_id"> = {
    source: options.source,
    agent_id: options.agentId,
    engine: options.engine,
    provider: options.provider,
  };
  const pageConfig = {
    logger,
    actionTimeoutMs: options.actionTimeoutMs ?? 10_000,
    navigationTimeoutMs: options.navigationTimeoutMs ?? 30_000,
    networkSampleEvery: Math.max(1, options.networkSampleEvery ?? 5),
    heapSampleIntervalMs: options.heapSampleIntervalMs ?? 2000,
  };

  return {
    startSession: (start) => new CollectedSession(envelope, queue, pageConfig, logger, start),
    flush: () => queue.flush(),
    close: (timeoutMs) => queue.close(timeoutMs),
    stats: () => queue.stats(),
  };
}

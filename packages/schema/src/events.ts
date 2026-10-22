import { z } from "zod";

/**
 * Fleetscope event schema, version 1 (PLAN.md section 5).
 *
 * This file is the only definition of event shapes. Everything else (collector, api, db,
 * simulator, mcp) imports from here.
 *
 * Honesty rule: a metric an engine cannot report is `null`, never a made-up number.
 */

export const SCHEMA_VERSION = 1 as const;

/** Largest batch accepted by `POST /v1/events`. */
export const MAX_BATCH_SIZE = 1000;

/**
 * The three engines of the fleet (PLAN.md section 3). These slugs are stable: they are stored in
 * ClickHouse and used in URLs and filters.
 *  - `chromium`              Playwright Chromium (the baseline)
 *  - `chrome-headless-shell` Google's headless-shell build (chromedp/headless-shell)
 *  - `lightpanda`            Lightpanda, built for AI agents
 */
export const ENGINES = ["chromium", "chrome-headless-shell", "lightpanda"] as const;
export const Engine = z.enum(ENGINES);
export type Engine = z.infer<typeof Engine>;

/** Where an event comes from. The UI must never present "sim" data as real. */
export const SOURCES = ["real", "sim"] as const;
export const Source = z.enum(SOURCES);
export type Source = z.infer<typeof Source>;

export const SESSION_STATUSES = ["success", "failed", "blocked", "timeout", "crashed"] as const;
export const SessionStatus = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const ACTION_TYPES = [
  "goto",
  "click",
  "fill",
  "extract",
  "screenshot",
  "wait",
  "eval",
] as const;
export const ActionType = z.enum(ACTION_TYPES);
export type ActionType = z.infer<typeof ActionType>;

/** `container` = measured outside by the Docker stats API, `cdp` = measured inside the browser. */
export const RESOURCE_ORIGINS = ["container", "cdp"] as const;
export const ResourceOrigin = z.enum(RESOURCE_ORIGINS);
export type ResourceOrigin = z.infer<typeof ResourceOrigin>;

export const ISSUE_KINDS = [
  "blocked",
  "captcha",
  "crash",
  "timeout",
  "nav_error",
  "unsupported_api",
] as const;
export const IssueKind = z.enum(ISSUE_KINDS);
export type IssueKind = z.infer<typeof IssueKind>;

// Small building blocks -------------------------------------------------------------------

const id = z.string().min(1).max(128);
const label = z.string().min(1).max(128);
const text = z.string().max(2000);
/** Whole number >= 0 (durations in ms, byte counts, sequence numbers). */
const count = z.int().nonnegative();
/** Real number >= 0 (percentages, megabytes). */
const amount = z.number().nonnegative().finite();

/** Fields every event carries. `ts` is milliseconds since the Unix epoch. */
const envelope = {
  v: z.literal(SCHEMA_VERSION),
  /** Unique per event; the API drops duplicates so client retries are safe. */
  event_id: z.uuid(),
  ts: count,
  session_id: id,
  source: Source,
  agent_id: id,
  engine: Engine,
  /** Where the browser runs, e.g. "local-docker". Free text so new providers need no release. */
  provider: label,
};

// Events ----------------------------------------------------------------------------------

export const SessionStartedEvent = z.object({
  ...envelope,
  type: z.literal("session.started"),
  /** `null` when the engine does not report its version. */
  engine_version: label.nullable(),
  scenario: label,
  region: label,
  /** Time to start the browser. */
  startup_ms: count,
  /** Time to connect the client (CDP / Playwright) to it. */
  connect_ms: count,
});
export type SessionStartedEvent = z.infer<typeof SessionStartedEvent>;

export const SessionEndedEvent = z.object({
  ...envelope,
  type: z.literal("session.ended"),
  status: SessionStatus,
  /** Human-readable cause, `null` on plain success. */
  reason: text.nullable(),
  duration_ms: count,
});
export type SessionEndedEvent = z.infer<typeof SessionEndedEvent>;

export const ActionEvent = z.object({
  ...envelope,
  type: z.literal("action"),
  /** Position of the action inside its session, starting at 0. */
  seq: count,
  /** Named `action_type` because `type` is the event discriminator. */
  action_type: ActionType,
  /** Selector or domain the action works on. */
  target: text,
  duration_ms: count,
  ok: z.boolean(),
  /** `null` when `ok` is true. */
  error_code: label.nullable(),
});
export type ActionEvent = z.infer<typeof ActionEvent>;

export const ResourceSampleEvent = z.object({
  ...envelope,
  type: z.literal("resource.sample"),
  cpu_pct: amount,
  mem_mb: amount,
  net_rx_bytes: count,
  net_tx_bytes: count,
  /** JS heap size via CDP. `null` when the engine does not support it, absent on container samples. */
  js_heap_mb: amount.nullable().optional(),
  origin: ResourceOrigin,
});
export type ResourceSampleEvent = z.infer<typeof ResourceSampleEvent>;

export const NetworkRequestEvent = z.object({
  ...envelope,
  type: z.literal("network.request"),
  domain: label,
  /** HTTP status; `null` when the request failed before a response arrived. */
  status: z.int().min(100).max(599).nullable(),
  /** Transferred bytes; `null` when the engine does not report it. */
  bytes: count.nullable(),
  duration_ms: count,
  /** Free text such as "document", "script", "xhr". Requests are sampled, not exhaustive. */
  resource_type: label,
});
export type NetworkRequestEvent = z.infer<typeof NetworkRequestEvent>;

export const IssueEvent = z.object({
  ...envelope,
  type: z.literal("issue"),
  kind: IssueKind,
  message: text,
});
export type IssueEvent = z.infer<typeof IssueEvent>;

export const ScreenshotEvent = z.object({
  ...envelope,
  type: z.literal("screenshot"),
  /** The `seq` of the action that took the screenshot. */
  action_seq: count,
  /** Where the image is stored (local path or object storage). Optional. */
  url: z.string().min(1).max(2048).optional(),
});
export type ScreenshotEvent = z.infer<typeof ScreenshotEvent>;

// Union and batch -------------------------------------------------------------------------

export const EVENT_TYPES = [
  "session.started",
  "session.ended",
  "action",
  "resource.sample",
  "network.request",
  "issue",
  "screenshot",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Any event, discriminated on `type`. */
export const FleetEvent = z.discriminatedUnion("type", [
  SessionStartedEvent,
  SessionEndedEvent,
  ActionEvent,
  ResourceSampleEvent,
  NetworkRequestEvent,
  IssueEvent,
  ScreenshotEvent,
]);
export type FleetEvent = z.infer<typeof FleetEvent>;

/** Body of `POST /v1/events`: 1 to 1,000 events. */
export const EventBatch = z.array(FleetEvent).min(1).max(MAX_BATCH_SIZE);
export type EventBatch = z.infer<typeof EventBatch>;

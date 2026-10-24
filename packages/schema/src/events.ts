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
 * How many days raw events are kept. This is the `TTL toDate(ts) + INTERVAL 30 DAY` of the raw
 * tables in infra/clickhouse (a db integration test checks that they agree). The API uses it to
 * refuse events that ClickHouse would delete right after storing them.
 */
export const RETENTION_DAYS = 30;

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

/**
 * State of a stored session: "running" until a `session.ended` arrives, then its final status.
 * "running" is never sent in an event; it only exists in stored data and API responses.
 */
export const SESSION_RUNNING = "running" as const;
export const SESSION_STATES = [SESSION_RUNNING, ...SESSION_STATUSES] as const;
export const SessionState = z.enum(SESSION_STATES);
export type SessionState = z.infer<typeof SessionState>;

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

/*
 * Strings. ClickHouse cannot store a lone UTF-16 surrogate (half of an emoji): JSON.stringify
 * sends it as the escape \ud83d, and the INSERT then fails with CANNOT_PARSE_ESCAPE_SEQUENCE on
 * every retry. A page can produce one on purpose (`throw new Error("\ud800")`) and cutting a text
 * by UTF-16 units can leave one by accident. So:
 *  - free text (labels, targets, messages, urls) is repaired: each lone surrogate becomes U+FFFD,
 *    the length stays the same, and the event is kept, because text that a page produced should not
 *    sink a whole batch;
 *  - ids (session_id, agent_id) are rejected instead, because a changed id would silently split or
 *    merge sessions.
 * `toWellFormed` is in Node 20+ and every current browser, but not in the ES2023 lib that
 * tsconfig.base.json uses, hence the small typed wrapper.
 */
type WithWellFormed = { isWellFormed(): boolean; toWellFormed(): string };
const isWellFormed = (value: string): boolean =>
  (value as unknown as WithWellFormed).isWellFormed();
const wellFormed = (value: string): string => (value as unknown as WithWellFormed).toWellFormed();

const id = z
  .string()
  .min(1)
  .max(128)
  .refine(isWellFormed, { error: "must not contain an unpaired UTF-16 surrogate" });
const label = z.string().min(1).max(128).transform(wellFormed);
const text = z.string().max(2000).transform(wellFormed);
/*
 * Numeric bounds mirror the ClickHouse column types (infra/clickhouse). A value the column cannot
 * hold would be silently wrapped or turned into NULL, so it is rejected here instead.
 */
const UINT32_MAX = 4_294_967_295;
/** Whole number that fits a UInt32 column (durations in ms, sequence numbers). About 49.7 days in ms. */
const uint32 = z.int().nonnegative().max(UINT32_MAX);
/** Whole number for UInt64 columns (byte counters). zod ints are safe integers, so at most 2^53 - 1. */
const uint64 = z.int().nonnegative();
/** Real number for Float32 columns, with a finite upper bound far above any real measurement. */
const float32 = (max: number) => z.number().nonnegative().max(max);

/** Largest plausible readings. Docker's CPU % can pass 100 on multi-core containers. */
const MAX_CPU_PCT = 100_000;
const MAX_MEMORY_MB = 16_777_216; // 16 TiB
/** `ts` window in epoch ms: [2020-01-01, 2100-01-01). Also catches seconds sent instead of ms. */
export const TS_MIN = Date.UTC(2020, 0, 1);
export const TS_MAX_EXCLUSIVE = Date.UTC(2100, 0, 1);
const timestamp = z.int().gte(TS_MIN).lt(TS_MAX_EXCLUSIVE);

/** Fields every event carries. `ts` is milliseconds since the Unix epoch. */
const envelope = {
  v: z.literal(SCHEMA_VERSION),
  /** Unique per event; the API drops duplicates so client retries are safe. */
  event_id: z.uuid(),
  ts: timestamp,
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
  /**
   * From creating the container until the engine's endpoint answers (the server is ready to take a
   * client). For a Playwright server (Chromium) no browser exists yet at this point: it is launched
   * when the client connects, and that time is in `connect_ms`. For an engine that starts its
   * browser before its endpoint answers (CDP: headless-shell, Lightpanda) the launch is in here.
   */
  startup_ms: uint32,
  /**
   * From the client's `connect()` call until it has a usable browser. For a Playwright server this
   * includes launching the browser; for a CDP engine it is only the connection.
   *
   * The two numbers mean different things per engine, so engines are compared on their sum,
   * `startup_ms + connect_ms`: the time from "no container" to "a browser I can drive".
   */
  connect_ms: uint32,
});
export type SessionStartedEvent = z.infer<typeof SessionStartedEvent>;

export const SessionEndedEvent = z.object({
  ...envelope,
  type: z.literal("session.ended"),
  status: SessionStatus,
  /** Human-readable cause, `null` on plain success. */
  reason: text.nullable(),
  duration_ms: uint32,
});
export type SessionEndedEvent = z.infer<typeof SessionEndedEvent>;

export const ActionEvent = z.object({
  ...envelope,
  type: z.literal("action"),
  /** Position of the action inside its session, starting at 0. */
  seq: uint32,
  /** Named `action_type` because `type` is the event discriminator. */
  action_type: ActionType,
  /** Selector or domain the action works on. */
  target: text,
  duration_ms: uint32,
  ok: z.boolean(),
  /** `null` when `ok` is true. */
  error_code: label.nullable(),
});
export type ActionEvent = z.infer<typeof ActionEvent>;

export const ResourceSampleEvent = z
  .object({
    ...envelope,
    type: z.literal("resource.sample"),
    origin: ResourceOrigin,
    // Whatever a sample cannot measure is null. A container sample always has the four
    // container metrics (checked below); a cdp sample may have them null.
    /** Percent of one core, as Docker reports it; can pass 100 on a multi-core container. */
    cpu_pct: float32(MAX_CPU_PCT).nullable(),
    /** MiB (bytes / 1024 / 1024), despite the name. Grafana's `mbytes` unit prints MiB and GiB. */
    mem_mb: float32(MAX_MEMORY_MB).nullable(),
    /**
     * Network bytes of the CONTAINER since the previous sample (a delta, so samples can be summed;
     * the first one counts from container start). It is everything crossing the container's
     * interface, including the automation channel (Playwright or CDP protocol messages,
     * screenshots), so it is not the size of the pages. For page bytes use `network.request.bytes`.
     */
    net_rx_bytes: uint64.nullable(),
    net_tx_bytes: uint64.nullable(),
    /** JS heap size via CDP, in MiB (bytes / 1024 / 1024). `null` when the engine does not support it, absent on container samples. */
    js_heap_mb: float32(MAX_MEMORY_MB).nullable().optional(),
  })
  .superRefine((sample, ctx) => {
    if (sample.origin !== "container") return;
    for (const field of ["cpu_pct", "mem_mb", "net_rx_bytes", "net_tx_bytes"] as const) {
      if (sample[field] === null) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} cannot be null on a container sample`,
        });
      }
    }
  });
export type ResourceSampleEvent = z.infer<typeof ResourceSampleEvent>;

export const NetworkRequestEvent = z.object({
  ...envelope,
  type: z.literal("network.request"),
  domain: label,
  /** HTTP status; `null` when the request failed before a response arrived. */
  status: z.int().min(100).max(599).nullable(),
  /** Transferred bytes; `null` when the engine does not report it. */
  bytes: uint64.nullable(),
  duration_ms: uint32,
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
  action_seq: uint32,
  /** Where the image is stored (local path or object storage). Optional. */
  url: z.string().min(1).max(2048).transform(wellFormed).optional(),
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

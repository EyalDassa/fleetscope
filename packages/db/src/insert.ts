import {
  type FleetEvent,
  SESSION_RUNNING,
  type SessionEndedEvent,
  type SessionState,
} from "@fleetscope/schema";
import type { ClickHouseClient } from "./client";

/**
 * Turning events into rows and writing them in batches. The API's ingest buffer (M1) and the
 * seed both go through `insertEvents`: one INSERT per table per call, never one per event.
 */

/** "2025-10-09 08:53:20.123". A bare integer would be read by ClickHouse as seconds, not ms. */
export function toClickHouseDateTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

type Envelope = {
  event_id: string;
  ts: string;
  session_id: string;
  agent_id: string;
  source: string;
  engine: string;
  provider: string;
};

function envelopeOf(event: FleetEvent): Envelope {
  return {
    event_id: event.event_id,
    ts: toClickHouseDateTime(event.ts),
    session_id: event.session_id,
    agent_id: event.agent_id,
    source: event.source,
    engine: event.engine,
    provider: event.provider,
  };
}

export interface SessionRow {
  session_id: string;
  agent_id: string;
  source: string;
  engine: string;
  provider: string;
  engine_version: string | null;
  scenario: string;
  region: string;
  started_at: string;
  startup_ms: number;
  connect_ms: number;
  status: SessionState;
  ended_at: string | null;
  duration_ms: number | null;
  reason: string | null;
  version: number;
}

export const SESSION_VERSION_RUNNING = 1;
export const SESSION_VERSION_ENDED = 2;

type Started = Extract<FleetEvent, { type: "session.started" }>;
type Ended = Extract<FleetEvent, { type: "session.ended" }>;

export function runningSessionRow(started: Started): SessionRow {
  return {
    session_id: started.session_id,
    agent_id: started.agent_id,
    source: started.source,
    engine: started.engine,
    provider: started.provider,
    engine_version: started.engine_version,
    scenario: started.scenario,
    region: started.region,
    started_at: toClickHouseDateTime(started.ts),
    startup_ms: started.startup_ms,
    connect_ms: started.connect_ms,
    status: SESSION_RUNNING,
    ended_at: null,
    duration_ms: null,
    reason: null,
    version: SESSION_VERSION_RUNNING,
  };
}

/** The ended snapshot: everything from the running row plus the outcome. */
export function endedSessionRow(running: SessionRow, ended: Ended): SessionRow {
  return {
    ...running,
    status: ended.status,
    ended_at: toClickHouseDateTime(ended.ts),
    duration_ms: ended.duration_ms,
    reason: ended.reason,
    version: SESSION_VERSION_ENDED,
  };
}

export type RawTable = "actions" | "resource_samples" | "network_requests" | "issues";

/** Row for a raw-event table, or null for events that have no table (session.*, screenshot). */
export function rawRow(event: FleetEvent): { table: RawTable; row: object } | null {
  switch (event.type) {
    case "action":
      return {
        table: "actions",
        row: {
          ...envelopeOf(event),
          seq: event.seq,
          action_type: event.action_type,
          target: event.target,
          duration_ms: event.duration_ms,
          ok: event.ok,
          error_code: event.error_code,
        },
      };
    case "resource.sample":
      return {
        table: "resource_samples",
        row: {
          ...envelopeOf(event),
          cpu_pct: event.cpu_pct,
          mem_mb: event.mem_mb,
          net_rx_bytes: event.net_rx_bytes,
          net_tx_bytes: event.net_tx_bytes,
          js_heap_mb: event.js_heap_mb ?? null,
          origin: event.origin,
        },
      };
    case "network.request":
      return {
        table: "network_requests",
        row: {
          ...envelopeOf(event),
          domain: event.domain,
          status: event.status,
          bytes: event.bytes,
          duration_ms: event.duration_ms,
          resource_type: event.resource_type,
        },
      };
    case "issue":
      return {
        table: "issues",
        row: { ...envelopeOf(event), kind: event.kind, message: event.message },
      };
    default:
      return null;
  }
}

export interface InsertCounts {
  sessions: number;
  actions: number;
  resource_samples: number;
  network_requests: number;
  issues: number;
  /** Events with no table yet: screenshots. */
  skipped: number;
  /** session.ended events whose session.started was never seen; they cannot be stored. */
  orphanedEnds: number;
}

/** What `insertEvents` reports: the counts, plus the end events it could not store (see below). */
export interface InsertResult extends InsertCounts {
  /**
   * The `session.ended` events whose session is neither in the batch nor stored yet. Nothing was
   * written for them. The ingest buffer holds them and offers them again in later flushes, because
   * their `session.started` may simply be in a later batch. `orphanedEnds === orphans.length`.
   */
  orphans: SessionEndedEvent[];
}

/** The tables `insertEvents` writes to, in the order it writes them. */
export const INSERT_TABLES = [
  "sessions",
  "actions",
  "resource_samples",
  "network_requests",
  "issues",
] as const;
export type InsertTable = (typeof INSERT_TABLES)[number];

/** One `insert_deduplication_token` per table. A table without a token is not deduplicated. */
export type DedupTokens = Partial<Record<InsertTable, string>>;

/**
 * The tokens for one flush: `<flushId>:<table>`. Reuse the same flush id (and the same events) when
 * a failed flush is retried, and ClickHouse skips every table insert that already succeeded.
 * Use a new flush id for every new batch: the token alone identifies a block, not its content.
 */
export function dedupTokensFor(flushId: string): Record<InsertTable, string> {
  return Object.fromEntries(INSERT_TABLES.map((table) => [table, `${flushId}:${table}`])) as Record<
    InsertTable,
    string
  >;
}

export interface InsertOptions {
  /**
   * Makes the call safe to repeat. With a token, ClickHouse skips an insert whose token it has
   * already seen (see migration 0006 for the window); without one, nothing is deduplicated.
   */
  dedupTokens?: DedupTokens;
}

/**
 * The client sends query parameters in the URL, and ClickHouse rejects a single parameter of about
 * 64 KB or more ("HTML Form Exception: Field value too long"). 5,000 ids of 128 characters are
 * ~640 KB, so the ids are looked up in chunks whose URL-encoded size stays under this budget.
 * (Encoded size, not character count: ids with special characters grow up to 3x.)
 */
export const LOOKUP_CHUNK_BYTES = 40_000;

/** Split ids into chunks whose URL-encoded size (plus a separator each) is at most `maxBytes`. */
export function chunkByEncodedSize(
  ids: readonly string[],
  maxBytes = LOOKUP_CHUNK_BYTES,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const id of ids) {
    // A quoted, escaped, comma-separated element: allow 3 bytes of overhead plus escaping.
    const cost = encodeURIComponent(id).length * 2 + 6;
    if (current.length > 0 && size + cost > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(id);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Latest stored snapshot per session, used when an `ended` event arrives without its `started`. */
async function findStoredSessions(
  client: ClickHouseClient,
  sessionIds: string[],
): Promise<Map<string, SessionRow>> {
  const found = new Map<string, SessionRow>();
  for (const ids of chunkByEncodedSize(sessionIds)) {
    const result = await client.query({
      query: `SELECT session_id, agent_id, source, engine, provider, engine_version, scenario, region,
                     toString(started_at) AS started_at, startup_ms, connect_ms, status,
                     if(ended_at IS NULL, NULL, toString(ended_at)) AS ended_at,
                     duration_ms, reason, version
              FROM sessions FINAL
              WHERE session_id IN {ids:Array(String)}`,
      query_params: { ids },
      format: "JSONEachRow",
    });
    for (const row of await result.json<SessionRow>()) found.set(row.session_id, row);
  }
  return found;
}

/** Settings for one table INSERT: deduplicate by token if given, otherwise not at all. */
function insertSettings(token: string | undefined) {
  // Once a table has a dedup window (migration 0006), ClickHouse also skips an insert whose
  // CONTENT it has seen before. That would silently swallow legitimate repeats (the seed, tests),
  // so deduplication is on only when the caller says so, with a token.
  return token === undefined
    ? ({ insert_deduplicate: 0 } as const)
    : ({ insert_deduplicate: 1, insert_deduplication_token: token } as const);
}

/**
 * Write events to ClickHouse: one batch INSERT per table. Events must already be validated.
 *
 * `sessions` holds full snapshots, so a `session.ended` is merged with its `session.started`
 * (from the same batch, else from the table). An end that finds no start is not written; it is
 * returned in `orphans` so the caller can try again later.
 *
 * ClickHouse has no transaction across tables, so a failure leaves the earlier tables written.
 * Pass `dedupTokens` and call again with the same events and tokens to finish the job without
 * duplicating what was already written.
 */
export async function insertEvents(
  client: ClickHouseClient,
  events: readonly FleetEvent[],
  options: InsertOptions = {},
): Promise<InsertResult> {
  const tokens = options.dedupTokens ?? {};
  const orphans: SessionEndedEvent[] = [];
  const counts: InsertCounts = {
    sessions: 0,
    actions: 0,
    resource_samples: 0,
    network_requests: 0,
    issues: 0,
    skipped: 0,
    orphanedEnds: 0,
  };
  const raw: Record<RawTable, object[]> = {
    actions: [],
    resource_samples: [],
    network_requests: [],
    issues: [],
  };
  const running = new Map<string, SessionRow>();
  const ends = new Map<string, Ended>();

  for (const event of events) {
    if (event.type === "session.started") {
      running.set(event.session_id, runningSessionRow(event));
    } else if (event.type === "session.ended") {
      ends.set(event.session_id, event);
    } else {
      const mapped = rawRow(event);
      if (mapped) raw[mapped.table].push(mapped.row);
      else counts.skipped++;
    }
  }

  const needLookup = [...ends.keys()].filter((id) => !running.has(id));
  const stored = await findStoredSessions(client, needLookup);

  const sessionRows: SessionRow[] = [];
  for (const [id, row] of running) {
    const ended = ends.get(id);
    sessionRows.push(ended ? endedSessionRow(row, ended) : row);
  }
  for (const id of needLookup) {
    const base = stored.get(id);
    const ended = ends.get(id);
    if (base && ended) sessionRows.push(endedSessionRow(base, ended));
    else if (ended) orphans.push(ended);
  }
  counts.orphanedEnds = orphans.length;

  if (sessionRows.length > 0) {
    await client.insert({
      table: "sessions",
      values: sessionRows,
      format: "JSONEachRow",
      clickhouse_settings: insertSettings(tokens.sessions),
    });
    counts.sessions = sessionRows.length;
  }
  for (const table of Object.keys(raw) as RawTable[]) {
    const values = raw[table];
    if (values.length === 0) continue;
    await client.insert({
      table,
      values,
      format: "JSONEachRow",
      clickhouse_settings: insertSettings(tokens[table]),
    });
    counts[table] = values.length;
  }
  return { ...counts, orphans };
}

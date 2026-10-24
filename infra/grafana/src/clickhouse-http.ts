// A minimal ClickHouse HTTP client for the dashboard check. It uses plain fetch, so the check needs
// no dependency and talks to the server the way Grafana's data source does (HTTP interface).
import { codeOnly } from "./sql-text";

export interface ClickHouseConnection {
  /** Base URL, e.g. http://localhost:8123 */
  url: string;
  user: string;
  password: string;
  database: string;
}

export class ClickHouseQueryError extends Error {
  override name = "ClickHouseQueryError";
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
  }
}

export interface QueryResult {
  /** Column names, in order. */
  columns: string[];
  rows: unknown[][];
}

export type Fetch = typeof fetch;

/** Only reads are allowed in dashboards. The read-only user enforces it; this gives a clear message first. */
export function assertReadQuery(sql: string): void {
  const first = /^\s*(\w+)/.exec(codeOnly(sql))?.[1]?.toUpperCase();
  if (first !== "SELECT" && first !== "WITH") {
    throw new ClickHouseQueryError(
      `a dashboard query must start with SELECT or WITH, this one starts with ${first ?? "nothing"}`,
      undefined,
    );
  }
}

export async function runQuery(
  connection: ClickHouseConnection,
  sql: string,
  fetchImpl: Fetch = fetch,
): Promise<QueryResult> {
  assertReadQuery(sql);
  const url = new URL(connection.url);
  url.searchParams.set("database", connection.database);
  url.searchParams.set("default_format", "JSONCompact");

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "X-ClickHouse-User": connection.user,
        "X-ClickHouse-Key": connection.password,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: sql.replace(/[\s;]+$/, ""),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new ClickHouseQueryError(
      `cannot reach ClickHouse at ${connection.url}: ${(error as Error).message}`,
      undefined,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    // ClickHouse answers with plain text: "Code: 47. DB::Exception: Unknown identifier ..."
    throw new ClickHouseQueryError(text.trim().slice(0, 1200), response.status);
  }
  try {
    const parsed = JSON.parse(text) as { meta?: { name: string }[]; data?: unknown[][] };
    return { columns: (parsed.meta ?? []).map((m) => m.name), rows: parsed.data ?? [] };
  } catch {
    // The query has its own FORMAT clause. It ran, which is all the check needs.
    return { columns: [], rows: [] };
  }
}

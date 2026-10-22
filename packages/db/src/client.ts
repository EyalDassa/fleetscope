import { type ClickHouseClient, createClient } from "@clickhouse/client";
import type { DbConfig } from "./config";

export type { ClickHouseClient };

export interface ClientOptions {
  /** Override the database. `null` connects without selecting one (needed to create it). */
  database?: string | null;
  /** Milliseconds before a request is aborted. Defaults to 30s. */
  requestTimeoutMs?: number;
}

export function createClickHouseClient(
  config: DbConfig,
  options: ClientOptions = {},
): ClickHouseClient {
  const database = options.database === undefined ? config.database : options.database;
  return createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    ...(database === null ? {} : { database }),
    request_timeout: options.requestTimeoutMs ?? 30_000,
  });
}

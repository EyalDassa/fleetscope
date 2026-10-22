import {
  type ClickHouseClient,
  type Logger as ClickHouseLogger,
  ClickHouseLogLevel,
  createClient,
} from "@clickhouse/client";
import type { DbConfig } from "./config";
import { createLogger, type Logger } from "./logger";

export type { ClickHouseClient };

export interface ClientOptions {
  /** Override the database. `null` connects without selecting one (needed to create it). */
  database?: string | null;
  /** Milliseconds before a request is aborted. Defaults to 30s. */
  requestTimeoutMs?: number;
  /** Where the client's own log lines go (as JSON). Defaults to a pino logger "clickhouse". */
  logger?: Logger;
}

/**
 * Forwards the ClickHouse client's logging to pino, so every log line is JSON. The client only
 * reports at ERROR level (see `createClickHouseClient`): its WARN lines are expected noise such
 * as a failed ping, which callers already report themselves (`/healthz` logs "ClickHouse is down").
 */
function pinoAdapter(logger: Logger): new () => ClickHouseLogger {
  return class PinoClickHouseLogger implements ClickHouseLogger {
    trace({ module, message, args }: Parameters<ClickHouseLogger["trace"]>[0]): void {
      logger.trace({ module, ...args }, message);
    }
    debug({ module, message, args }: Parameters<ClickHouseLogger["debug"]>[0]): void {
      logger.debug({ module, ...args }, message);
    }
    info({ module, message, args }: Parameters<ClickHouseLogger["info"]>[0]): void {
      logger.info({ module, ...args }, message);
    }
    warn({ module, message, args, err }: Parameters<ClickHouseLogger["warn"]>[0]): void {
      logger.warn({ module, err, ...args }, message);
    }
    error({ module, message, args, err }: Parameters<ClickHouseLogger["error"]>[0]): void {
      logger.error({ module, err, ...args }, message);
    }
  };
}

export function createClickHouseClient(
  config: DbConfig,
  options: ClientOptions = {},
): ClickHouseClient {
  const database = options.database === undefined ? config.database : options.database;
  const logger = options.logger ?? createLogger("clickhouse", config.logLevel);
  return createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    ...(database === null ? {} : { database }),
    request_timeout: options.requestTimeoutMs ?? 30_000,
    log: { LoggerClass: pinoAdapter(logger), level: ClickHouseLogLevel.ERROR },
  });
}

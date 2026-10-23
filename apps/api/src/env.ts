import { clickhouseEnvSchema, logLevelSchema, parseEnv } from "@fleetscope/db";
import { z } from "zod";

/** Everything the API reads from the environment. Validated once at startup. */
export const apiEnvSchema = clickhouseEnvSchema.extend({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** Loopback by default; set API_HOST=0.0.0.0 when deploying behind a platform proxy. */
  API_HOST: z.string().min(1).default("127.0.0.1"),
  LOG_LEVEL: logLevelSchema,
  /** Most events the ingest buffer keeps in memory before it answers 503 (about 1 KB each). */
  INGEST_BUFFER_CAPACITY: z.coerce.number().int().min(1).max(5_000_000).default(50_000),
  /**
   * Where events go when ClickHouse keeps refusing a flush because of its data. Relative paths
   * are relative to the API's working directory. One JSONL file per flush.
   */
  INGEST_DEADLETTER_DIR: z.string().min(1).default("./.data/deadletter"),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

/** Throws a ConfigError listing every missing or invalid variable. */
export function loadApiEnv(env: Record<string, string | undefined> = process.env): ApiEnv {
  return parseEnv(apiEnvSchema, env);
}

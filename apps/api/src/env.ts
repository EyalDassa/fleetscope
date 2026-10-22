import { clickhouseEnvSchema, logLevelSchema, parseEnv } from "@fleetscope/db";
import { z } from "zod";

/** Everything the API reads from the environment. Validated once at startup. */
export const apiEnvSchema = clickhouseEnvSchema.extend({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** Loopback by default; set API_HOST=0.0.0.0 when deploying behind a platform proxy. */
  API_HOST: z.string().min(1).default("127.0.0.1"),
  LOG_LEVEL: logLevelSchema,
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

/** Throws a ConfigError listing every missing or invalid variable. */
export function loadApiEnv(env: Record<string, string | undefined> = process.env): ApiEnv {
  return parseEnv(apiEnvSchema, env);
}

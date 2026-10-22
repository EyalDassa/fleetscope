import { z } from "zod";

/** Database names end up in DDL, so keep them to plain identifiers. */
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a plain identifier");

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export const logLevelSchema = z.enum(LOG_LEVELS).default("info");

/** Environment variables needed to talk to ClickHouse (see .env.example). */
export const clickhouseEnvSchema = z.object({
  CLICKHOUSE_URL: z.url(),
  CLICKHOUSE_USER: z.string().min(1),
  CLICKHOUSE_PASSWORD: z.string(),
  CLICKHOUSE_DATABASE: identifier,
});

export const dbEnvSchema = clickhouseEnvSchema.extend({
  LOG_LEVEL: logLevelSchema,
});

export interface DbConfig {
  url: string;
  username: string;
  password: string;
  database: string;
  logLevel: (typeof LOG_LEVELS)[number];
}

/** Thrown when environment variables are missing or invalid. The message lists every problem. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Parse an env object with a zod schema and fail with a readable message. */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined>,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function toDbConfig(env: z.infer<typeof dbEnvSchema>): DbConfig {
  return {
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
    database: env.CLICKHOUSE_DATABASE,
    logLevel: env.LOG_LEVEL,
  };
}

export function loadDbConfig(env: Record<string, string | undefined> = process.env): DbConfig {
  return toDbConfig(parseEnv(dbEnvSchema, env));
}

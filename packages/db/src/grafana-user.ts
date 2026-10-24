import { z } from "zod";
import type { ClickHouseClient } from "./client";
import { ConfigError, identifierSchema, parseEnv } from "./config";

/**
 * The read-only ClickHouse user that Grafana connects as (docs/adr/0003-grafana.md).
 *
 * Grafana runs whatever SQL a dashboard contains, so the user must not be able to change anything,
 * even if someone pastes a `DROP TABLE` into a panel. Two layers:
 *  - the grants: `SELECT` on the Fleetscope database and nothing else;
 *  - `readonly = 1`: ClickHouse refuses every statement that is not a read, whatever the grants.
 *
 * Why `readonly = 1` and not `readonly = 2`. With `readonly = 2` a client may change settings per
 * query (it still cannot write), which is what the Grafana plugin needs, because its ClickHouse
 * client sets `max_execution_time` on every query. But the plugin's own documentation says to keep
 * `readonly = 1` and mark the settings it needs `CHANGEABLE_IN_READONLY`, and not to use
 * `readonly = 2` on a public instance: with 2 a dashboard author could lift every limit
 * (memory, rows, time) on a shared server. So the user may change exactly these settings and no
 * others:
 *  - `max_execution_time`: required by the plugin for query timeouts. Default 60 seconds, and a
 *    query cannot ask for more than 300;
 *  - `additional_table_filters`: how the plugin applies a dashboard's "ad hoc filters". It only
 *    narrows the rows a query sees.
 * Anything else, such as `SETTINGS join_use_nulls = 1` in a panel, is refused, so dashboard SQL
 * must not need a SETTINGS clause (packages/db/README.md).
 *
 * The password is passed as a query parameter ({password:String}), so it is never part of the SQL
 * text, and ClickHouse does not write it to `system.query_log`. It also works on ClickHouse Cloud,
 * which supports SQL-driven users and settings constraints (not tested against Cloud here).
 */

export const GRAFANA_MAX_EXECUTION_SECONDS = 300;
export const GRAFANA_DEFAULT_EXECUTION_SECONDS = 60;

/** `CLICKHOUSE_GRAFANA_USER` and `CLICKHOUSE_GRAFANA_PASSWORD` (see .env.example). */
export const grafanaUserEnvSchema = z.object({
  CLICKHOUSE_GRAFANA_USER: identifierSchema,
  CLICKHOUSE_GRAFANA_PASSWORD: z.string().min(8, "must be at least 8 characters"),
});

export interface GrafanaUserOptions {
  user: string;
  password: string;
  /** The database Grafana may read. */
  database: string;
}

/**
 * The user and password that docker-compose, `.env.example` and CI use for a local ClickHouse. They
 * are a development convenience (the same defaults as infra/docker-compose.yml), so they are only
 * ever used when `CLICKHOUSE_URL` points at this machine.
 */
export const LOCAL_GRAFANA_USER = "grafana_ro";
export const LOCAL_GRAFANA_PASSWORD = "grafana_ro_dev_password";

/** True for `localhost`, `127.x.x.x` and `::1`: a ClickHouse that runs on this machine. */
export function isLocalClickHouseUrl(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * Reads the Grafana user from the environment and checks it against the admin user: using the
 * admin's own name would turn the admin into a read-only user and lock the migrations out.
 *
 * For a LOCAL ClickHouse (see `isLocalClickHouseUrl`) a missing user or password falls back to
 * `LOCAL_GRAFANA_USER` / `LOCAL_GRAFANA_PASSWORD`, as docker-compose does. For any other server,
 * ClickHouse Cloud included, both must be set explicitly, and the development password is refused,
 * so a default that is public in this repository can never become a real password.
 */
export function loadGrafanaUserOptions(
  env: Record<string, string | undefined> = process.env,
): GrafanaUserOptions {
  const local = isLocalClickHouseUrl(env.CLICKHOUSE_URL);
  const withDefaults = local
    ? {
        ...env,
        CLICKHOUSE_GRAFANA_USER: env.CLICKHOUSE_GRAFANA_USER || LOCAL_GRAFANA_USER,
        CLICKHOUSE_GRAFANA_PASSWORD: env.CLICKHOUSE_GRAFANA_PASSWORD || LOCAL_GRAFANA_PASSWORD,
      }
    : env;
  if (!local && (!env.CLICKHOUSE_GRAFANA_USER || !env.CLICKHOUSE_GRAFANA_PASSWORD)) {
    throw new ConfigError(
      "Invalid environment:\nCLICKHOUSE_GRAFANA_USER and CLICKHOUSE_GRAFANA_PASSWORD must be set " +
        "explicitly: CLICKHOUSE_URL is not a local address, and the development defaults are only " +
        "used for a ClickHouse on this machine",
    );
  }
  if (!local && env.CLICKHOUSE_GRAFANA_PASSWORD === LOCAL_GRAFANA_PASSWORD) {
    throw new ConfigError(
      "CLICKHOUSE_GRAFANA_PASSWORD is the development password from .env.example; " +
        "choose a real one for a ClickHouse that is not on this machine",
    );
  }
  const grafana = parseEnv(grafanaUserEnvSchema, withDefaults);
  const database = env.CLICKHOUSE_DATABASE;
  if (!database) throw new ConfigError("Invalid environment:\nCLICKHOUSE_DATABASE is not set");
  if (grafana.CLICKHOUSE_GRAFANA_USER === env.CLICKHOUSE_USER) {
    throw new ConfigError(
      "CLICKHOUSE_GRAFANA_USER must not be the admin user (CLICKHOUSE_USER): it would make the admin read-only",
    );
  }
  if (grafana.CLICKHOUSE_GRAFANA_USER === "default") {
    throw new ConfigError("CLICKHOUSE_GRAFANA_USER must not be 'default'");
  }
  return {
    user: grafana.CLICKHOUSE_GRAFANA_USER,
    password: grafana.CLICKHOUSE_GRAFANA_PASSWORD,
    database,
  };
}

export class GrafanaUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrafanaUserError";
  }
}

/** Same for CREATE and ALTER, so a freshly created user is read-only from its first moment. */
const USER_CLAUSES = `IDENTIFIED WITH sha256_password BY {password:String}
  SETTINGS readonly = 1,
           max_execution_time = ${GRAFANA_DEFAULT_EXECUTION_SECONDS} MAX ${GRAFANA_MAX_EXECUTION_SECONDS} CHANGEABLE_IN_READONLY,
           additional_table_filters CHANGEABLE_IN_READONLY`;

/**
 * Creates the user, or updates the password and the settings of an existing one, and grants it
 * SELECT on the database. Safe to run again at any time, and the way to rotate the password.
 *
 * `admin` is a connection of a user that may manage users (the one in CLICKHOUSE_USER). Errors
 * come back without the password even if ClickHouse echoes it.
 */
export async function ensureGrafanaUser(
  admin: ClickHouseClient,
  options: GrafanaUserOptions,
): Promise<void> {
  // GRANT does not accept query parameters (a syntax error in ClickHouse 26.8), so its two names
  // are written into the statement. They are checked first, so they can only be plain identifiers.
  for (const [what, name] of [
    ["user", options.user],
    ["database", options.database],
  ] as const) {
    if (!identifierSchema.safeParse(name).success) {
      throw new GrafanaUserError(`the ${what} name must be a plain identifier`);
    }
  }
  const params = { user: options.user, password: options.password };
  const statements = [
    `CREATE USER IF NOT EXISTS {user:Identifier} ${USER_CLAUSES}`,
    `ALTER USER {user:Identifier} ${USER_CLAUSES}`,
    `GRANT SELECT ON \`${options.database}\`.* TO \`${options.user}\``,
  ];
  try {
    for (const query of statements) {
      await admin.command({ query, query_params: params });
    }
  } catch (error) {
    // The cause is dropped on purpose: a client error can carry the request, and with it the password.
    throw new GrafanaUserError(
      `could not set up the Grafana user "${options.user}": ${redact((error as Error).message, options.password)}`,
    );
  }
}

function redact(message: string, secret: string): string {
  return secret.length === 0 ? message : message.split(secret).join("***");
}

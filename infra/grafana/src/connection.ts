// Where the dashboard check connects, from the environment (.env is loaded by the pnpm script).
//
// The check must run as the same kind of user as Grafana does: the read-only Grafana user. If it ran
// as the admin user, a dashboard query that the read-only user refuses (a SETTINGS clause, a table
// it has no GRANT for) would pass on a laptop and fail in CI (QA-M2-03). So:
//   - default: CLICKHOUSE_GRAFANA_USER / CLICKHOUSE_GRAFANA_PASSWORD. For a ClickHouse on this
//     machine a missing value falls back to the development defaults in dev-defaults.ts (the same
//     ones as infra/docker-compose.yml, .env.example and `pnpm db:grafana-user` in packages/db);
//   - any other ClickHouse: both must be set, because a default that is public in this repository
//     must never be tried on a real server;
//   - --admin (explicit): CLICKHOUSE_USER / CLICKHOUSE_PASSWORD, for when the read-only user does
//     not exist yet. The output says so.
import type { ClickHouseConnection } from "./clickhouse-http";
import { LOCAL_GRAFANA_PASSWORD, LOCAL_GRAFANA_USER } from "./dev-defaults";
import { isLoopbackHost } from "./hosts";

export class ConnectionConfigError extends Error {
  override name = "ConnectionConfigError";
}

function isLocalClickHouse(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function connectionFromEnv(
  env: NodeJS.ProcessEnv,
  admin: boolean,
): { connection: ClickHouseConnection; description: string } {
  const url = env.CLICKHOUSE_URL || "http://localhost:8123";
  const database = env.CLICKHOUSE_DATABASE || "fleetscope";

  if (admin) {
    const connection = {
      url,
      user: env.CLICKHOUSE_USER || "default",
      password: env.CLICKHOUSE_PASSWORD ?? "",
      database,
    };
    return {
      connection,
      description: `${url}, database ${database}, user ${connection.user} (ADMIN, because of --admin: a query that the read-only user refuses would pass here)`,
    };
  }

  const local = isLocalClickHouse(url);
  const user = env.CLICKHOUSE_GRAFANA_USER || (local ? LOCAL_GRAFANA_USER : undefined);
  const password = env.CLICKHOUSE_GRAFANA_PASSWORD || (local ? LOCAL_GRAFANA_PASSWORD : undefined);
  if (!user || !password) {
    throw new ConnectionConfigError(
      `CLICKHOUSE_URL is ${url}, which is not on this machine, so the development defaults for the read-only user do not apply. Set CLICKHOUSE_GRAFANA_USER and CLICKHOUSE_GRAFANA_PASSWORD (pnpm db:grafana-user creates that user), or pass --admin to use CLICKHOUSE_USER on purpose`,
    );
  }
  const usedDefaults = !env.CLICKHOUSE_GRAFANA_USER || !env.CLICKHOUSE_GRAFANA_PASSWORD;
  return {
    connection: { url, user, password, database },
    description: `${url}, database ${database}, user ${user} (read-only Grafana user${usedDefaults ? ", development default" : ""})`,
  };
}

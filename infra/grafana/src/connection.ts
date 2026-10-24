// Where the dashboard check connects, from the environment (.env is loaded by the pnpm script).
import type { ClickHouseConnection } from "./clickhouse-http";

export function connectionFromEnv(
  env: NodeJS.ProcessEnv,
  admin: boolean,
): { connection: ClickHouseConnection; description: string } {
  const useGrafanaUser = !admin && Boolean(env.CLICKHOUSE_GRAFANA_USER);
  const user = useGrafanaUser
    ? (env.CLICKHOUSE_GRAFANA_USER as string)
    : (env.CLICKHOUSE_USER ?? "default");
  const password = useGrafanaUser
    ? (env.CLICKHOUSE_GRAFANA_PASSWORD ?? "")
    : (env.CLICKHOUSE_PASSWORD ?? "");
  const connection = {
    url: env.CLICKHOUSE_URL ?? "http://localhost:8123",
    user,
    password,
    database: env.CLICKHOUSE_DATABASE ?? "fleetscope",
  };
  return {
    connection,
    description: `${connection.url}, database ${connection.database}, user ${user}${useGrafanaUser ? " (read-only Grafana user)" : ""}`,
  };
}

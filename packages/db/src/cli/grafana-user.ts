import { createClickHouseClient } from "../client";
import { ConfigError, loadDbConfig } from "../config";
import { ensureGrafanaUser, loadGrafanaUserOptions } from "../grafana-user";
import { createLogger } from "../logger";

const logger = createLogger("db:grafana-user", process.env.LOG_LEVEL);

try {
  const config = loadDbConfig();
  const options = loadGrafanaUserOptions();
  // The client's own error log is silenced: a server error could echo the statement, and the
  // statement carries the password. ensureGrafanaUser reports failures with the password removed.
  const admin = createClickHouseClient(config, { logger: createLogger("clickhouse", "silent") });
  try {
    await ensureGrafanaUser(admin, options);
    // Never log the password: only who and what.
    logger.info(
      { user: options.user, database: options.database, access: "select, readonly=1" },
      "grafana user is ready",
    );
  } finally {
    await admin.close();
  }
} catch (error) {
  logger.error(
    { err: error },
    error instanceof ConfigError
      ? "grafana user not created: bad configuration"
      : "grafana user failed",
  );
  process.exitCode = 1;
}

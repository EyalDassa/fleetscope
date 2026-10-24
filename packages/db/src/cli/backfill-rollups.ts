import { createClickHouseClient } from "../client";
import { loadDbConfig } from "../config";
import { createLogger } from "../logger";
import { backfillRollups } from "../rollups";

const logger = createLogger("db:backfill-rollups", process.env.LOG_LEVEL);

try {
  const config = loadDbConfig();
  const client = createClickHouseClient(config);
  try {
    logger.warn("rebuilding fleet_minute from the raw tables: stop ingest while this runs");
    const { rows } = await backfillRollups(client);
    logger.info({ database: config.database, rows }, "fleet_minute rebuilt");
  } finally {
    await client.close();
  }
} catch (error) {
  logger.error({ err: error }, "backfill failed (did you run db:migrate?)");
  process.exitCode = 1;
}

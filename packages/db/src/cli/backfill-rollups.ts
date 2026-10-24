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
    const { rows, from } = await backfillRollups(client);
    if (from === null) {
      logger.warn(
        { database: config.database, rows },
        "the raw tables are empty: fleet_minute left as it was",
      );
    } else {
      logger.info(
        { database: config.database, rows, rebuiltFrom: from.toISOString() },
        "fleet_minute rebuilt from the oldest raw minute (older rollup rows are kept)",
      );
    }
  } finally {
    await client.close();
  }
} catch (error) {
  logger.error({ err: error }, "backfill failed (did you run db:migrate?)");
  process.exitCode = 1;
}

import { loadDbConfig } from "../config";
import { createLogger } from "../logger";
import { runMigrations } from "../migrate";

const logger = createLogger("db:migrate", process.env.LOG_LEVEL);

try {
  const config = loadDbConfig();
  const result = await runMigrations(config, { logger });
  logger.info(
    {
      database: config.database,
      applied: result.applied.length,
      skipped: result.alreadyApplied.length,
    },
    "migrations up to date",
  );
} catch (error) {
  logger.error({ err: error }, "migration failed");
  process.exitCode = 1;
}

import { createClickHouseClient } from "../client";
import { loadDbConfig } from "../config";
import { createLogger } from "../logger";
import { seed } from "../seed";

const logger = createLogger("db:seed", process.env.LOG_LEVEL);

try {
  const config = loadDbConfig();
  const client = createClickHouseClient(config);
  try {
    const counts = await seed(client);
    logger.info({ database: config.database, ...counts }, "seed data inserted (source=sim)");
  } finally {
    await client.close();
  }
} catch (error) {
  logger.error({ err: error }, "seed failed (did you run db:migrate?)");
  process.exitCode = 1;
}

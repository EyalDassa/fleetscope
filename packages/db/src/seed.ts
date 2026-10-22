import type { ClickHouseClient } from "./client";
import { type InsertCounts, insertEvents } from "./insert";
import { buildSeedEvents, SEED_SESSION_PREFIX } from "./seed-events";

const SEEDED_TABLES = ["sessions", "actions", "resource_samples", "network_requests", "issues"];

/**
 * Insert the simulated seed data. Running it again first removes the previous seed sessions
 * (lightweight DELETE), so it never piles up duplicates.
 */
export async function seed(client: ClickHouseClient, now = Date.now()): Promise<InsertCounts> {
  for (const table of SEEDED_TABLES) {
    await client.command({
      query: "DELETE FROM {table:Identifier} WHERE startsWith(session_id, {prefix:String})",
      query_params: { table, prefix: SEED_SESSION_PREFIX },
    });
  }
  return insertEvents(client, buildSeedEvents(now));
}

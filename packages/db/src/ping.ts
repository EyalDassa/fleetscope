import type { ClickHouseClient } from "./client";

/**
 * Health check for the API. Runs `SELECT 1` (so credentials are verified too, unlike the bare
 * /ping endpoint) and gives up after `timeoutMs`. Never throws: returns false when ClickHouse is
 * unreachable, slow or rejects us.
 */
export async function ping(client: ClickHouseClient, timeoutMs = 1000): Promise<boolean> {
  try {
    const result = await client.ping({
      select: true,
      abort_signal: AbortSignal.timeout(timeoutMs),
    });
    return result.success;
  } catch {
    return false;
  }
}

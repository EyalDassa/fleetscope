import type { CollectedSession, Collector } from "@fleetscope/collector";
import type { Engine } from "@fleetscope/schema";
import type { Logger } from "pino";
import type { DockerFleet } from "./docker";

export interface ForceShutdownDeps {
  /** Sessions that started and have not ended. */
  live: ReadonlySet<CollectedSession>;
  collectors: ReadonlyMap<Engine, Collector>;
  fleets: ReadonlyMap<Engine, Pick<DockerFleet, "removeAllOwned"> & { starting?: number }>;
  /** Only this run's containers are removed. */
  runId: string;
  logger: Logger;
  /** Longest to spend ending sessions and flushing the queues. Default 2000. */
  flushMs?: number;
  /** Longest to spend removing containers. Default 3000. */
  cleanupMs?: number;
}

/** Waits for `promise`, but at most `ms`. Never rejects. */
async function within(ms: number, promise: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * The "exit now" path of the second Ctrl+C. It stops waiting for the running scenarios but does not
 * throw away what is already known:
 *  1. every session still running is ended as `failed` / `interrupted` (so it does not stay
 *     `running` in the database for ever), and
 *  2. the collectors send what is queued, including every finished session's `session.ended`
 *     (bounded, `flushMs`), and
 *  3. this run's containers are removed, best effort (bounded, `cleanupMs`).
 * The caller exits right after. Everything here is bounded, so it cannot hang the exit.
 */
export async function forceShutdown(deps: ForceShutdownDeps): Promise<void> {
  const { live, collectors, fleets, runId, logger } = deps;
  const flushMs = deps.flushMs ?? 2000;
  const cleanupMs = deps.cleanupMs ?? 3000;

  await within(
    flushMs,
    (async () => {
      // endSession takes a moment (a last heap reading), so let the endings land before closing.
      const endings = [...live].map((session) => {
        session.beginShutdown();
        return session.endSession("failed", "interrupted");
      });
      await within(Math.max(300, flushMs - 800), Promise.allSettled(endings));
      await Promise.allSettled([...collectors.values()].map((c) => c.close(800)));
    })(),
  );

  // A container that Docker is still creating shows up after a first sweep, so keep sweeping until
  // a sweep has run with nothing being created (all within `cleanupMs`).
  let removed = 0;
  const deadline = Date.now() + cleanupMs;
  await within(
    cleanupMs,
    Promise.allSettled(
      [...fleets.values()].map(async (fleet) => {
        for (;;) {
          const startingBefore = fleet.starting ?? 0;
          removed += await fleet.removeAllOwned({ runId });
          // Done after a sweep that ran with nothing being created: nothing can appear any more.
          if (startingBefore === 0 && !fleet.starting) return;
          if (Date.now() >= deadline) return;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }),
    ),
  );
  logger.warn({ removedContainers: removed }, "stopped without waiting for running sessions");
}

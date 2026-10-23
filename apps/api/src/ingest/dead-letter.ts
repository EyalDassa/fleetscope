import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DeadLetter } from "./buffer";

/**
 * Where the events of a flush that ClickHouse keeps refusing end up, so that nothing the API has
 * acknowledged is lost silently (docs/adr/0002-ingest-dedupe.md).
 *
 * One file per flush in `dir`: `<UTC time>-<flush id>.jsonl`, one event per line, exactly as they
 * were validated. The reason is in the API's log (`flushId` is the same). To look at one:
 * `jq -c '{type, session_id, ts}' <file>`.
 *
 * The file may hold events that did reach some tables before the flush failed, because ClickHouse
 * has no transaction across tables. Before replaying a file, check the `event_id`s against the
 * tables. Replay after an API restart or 15 minutes later: until then the in-memory id window
 * answers 202 with every event counted as a duplicate and stores nothing (see ADR 0002).
 */
export function fileDeadLetter(dir: string, now: () => number = Date.now): DeadLetter {
  return async (flushId, events) => {
    await mkdir(dir, { recursive: true });
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
    const path = resolve(join(dir, `${stamp}-${flushId}.jsonl`));
    const lines = events.map((event) => JSON.stringify(event)).join("\n");
    // Write beside it and rename, so a half-written file never looks like a finished one.
    await writeFile(`${path}.tmp`, `${lines}\n`, "utf8");
    await rename(`${path}.tmp`, path);
    return path;
  };
}

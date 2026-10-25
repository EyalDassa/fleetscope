import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isPublicSite, type PublicSite } from "./sites";

/** A site that pushed back (403, 429, CAPTCHA) is left alone for this long (docs/adr/0007). */
export const PAUSE_MS = 60 * 60 * 1000;

/**
 * Which public sites are paused, and until when (epoch ms).
 *
 * The pauses this process makes are always kept in memory, so a pause holds even if the file cannot be
 * written. With a file (`--state-file`) the pauses of other fleet processes are read from it on every
 * question (the later end wins) and ours are written to it for them.
 */
export interface PauseStore {
  /** When the pause ends, or `undefined` if the site is not paused. */
  pausedUntil(site: PublicSite, now?: number): number | undefined;
  isPaused(site: PublicSite, now?: number): boolean;
  /** Never throws: a file that cannot be written is reported to `onWriteError` and the pause stays in memory. */
  pause(site: PublicSite, until: number): void;
}

type State = Partial<Record<PublicSite, number>>;

function parseState(text: string): State {
  const state: State = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return state;
    for (const [site, until] of Object.entries(parsed)) {
      if (isPublicSite(site) && typeof until === "number" && Number.isFinite(until)) {
        state[site] = until;
      }
    }
  } catch {
    // an unreadable file is an empty state: better than refusing to run
  }
  return state;
}

/** For each site the later end of the two. */
function merge(a: State, b: State): State {
  const merged: State = { ...a };
  for (const [site, until] of Object.entries(b) as [PublicSite, number][]) {
    merged[site] = Math.max(merged[site] ?? 0, until);
  }
  return merged;
}

/** Waits a little, synchronously (a file lock on Windows lasts milliseconds). */
function pauseBriefly(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const WRITE_ATTEMPTS = 4;

/** Writes beside the file and renames over it, so another process never reads half a file. */
function writeAtomically(filePath: string, state: State): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync(temp, filePath);
        return;
      } catch (error) {
        // Windows: EPERM/EBUSY while an antivirus or another process holds the file. Try again shortly.
        if (attempt >= WRITE_ATTEMPTS) throw error;
        pauseBriefly(25 * attempt);
      }
    }
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function createPauseStore(
  filePath?: string,
  options: { onWriteError?: (error: unknown) => void } = {},
): PauseStore {
  let memory: State = {};
  const read = (): State => {
    if (filePath === undefined) return memory;
    let fromFile: State = {};
    try {
      fromFile = parseState(readFileSync(filePath, "utf8"));
    } catch {
      // no file yet
    }
    return merge(fromFile, memory);
  };
  const pausedUntil = (site: PublicSite, now = Date.now()): number | undefined => {
    const until = read()[site];
    return until !== undefined && until > now ? until : undefined;
  };
  return {
    pausedUntil,
    isPaused: (site, now) => pausedUntil(site, now) !== undefined,
    pause(site, until) {
      memory = merge(memory, { [site]: until });
      if (filePath === undefined) return;
      try {
        writeAtomically(filePath, read());
      } catch (error) {
        options.onWriteError?.(error);
      }
    },
  };
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isPublicSite, type PublicSite } from "./sites";

/** A site that pushed back (403, 429, CAPTCHA) is left alone for this long (docs/adr/0007). */
export const PAUSE_MS = 60 * 60 * 1000;

/**
 * Which public sites are paused, and until when (epoch ms). With a file (`--state-file`) the state
 * survives restarts and is shared with other fleet processes: it is read again on every question.
 * Without one it lives in memory for this process.
 */
export interface PauseStore {
  /** When the pause ends, or `undefined` if the site is not paused. */
  pausedUntil(site: PublicSite, now?: number): number | undefined;
  isPaused(site: PublicSite, now?: number): boolean;
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

export function createPauseStore(filePath?: string): PauseStore {
  let memory: State = {};
  const read = (): State => {
    if (filePath === undefined) return memory;
    try {
      return parseState(readFileSync(filePath, "utf8"));
    } catch {
      return {}; // no file yet
    }
  };
  const pausedUntil = (site: PublicSite, now = Date.now()): number | undefined => {
    const until = read()[site];
    return until !== undefined && until > now ? until : undefined;
  };
  return {
    pausedUntil,
    isPaused: (site, now) => pausedUntil(site, now) !== undefined,
    pause(site, until) {
      const state = { ...read(), [site]: until };
      if (filePath === undefined) {
        memory = state;
        return;
      }
      mkdirSync(dirname(filePath), { recursive: true });
      // write beside, then rename: another process never reads half a file
      const temp = `${filePath}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(temp, filePath);
    },
  };
}

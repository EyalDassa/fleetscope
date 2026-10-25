/**
 * The politeness gate of ONE public site in this process (docs/adr/0007). Every session that visits
 * the site shares it, so the site's `minDelayMs` holds between all navigations: inside a session,
 * between two concurrent sessions, and between the last page of one session and the first of the next.
 *
 * Callers queue: one that arrives while another waits goes behind it instead of both sleeping until the
 * same moment.
 */
export interface SitePacer {
  /** Resolves when it is this caller's turn to start a navigation (at least `minDelayMs` after the previous one). */
  beforeNavigation(minDelayMs: number, signal?: AbortSignal): Promise<void>;
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function createSitePacer(options: { sleep?: Sleep; now?: () => number } = {}): SitePacer {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  /**
   * The callers form a queue: each waits for the one before it to START, then for `minDelayMs` after
   * that start. Measuring from the real start (not from a time promised in advance) keeps the gap even
   * if the process was stalled and the timers of several waiters all fire late together.
   */
  let tail: Promise<number> = Promise.resolve(Number.NEGATIVE_INFINITY);
  return {
    async beforeNavigation(minDelayMs, signal) {
      const previous = tail;
      let release: (startedAt: number) => void = () => undefined;
      tail = new Promise<number>((resolve) => {
        release = resolve;
      });
      const lastStart = await previous;
      const wait = lastStart + minDelayMs - now();
      if (wait > 0) await sleep(wait, signal);
      // A caller that was cut off while it waited does not navigate: the next one counts from the last real start.
      release(signal?.aborted ? lastStart : now());
    },
  };
}

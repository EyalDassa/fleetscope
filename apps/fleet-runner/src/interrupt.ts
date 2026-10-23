/**
 * What to do with Ctrl+C. The escalation is:
 *
 *  1. first Ctrl+C   stop starting sessions, end the running ones as `failed` / `interrupted`,
 *                    flush, clean up, print the summary, exit 130
 *  2. second Ctrl+C  "do not wait for the running scenarios": end what is still running, flush the
 *                    queue for up to 2 s, remove this run's containers for up to 3 s, exit 130
 *  3. third Ctrl+C   exit this instant (`pnpm fleet cleanup` removes what is left)
 *
 * One physical Ctrl+C can reach a Node process more than once on Windows: the console delivers the
 * event to every process attached to it, and wrappers (pnpm, tsx) also relay the signal they got.
 * A signal that arrives less than `debounceMs` after the one before it is therefore the same
 * interrupt, not a new one. Without this, one keypress used to count as two and the second cut the
 * cleanup short.
 */

export type InterruptAction = "first" | "ignored" | "force" | "exit";

export interface InterruptHandlers {
  onFirst(): void;
  onForce(): void;
  onExit(): void;
}

export interface InterruptOptions {
  /** Signals closer together than this are one interrupt. Default 2000 ms. */
  debounceMs?: number;
  /** Test hook: a fake clock. */
  now?: () => number;
}

/** Returns the function to call on every SIGINT / SIGTERM. It says what it did with the signal. */
export function createInterruptHandler(
  handlers: InterruptHandlers,
  options: InterruptOptions = {},
): () => InterruptAction {
  const debounceMs = options.debounceMs ?? 2000;
  const now = options.now ?? Date.now;
  let counted = 0;
  let lastCountedAt = 0;

  return () => {
    const at = now();
    if (counted > 0 && at - lastCountedAt < debounceMs) return "ignored";
    counted++;
    lastCountedAt = at;
    if (counted === 1) {
      handlers.onFirst();
      return "first";
    }
    if (counted === 2) {
      handlers.onForce();
      return "force";
    }
    handlers.onExit();
    return "exit";
  };
}

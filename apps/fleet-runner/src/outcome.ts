import { BlockedError, CollectedError } from "@fleetscope/collector";
import type { SessionStatus } from "@fleetscope/schema";

export interface OutcomeInput {
  /** What the scenario threw, or `undefined` if it finished. */
  error?: unknown;
  /** The runner was interrupted (Ctrl+C). */
  interrupted: boolean;
  /** The session ran past its time limit and the runner closed the browser. */
  timedOut: boolean;
  sessionTimeoutMs: number;
  /** The browser went away without the runner closing it. */
  disconnected: boolean;
}

export interface Outcome {
  status: SessionStatus;
  /** `null` on plain success. */
  reason: string | null;
}

/**
 * Picks the session status. A scenario that returned is a `success`. For one that threw, the
 * order matters: what the runner did itself (interrupt, time limit)
 * comes before what the browser did (disconnect) before what the page did (blocked, timeout).
 *
 *   interrupted              failed   "interrupted"
 *   over the time limit      timeout
 *   browser went away        crashed
 *   403 or captcha           blocked
 *   an action timed out      timeout
 *   anything else            failed   (the error message is the reason)
 */
export function classifyOutcome(input: OutcomeInput): Outcome {
  const { error } = input;
  // A scenario that finished is a success, whatever happened to the browser afterwards.
  if (error === undefined) return { status: "success", reason: null };
  if (input.interrupted) return { status: "failed", reason: "interrupted" };
  if (input.timedOut) {
    return {
      status: "timeout",
      reason: `session exceeded ${Math.round(input.sessionTimeoutMs / 1000)}s`,
    };
  }
  if (input.disconnected || (error instanceof CollectedError && error.code === "browser_closed")) {
    return { status: "crashed", reason: "browser disconnected" };
  }
  const raw = error instanceof Error ? error.message : String(error);
  // A reason is never empty: "why did it fail" must always have an answer.
  const message = raw.trim() || (error instanceof Error ? error.name : "unknown error");
  if (error instanceof BlockedError) return { status: "blocked", reason: message };
  if (error instanceof CollectedError && error.code === "timeout") {
    return { status: "timeout", reason: message };
  }
  return { status: "failed", reason: message };
}

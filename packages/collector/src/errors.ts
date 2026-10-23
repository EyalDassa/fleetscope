import type { IssueKind } from "@fleetscope/schema";
import { type ErrorCode, ISSUE_FOR_CODE } from "./codes";

/** What a failed `CollectedPage` action throws. `code` is also what the action event recorded. */
export class CollectedError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CollectedError";
    this.code = code;
  }

  /** The issue kind this error raised, if any (e.g. `blocked` for `http_403`). */
  get issueKind(): IssueKind | null {
    return ISSUE_FOR_CODE[this.code];
  }
}

/** The site refused us: a 403 on the main document or a captcha page. The session is `blocked`. */
export class BlockedError extends CollectedError {
  constructor(code: "http_403" | "captcha", message: string) {
    super(code, message);
    this.name = "BlockedError";
  }
}

/** "X is not defined" and friends: the page used an API this engine does not provide. */
export function isMissingApiError(error: { name?: string; message?: string }): boolean {
  return error.name === "ReferenceError" || /\bis not defined\b/.test(error.message ?? "");
}

const CLOSED =
  /has been closed|target closed|page closed|browser closed|connection closed|has disconnected|target crashed|page crashed/i;
const NAV = /net::ERR_|NS_ERROR_|Navigation failed|interrupted by another navigation/i;

/**
 * Turns whatever Playwright (or a fake) threw into one of our error codes. `fallback` is what an
 * error we do not recognise becomes (e.g. `js_error` for `eval`).
 */
export function classifyError(error: unknown, fallback: ErrorCode = "unknown"): ErrorCode {
  if (error instanceof CollectedError) return error.code;
  const e = (error ?? {}) as { name?: string; message?: string };
  const message = e.message ?? String(error);
  if (CLOSED.test(message)) return "browser_closed";
  if (e.name === "TimeoutError" || /Timeout \d+ms exceeded/i.test(message)) return "timeout";
  if (NAV.test(message)) return "nav_error";
  if (isMissingApiError(e)) return "unsupported_api";
  return fallback;
}

/** First line of an error message, capped, for `issue.message` (Playwright appends a call log). */
export function shortMessage(error: unknown, max = 500): string {
  const message = error instanceof Error ? error.message : String(error);
  const first = message.split("\n", 1)[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

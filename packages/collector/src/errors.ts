import type { IssueKind } from "@fleetscope/schema";
import { type ErrorCode, ISSUE_FOR_CODE } from "./codes";
import { clip, wellFormed } from "./text";

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

/**
 * Web APIs whose absence shows up as a TypeError instead of "X is not defined" (a guarded
 * `window.X` is undefined, then `new X()` or `X.method()` throws). A fixed list on purpose: a broad
 * "is not a function" rule would call every page bug an engine gap.
 */
const KNOWN_WEB_APIS =
  /(?:^|[\s.(])(?:IntersectionObserver|ResizeObserver|MutationObserver|PerformanceObserver|ReportingObserver|Worker|SharedWorker|ServiceWorker|WebSocket|EventSource|BroadcastChannel|OffscreenCanvas|indexedDB|requestIdleCallback|cancelIdleCallback|matchMedia|AudioContext|WebAssembly|RTCPeerConnection|crypto\.subtle|crypto\.randomUUID|navigator\.(?:serviceWorker|clipboard|geolocation|mediaDevices|storage|permissions|locks))(?:\.\w+)*\s+is not (?:a constructor|a function|defined)/;
/** `crypto.subtle` is undefined (insecure context, or an engine without it): `.digest()` etc. throw. */
const MISSING_SUBTLE =
  /Cannot read propert(?:y|ies) of (?:undefined|null) \(reading '(?:digest|encrypt|decrypt|sign|verify|generateKey|importKey|exportKey|deriveKey|deriveBits|wrapKey|unwrapKey)'\)/;

/**
 * "X is not defined" and friends: the page used an API this engine does not provide. A
 * ReferenceError always counts; a TypeError only when it names an API from the list above.
 */
export function isMissingApiError(error: { name?: string; message?: string }): boolean {
  const message = error.message ?? "";
  if (error.name === "ReferenceError" || /is not defined/.test(message)) return true;
  return KNOWN_WEB_APIS.test(message) || MISSING_SUBTLE.test(message);
}

/**
 * The engine refused a Playwright or CDP feature. Playwright words a CDP method the browser does
 * not implement as "Protocol error (Domain.method): 'Domain.method' wasn't found" (CDP code -32601);
 * some engines say "not implemented" or "not supported". Needs the "Protocol error" wrapper or the
 * -32601 code, so a page saying "not supported" is not mistaken for an engine limit.
 */
export function isUnsupportedFeatureError(error: { message?: string }): boolean {
  const message = error.message ?? "";
  if (/-32601|Method not found|UnknownMethod/i.test(message)) return true;
  return (
    /Protocol error/i.test(message) &&
    /wasn't found|was not found|not implemented|not supported|unsupported|not available/i.test(
      message,
    )
  );
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
  if (isUnsupportedFeatureError(e)) return "unsupported_feature";
  if (isMissingApiError(e)) return "unsupported_api";
  return fallback;
}

/**
 * First line of an error message, capped, for `issue.message` (Playwright appends a call log).
 * Never cuts through an emoji, and is never empty.
 */
export function shortMessage(error: unknown, max = 500): string {
  const message = error instanceof Error ? error.message : String(error);
  const first = (message.split("\n", 1)[0] ?? "").trim();
  if (first === "") return error instanceof Error ? error.name : "unknown error";
  return first.length > max ? `${clip(first, max - 1)}…` : wellFormed(first);
}

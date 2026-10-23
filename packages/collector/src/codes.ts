import type { IssueKind } from "@fleetscope/schema";

/**
 * Error codes written to `action.error_code` when an action fails. A small closed set so the
 * dashboard can group by it. (The schema keeps `error_code` a free label; this is the collector's
 * vocabulary.)
 *
 *  timeout            a Playwright timeout (element found but not ready, or a page that never settles)
 *  nav_error          navigation failed (DNS, connection refused, TLS) or the page answered another HTTP 4xx
 *  selector_not_found the selector matched nothing before the timeout
 *  http_403           a page the action loaded (a goto, or a click that navigated) answered 403
 *  http_5xx           ... answered a server error (500 and up)
 *  captcha            the page contains [data-testid=captcha]
 *  js_error           the page script threw something other than a missing API
 *  unsupported_api    the page used an API the engine does not have ("X is not defined")
 *  browser_closed     the page, context or browser closed, disconnected or crashed during the action
 *  unknown            anything else (the message is in the thrown error)
 */
export const ERROR_CODES = [
  "timeout",
  "nav_error",
  "selector_not_found",
  "http_403",
  "http_5xx",
  "captcha",
  "js_error",
  "unsupported_api",
  "browser_closed",
  "unknown",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Which `issue` event a failed action also raises. `null` = the action event is enough. */
export const ISSUE_FOR_CODE: Readonly<Record<ErrorCode, IssueKind | null>> = {
  timeout: "timeout",
  nav_error: "nav_error",
  selector_not_found: null,
  http_403: "blocked",
  http_5xx: "nav_error",
  captcha: "captcha",
  js_error: null,
  unsupported_api: "unsupported_api",
  browser_closed: "crash",
  unknown: null,
};

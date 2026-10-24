import type { IssueKind } from "./events";

/**
 * Error codes written to `action.error_code` when an action fails. A small closed set so the
 * dashboard can group by it. (The schema keeps `error_code` a free label; this is the collector's
 * vocabulary, shared with the simulator so that both produce the same codes and issues.)
 *
 *  timeout            a Playwright timeout (element found but not ready, or a page that never settles)
 *  nav_error          navigation failed (DNS, connection refused, TLS) or the page answered another HTTP 4xx
 *  selector_not_found the selector matched nothing before the timeout
 *  http_403           a page the action loaded (a goto, or a click that navigated) answered 403
 *  http_5xx           ... answered a server error (500 and up)
 *  captcha            the page contains [data-testid=captcha]
 *  js_error           the page script threw something other than a missing API
 *  unsupported_api    the page used a Web API the engine does not have ("X is not defined", or a
 *                     TypeError naming a known API such as IntersectionObserver or crypto.subtle).
 *                     Also raises an `unsupported_api` issue.
 *  unsupported_feature the engine refused a Playwright/CDP feature the action needs (screenshot,
 *                     viewport emulation, a CDP method that is "not found"/-32601). The engine's
 *                     limit, not the page's; the message says what was refused. No issue.
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
  "unsupported_feature",
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
  unsupported_feature: null,
  browser_closed: "crash",
  unknown: null,
};

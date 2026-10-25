import type { ActionType, IssueKind } from "@fleetscope/schema";
import type { Logger } from "pino";
import type { Page, Request, Response } from "playwright-core";
import { HeapSampler } from "./cdp";
import { type ErrorCode, ISSUE_FOR_CODE } from "./codes";
import {
  BlockedError,
  CollectedError,
  classifyError,
  isMissingApiError,
  shortMessage,
} from "./errors";
import { clip } from "./text";

/** What a page reports to its session. `CollectedSession` implements it. */
export interface PageSink {
  nextSeq(): number;
  recordAction(action: {
    seq: number;
    startedAt: number;
    type: ActionType;
    target: string;
    durationMs: number;
    ok: boolean;
    errorCode: ErrorCode | null;
  }): void;
  /** `once`: report an identical issue (same kind and message) only the first time. */
  recordIssue(kind: IssueKind, message: string, options?: { once?: boolean }): void;
  recordNetwork(request: {
    domain: string;
    status: number | null;
    bytes: number | null;
    durationMs: number;
    resourceType: string;
  }): void;
  recordCdpSample(jsHeapMb: number | null): void;
}

export interface PageConfig {
  logger: Logger;
  /** Default timeout for click, fill, extract and wait on a selector. */
  actionTimeoutMs: number;
  /** Default timeout for `goto`. */
  navigationTimeoutMs: number;
  /** Keep one `network.request` event out of every N requests (1 = all). */
  networkSampleEvery: number;
  /** JS heap sampling period; 0 turns it off. */
  heapSampleIntervalMs: number;
}

export const CAPTCHA_SELECTOR = '[data-testid="captcha"]';

/**
 * Looks at extracted text. Returns `null` when it is fine. Otherwise the action fails with the given
 * error code (`unsupported_api` raises that issue, `timeout` the timeout one) and message.
 */
export type TextCheck = (
  text: string,
) => { code: "unsupported_api" | "timeout" | "js_error"; message: string } | null;

export interface ActionOptions {
  timeoutMs?: number;
}

export interface GotoOptions extends ActionOptions {
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
}

/**
 * A Playwright page that measures itself. Every method below is one `action` event: its sequence
 * number, duration, whether it worked and, if not, an error code (see `ERROR_CODES`). On failure the
 * method throws a `CollectedError` carrying the same code. The page also reports issues (403,
 * captcha, timeouts, missing browser APIs), samples network requests and the JS heap.
 *
 * It is an explicit wrapper, not a proxy: anything not listed here goes through `raw` and is not
 * measured.
 */
export class CollectedPage {
  private requestsSeen = 0;
  /** Main-frame navigation responses seen so far, and the latest one (a click can navigate). */
  private navigations = 0;
  private lastNavigation: { index: number; status: number; url: string } | null = null;
  private readonly requestStarts = new WeakMap<Request, number>();
  private readonly heap: HeapSampler | null;
  private readonly detachers: (() => void)[] = [];
  private disposed = false;

  private constructor(
    /** The underlying Playwright page, for anything the wrapper does not cover. Not measured. */
    readonly raw: Page,
    private readonly sink: PageSink,
    private readonly config: PageConfig,
  ) {
    this.heap =
      config.heapSampleIntervalMs > 0
        ? new HeapSampler({
            open: () => raw.context().newCDPSession(raw),
            onSample: (jsHeapMb) => sink.recordCdpSample(jsHeapMb),
            logger: config.logger,
            intervalMs: config.heapSampleIntervalMs,
          })
        : null;
  }

  /** Wraps a page: starts listening for errors and requests and takes the first heap sample. */
  static async attach(page: Page, sink: PageSink, config: PageConfig): Promise<CollectedPage> {
    const collected = new CollectedPage(page, sink, config);
    collected.listen();
    await collected.heap?.start();
    return collected;
  }

  /** Takes a last JS heap reading. Called by `session.endSession()` just before it closes the session. */
  async sampleHeapNow(): Promise<void> {
    await this.heap?.sampleNow();
  }

  /** Stops sampling and listening. Called by `session.endSession()`; safe to call twice. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const detach of this.detachers) detach();
    await this.heap?.stop();
  }

  url(): string {
    return this.raw.url();
  }

  // Actions ----------------------------------------------------------------------------------

  /**
   * Opens a URL. Returns the HTTP status of the main document (`null` if there was no response).
   * Throws `BlockedError` on a 403 or a captcha page, `CollectedError("http_5xx")` on a server
   * error and `CollectedError("nav_error")` for other failures and HTTP 4xx.
   */
  goto(url: string, options: GotoOptions = {}): Promise<number | null> {
    return this.run({ type: "goto", target: domainOf(url) }, async () => {
      const response = await this.raw.goto(url, {
        timeout: options.timeoutMs ?? this.config.navigationTimeoutMs,
        waitUntil: options.waitUntil ?? "load",
      });
      const status = response?.status() ?? null;
      const bad = status === null ? null : statusError(status, url);
      if (bad) throw bad;
      await this.throwIfCaptcha();
      return status;
    });
  }

  /**
   * Clicks, then waits for any navigation it started to reach DOMContentLoaded. If the click led to
   * a page that answered 403, 4xx or 5xx, or to a captcha page, the action fails like `goto` does.
   */
  click(selector: string, options: ActionOptions = {}): Promise<void> {
    const timeout = options.timeoutMs ?? this.config.actionTimeoutMs;
    return this.run({ type: "click", target: selector, selector }, async () => {
      const before = this.navigations;
      await this.raw.click(selector, { timeout });
      await this.raw.waitForLoadState("domcontentloaded", { timeout }).catch(() => undefined);
      this.throwIfBadNavigation(before);
      await this.throwIfCaptcha();
    });
  }

  /** Types a value into an input. The value is never recorded (it may be a password). */
  fill(selector: string, value: string, options: ActionOptions = {}): Promise<void> {
    const timeout = options.timeoutMs ?? this.config.actionTimeoutMs;
    return this.run({ type: "fill", target: selector, selector }, async () => {
      const before = this.navigations;
      await this.raw.fill(selector, value, { timeout });
      this.throwIfBadNavigation(before);
    });
  }

  /** Number of elements matching the selector. Zero is a valid answer, not an error. */
  extract(selector: string, options: { as: "count" }): Promise<number>;
  /** Text of the first element matching the selector. Fails with `selector_not_found` if none. */
  extract(
    selector: string,
    options?: { as?: "text"; timeoutMs?: number; check?: TextCheck },
  ): Promise<string>;
  extract(
    selector: string,
    options: { as?: "text" | "count"; timeoutMs?: number; check?: TextCheck } = {},
  ): Promise<string | number> {
    const timeout = options.timeoutMs ?? this.config.actionTimeoutMs;
    return this.run({ type: "extract", target: selector, selector }, async () => {
      const locator = this.raw.locator(selector);
      if (options.as === "count") return locator.count();
      const text = (await locator.first().textContent({ timeout })) ?? "";
      // The page itself reports which of its features the engine lacks (the demo site's /js-heavy).
      const problem = options.check?.(text);
      if (problem) throw new CollectedError(problem.code, problem.message);
      return text;
    });
  }

  /**
   * Checks that a PUBLIC site's page has the element the journey relies on: the first selector that
   * matches wins (the rest are fallbacks). Returns the selector that matched. If none does within the
   * time, the action fails with `site_layout`: the page loaded, so the site probably changed, and
   * that is not the browser's fault (docs/adr/0007). It records one `extract` action.
   * `challengeSelector`: if none matches but this does, the page is a CAPTCHA and the action fails
   * with `captcha` (a `BlockedError`) instead.
   */
  landmark(
    selectors: readonly [string, ...string[]],
    options: ActionOptions & { challengeSelector?: string } = {},
  ): Promise<string> {
    const timeout = options.timeoutMs ?? this.config.actionTimeoutMs;
    return this.run({ type: "extract", target: selectors.join(" | ") }, async () => {
      const deadline = Date.now() + timeout;
      do {
        for (const selector of selectors) {
          if ((await this.raw.locator(selector).count()) > 0) return selector;
        }
        await this.raw.waitForTimeout(250);
      } while (Date.now() < deadline);
      // A challenge page (CAPTCHA) is a block, not a changed site.
      if (
        options.challengeSelector &&
        (await this.raw.locator(options.challengeSelector).count()) > 0
      ) {
        throw new BlockedError("captcha", `captcha on ${this.raw.url()}`);
      }
      throw new CollectedError(
        "site_layout",
        `landmark missing on ${this.raw.url()}: ${selectors.join(" | ")}`,
      );
    });
  }

  /** Takes a PNG screenshot of the viewport. Returns the bytes; with `path` also saves them. */
  screenshot(options: { path?: string } & ActionOptions = {}): Promise<Buffer> {
    return this.run({ type: "screenshot", target: domainOf(this.raw.url()) }, () =>
      this.raw.screenshot({
        type: "png",
        path: options.path,
        timeout: options.timeoutMs ?? this.config.actionTimeoutMs,
      }),
    );
  }

  /** Waits a fixed time (a number of ms) or until a selector is visible (a string). */
  wait(forWhat: number | string, options: ActionOptions = {}): Promise<void> {
    const timeout = options.timeoutMs ?? this.config.actionTimeoutMs;
    if (typeof forWhat === "number") {
      return this.run({ type: "wait", target: `${forWhat}ms` }, () =>
        this.raw.waitForTimeout(forWhat),
      );
    }
    return this.run({ type: "wait", target: forWhat, selector: forWhat }, () =>
      this.raw.locator(forWhat).first().waitFor({ state: "visible", timeout }),
    );
  }

  /** Runs JavaScript in the page and returns the result. */
  eval<R = unknown>(script: string | (() => R | Promise<R>)): Promise<R> {
    const target = typeof script === "string" ? script : script.name || "function";
    return this.run({ type: "eval", target, fallback: "js_error" }, () =>
      this.raw.evaluate<R>(script),
    );
  }

  // Internals --------------------------------------------------------------------------------

  /** Times `body`, records one action event, and turns a failure into a `CollectedError`. */
  private async run<T>(
    spec: { type: ActionType; target: string; selector?: string; fallback?: ErrorCode },
    body: () => Promise<T>,
  ): Promise<T> {
    const seq = this.sink.nextSeq();
    const startedAt = Date.now();
    const t0 = performance.now();
    const record = (ok: boolean, errorCode: ErrorCode | null) =>
      this.sink.recordAction({
        seq,
        startedAt,
        type: spec.type,
        target: spec.target,
        durationMs: Math.round(performance.now() - t0),
        ok,
        errorCode,
      });

    try {
      const value = await body();
      record(true, null);
      return value;
    } catch (error) {
      let code = classifyError(error, spec.fallback ?? "unknown");
      let message = shortMessage(error);
      // Playwright reports "element not there" as a timeout; ask the page which one it really was.
      if (code === "timeout" && spec.selector && (await this.isMissing(spec.selector))) {
        code = "selector_not_found";
        message = `selector not found: ${spec.selector} (${message})`;
      }
      record(false, code);
      const kind = ISSUE_FOR_CODE[code];
      if (kind) this.sink.recordIssue(kind, message);
      if (error instanceof CollectedError && error.code === code) throw error;
      throw new CollectedError(code, message, { cause: error });
    }
  }

  private async isMissing(selector: string): Promise<boolean> {
    try {
      return (await this.raw.locator(selector).count()) === 0;
    } catch {
      return false;
    }
  }

  /** Fails like `goto` would if a navigation during this action ended on an error page. */
  private throwIfBadNavigation(navigationsBefore: number): void {
    const latest = this.lastNavigation;
    if (!latest || latest.index <= navigationsBefore) return;
    const bad = statusError(latest.status, latest.url);
    if (bad) throw bad;
  }

  private async throwIfCaptcha(): Promise<void> {
    let present = false;
    try {
      present = (await this.raw.locator(CAPTCHA_SELECTOR).count()) > 0;
    } catch {
      // Page navigating or engine without the call: no evidence of a captcha.
    }
    if (present) throw new BlockedError("captcha", `captcha on ${this.raw.url()}`);
  }

  private listen(): void {
    const page = this.raw;
    const on = <A extends unknown[]>(event: string, handler: (...args: A) => void) => {
      // Playwright's overloads are per event name; a generic helper needs this one cast.
      const p = page as unknown as {
        on(e: string, h: (...a: A) => void): void;
        off(e: string, h: (...a: A) => void): void;
      };
      p.on(event, handler);
      this.detachers.push(() => p.off(event, handler));
    };

    on("pageerror", (error: Error) => {
      // Only a missing API is evidence about the engine; other script errors are the page's own.
      if (isMissingApiError(error)) {
        this.sink.recordIssue("unsupported_api", clip(`${error.name}: ${error.message}`, 500), {
          once: true,
        });
      }
    });
    on("response", (response: Response) => {
      try {
        const request = response.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          this.lastNavigation = {
            index: ++this.navigations,
            status: response.status(),
            url: response.url(),
          };
        }
      } catch {
        // A response with no frame (service worker) or a frame that is already gone: ignore.
      }
    });
    on("crash", () => this.sink.recordIssue("crash", "page crashed", { once: true }));
    on("request", (request: Request) => this.requestStarts.set(request, Date.now()));
    on("requestfinished", (request: Request) => this.sampleRequest(request, false));
    on("requestfailed", (request: Request) => this.sampleRequest(request, true));
  }

  /** Counts every http(s) request and records one in `networkSampleEvery`, starting with the first. */
  private sampleRequest(request: Request, failed: boolean): void {
    let domain: string;
    try {
      const url = new URL(request.url());
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      domain = url.hostname;
    } catch {
      return;
    }
    const index = this.requestsSeen++;
    if (index % this.config.networkSampleEvery !== 0) return;
    void this.recordRequest(request, domain, failed);
  }

  private async recordRequest(request: Request, domain: string, failed: boolean): Promise<void> {
    try {
      let status: number | null = null;
      let bytes: number | null = null;
      if (!failed) {
        status = (await request.response().catch(() => null))?.status() ?? null;
        // Some engines don't report sizes; that stays null instead of a guess.
        const sizes = await request.sizes().catch(() => null);
        if (sizes && sizes.responseBodySize >= 0 && sizes.responseHeadersSize >= 0) {
          bytes = sizes.responseBodySize + sizes.responseHeadersSize;
        }
      }
      const responseEnd = request.timing().responseEnd;
      const durationMs =
        responseEnd > 0
          ? responseEnd
          : Date.now() - (this.requestStarts.get(request) ?? Date.now());
      this.sink.recordNetwork({
        domain,
        status,
        bytes,
        durationMs: Math.round(durationMs),
        resourceType: request.resourceType(),
      });
    } catch (error) {
      this.config.logger.debug({ err: error }, "could not record a network request");
    }
  }
}

/** What an HTTP status of a page we loaded means for the action: 403 blocked, 5xx server error, other 4xx. */
function statusError(status: number, url: string): CollectedError | null {
  if (status === 403) return new BlockedError("http_403", `HTTP 403 for ${url}`);
  // 429 is a site pushing back as well; it is recorded as http_403 ("refused"), the message names it.
  if (status === 429)
    return new BlockedError("http_403", `HTTP 429 (too many requests) for ${url}`);
  if (status >= 500) return new CollectedError("http_5xx", `HTTP ${status} for ${url}`);
  if (status >= 400) return new CollectedError("nav_error", `HTTP ${status} for ${url}`);
  return null;
}

/** Hostname of a URL, or the input itself (clipped) if it is not an absolute URL. */
export function domainOf(url: string): string {
  try {
    return clip(new URL(url).hostname || url, 200);
  } catch {
    return clip(url, 200);
  }
}

import type { ActionType, IssueKind } from "@fleetscope/schema";
import type { Logger } from "pino";
import type { Page, Request } from "playwright-core";
import { HeapSampler } from "./cdp";
import { type ErrorCode, ISSUE_FOR_CODE } from "./codes";
import {
  BlockedError,
  CollectedError,
  classifyError,
  isMissingApiError,
  shortMessage,
} from "./errors";

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
   * Throws `BlockedError` on a 403 or a captcha page, `CollectedError("nav_error")` for other
   * failures and HTTP >= 400.
   */
  goto(url: string, options: GotoOptions = {}): Promise<number | null> {
    return this.run({ type: "goto", target: domainOf(url) }, async () => {
      const response = await this.raw.goto(url, {
        timeout: options.timeoutMs ?? this.config.navigationTimeoutMs,
        waitUntil: options.waitUntil ?? "load",
      });
      const status = response?.status() ?? null;
      if (status === 403) throw new BlockedError("http_403", `HTTP 403 for ${url}`);
      if (status !== null && status >= 400) {
        throw new CollectedError("nav_error", `HTTP ${status} for ${url}`);
      }
      await this.throwIfCaptcha();
      return status;
    });
  }

  /** Clicks, then waits for any navigation it started to reach DOMContentLoaded. */
  click(selector: string, options: ActionOptions = {}): Promise<void> {
    const timeout = options.timeoutMs ?? this.config.actionTimeoutMs;
    return this.run({ type: "click", target: selector, selector }, async () => {
      await this.raw.click(selector, { timeout });
      await this.raw.waitForLoadState("domcontentloaded", { timeout }).catch(() => undefined);
      await this.throwIfCaptcha();
    });
  }

  /** Types a value into an input. The value is never recorded (it may be a password). */
  fill(selector: string, value: string, options: ActionOptions = {}): Promise<void> {
    const timeout = options.timeoutMs ?? this.config.actionTimeoutMs;
    return this.run({ type: "fill", target: selector, selector }, () =>
      this.raw.fill(selector, value, { timeout }),
    );
  }

  /** Number of elements matching the selector. Zero is a valid answer, not an error. */
  extract(selector: string, options: { as: "count" }): Promise<number>;
  /** Text of the first element matching the selector. Fails with `selector_not_found` if none. */
  extract(selector: string, options?: { as?: "text"; timeoutMs?: number }): Promise<string>;
  extract(
    selector: string,
    options: { as?: "text" | "count"; timeoutMs?: number } = {},
  ): Promise<string | number> {
    const timeout = options.timeoutMs ?? this.config.actionTimeoutMs;
    return this.run({ type: "extract", target: selector, selector }, async () => {
      const locator = this.raw.locator(selector);
      if (options.as === "count") return locator.count();
      return (await locator.first().textContent({ timeout })) ?? "";
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
      // Playwright reports "element not there" as a timeout; ask the page which one it really was.
      if (code === "timeout" && spec.selector && (await this.isMissing(spec.selector))) {
        code = "selector_not_found";
      }
      record(false, code);
      const kind = ISSUE_FOR_CODE[code];
      if (kind) this.sink.recordIssue(kind, shortMessage(error));
      if (error instanceof CollectedError && error.code === code) throw error;
      throw new CollectedError(code, shortMessage(error), { cause: error });
    }
  }

  private async isMissing(selector: string): Promise<boolean> {
    try {
      return (await this.raw.locator(selector).count()) === 0;
    } catch {
      return false;
    }
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
        this.sink.recordIssue("unsupported_api", `${error.name}: ${error.message}`.slice(0, 500), {
          once: true,
        });
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

/** Hostname of a URL, or the input itself (clipped) if it is not an absolute URL. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname || url.slice(0, 200);
  } catch {
    return url.slice(0, 200);
  }
}

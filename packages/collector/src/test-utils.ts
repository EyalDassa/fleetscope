import { EventEmitter } from "node:events";
import type { FleetEvent } from "@fleetscope/schema";
import { pino } from "pino";
import type { Page } from "playwright-core";
import type { CdpSessionLike } from "./cdp";
import { type Collector, type CollectorOptions, createCollector } from "./collector";
import type { CollectedError } from "./errors";
import { CAPTCHA_SELECTOR } from "./page";
import type { SendResult, Transport } from "./transport";

/** A logger that prints nothing. */
export const silentLogger = pino({ level: "silent" });

/** A transport that keeps every batch it is given and always accepts. */
export function recordingTransport(result?: (batch: readonly FleetEvent[]) => SendResult) {
  const batches: FleetEvent[][] = [];
  const transport: Transport = {
    async send(events) {
      batches.push([...events]);
      return result?.(events) ?? { status: "accepted", accepted: events.length, duplicates: 0 };
    },
  };
  return {
    transport,
    batches,
    get events(): FleetEvent[] {
      return batches.flat();
    },
  };
}

export function makeCollector(overrides: Partial<CollectorOptions> = {}) {
  const sink = recordingTransport();
  const collector: Collector = createCollector({
    apiUrl: "http://127.0.0.1:1",
    source: "real",
    agentId: "test-agent",
    provider: "local-docker",
    engine: "chromium",
    transport: sink.transport,
    logger: silentLogger,
    flushIntervalMs: 20,
    heapSampleIntervalMs: 0,
    ...overrides,
  });
  return { collector, sink };
}

export const sessionOptions = {
  scenario: "login-and-search",
  region: "local",
  engineVersion: "chromium 150.0",
  startupMs: 900,
  connectMs: 40,
};

export function timeoutError(message = "page.click: Timeout 5000ms exceeded."): Error {
  return Object.assign(new Error(message), { name: "TimeoutError" });
}

interface FakeRequest {
  url(): string;
  resourceType(): string;
  response(): Promise<{ status(): number } | null>;
  sizes(): Promise<{ responseBodySize: number; responseHeadersSize: number }>;
  timing(): { responseEnd: number };
}

export function fakeRequest(url: string, overrides: Partial<FakeRequest> = {}): FakeRequest {
  return {
    url: () => url,
    resourceType: () => "document",
    response: async () => ({ status: () => 200 }),
    sizes: async () => ({ responseBodySize: 900, responseHeadersSize: 100 }),
    timing: () => ({ responseEnd: 42.4 }),
    ...overrides,
  };
}

/** Just enough of a Playwright Page for CollectedPage: events plus a few scripted answers. */
export class FakePage extends EventEmitter {
  currentUrl = "about:blank";
  gotoStatus: number | null = 200;
  gotoError: Error | null = null;
  clickError: Error | null = null;
  evalError: Error | null = null;
  /** How many elements each selector matches (default 1). */
  counts: Record<string, number> = { [CAPTCHA_SELECTOR]: 0 };
  text = "hello";
  /** What `context().newCDPSession()` gives, or throws. */
  cdp: CdpSessionLike | Error = {
    send: async () => ({ metrics: [{ name: "JSHeapUsedSize", value: 5 * 1024 * 1024 }] }),
    detach: async () => undefined,
  };

  url = () => this.currentUrl;

  /** Statuses of the main-frame navigation responses the next click causes (redirects, then the page). */
  clickNavigations: number[] = [];
  private readonly mainFrameObject = { name: "main" };
  mainFrame = () => this.mainFrameObject;

  /** Emits what Playwright's "response" event would carry. */
  emitResponse(
    status: number,
    url: string,
    options: { navigation?: boolean; mainFrame?: boolean } = {},
  ) {
    const { navigation = true, mainFrame = true } = options;
    this.emit("response", {
      status: () => status,
      url: () => url,
      request: () => ({
        isNavigationRequest: () => navigation,
        frame: () => (mainFrame ? this.mainFrameObject : { name: "child" }),
      }),
    });
  }

  goto = async (url: string) => {
    if (this.gotoError) throw this.gotoError;
    this.currentUrl = url;
    return this.gotoStatus === null ? null : { status: () => this.gotoStatus as number };
  };
  click = async () => {
    if (this.clickError) throw this.clickError;
    // A click that navigates: the browser reports the response of every hop, the last one wins.
    for (const status of this.clickNavigations) this.emitResponse(status, "http://demo.test/next");
  };
  fill = async () => undefined;
  waitForLoadState = async () => undefined;
  waitForTimeout = async () => undefined;
  screenshot = async () => Buffer.from("png");
  evaluate = async () => {
    if (this.evalError) throw this.evalError;
    return 7;
  };
  locator = (selector: string) => {
    const count = async () => this.counts[selector] ?? 1;
    const first = () => ({
      textContent: async () => {
        if ((await count()) === 0) {
          throw timeoutError("locator.textContent: Timeout 100ms exceeded.");
        }
        return this.text;
      },
      waitFor: async () => undefined,
    });
    return { count, first };
  };
  context = () => ({
    newCDPSession: async () => {
      if (this.cdp instanceof Error) throw this.cdp;
      return this.cdp;
    },
  });

  asPage(): Page {
    return this as unknown as Page;
  }
}

/** The error a promise rejects with. Fails the test if it resolves instead. */
export async function rejection(promise: Promise<unknown>): Promise<CollectedError> {
  try {
    await promise;
  } catch (error) {
    return error as CollectedError;
  }
  throw new Error("expected the promise to reject");
}

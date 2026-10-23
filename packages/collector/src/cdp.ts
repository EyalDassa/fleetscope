import type { Logger } from "pino";

/** The two CDPSession methods we use, so tests can fake them. Playwright's CDPSession fits. */
export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
}

export interface HeapSamplerOptions {
  /** Opens a CDP session for the page, e.g. `() => page.context().newCDPSession(page)`. */
  open: () => Promise<CdpSessionLike>;
  /** Called with the used JS heap in MB, or `null` when it could not be read. */
  onSample: (jsHeapMb: number | null) => void;
  logger: Logger;
  intervalMs: number;
  /** Longest a single CDP call may take before it counts as a failure. Default 2000. */
  callTimeoutMs?: number;
}

const BYTES_PER_MB = 1024 * 1024;
const GONE = /closed|disconnected|detached|destroyed/i;

/**
 * Samples the page's JS heap through `Performance.getMetrics` every `intervalMs`.
 *
 * CDP is not guaranteed: an engine may not implement the `Performance` domain, or may not allow a
 * second CDP session at all. Then we say so with a single `null` sample and stop; we never throw
 * into the scenario. A call that fails later (page navigating or closing) also yields `null`.
 */
export class HeapSampler {
  private session: CdpSessionLike | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = false;

  constructor(private readonly options: HeapSamplerOptions) {}

  /** Takes the first sample and schedules the rest. Resolves once the first sample is out. */
  async start(): Promise<void> {
    const { logger } = this.options;
    try {
      this.session = await this.withTimeout(this.options.open());
      await this.withTimeout(this.session.send("Performance.enable"));
    } catch (error) {
      logger.debug({ err: error }, "CDP Performance not available, js_heap_mb will be null");
      this.options.onSample(null);
      await this.detach();
      this.stopped = true;
      return;
    }
    await this.tick();
    if (this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.detach();
  }

  private async tick(): Promise<void> {
    if (this.busy || this.stopped || !this.session) return;
    this.busy = true;
    try {
      const reply = await this.withTimeout(this.session.send("Performance.getMetrics"));
      if (this.stopped) return;
      this.options.onSample(readHeapMb(reply));
    } catch (error) {
      if (this.stopped) return;
      this.options.logger.debug({ err: error }, "Performance.getMetrics failed, sample is null");
      this.options.onSample(null);
      // The page or browser is gone: no point asking again.
      if (GONE.test(error instanceof Error ? error.message : String(error))) {
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
      }
    } finally {
      this.busy = false;
    }
  }

  private async detach(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (!session) return;
    try {
      await this.withTimeout(session.detach());
    } catch {
      // Already detached because the page closed. Nothing to do.
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    const ms = this.options.callTimeoutMs ?? 2000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`CDP call timed out after ${ms}ms`)), ms);
    });
    // The loser of the race may still reject later; swallow it so it is not an unhandled rejection.
    promise.catch(() => undefined);
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}

/** `JSHeapUsedSize` (bytes) from a `Performance.getMetrics` reply, in MB; `null` if it is missing. */
export function readHeapMb(reply: unknown): number | null {
  const metrics = (reply as { metrics?: { name?: unknown; value?: unknown }[] } | null)?.metrics;
  if (!Array.isArray(metrics)) return null;
  const heap = metrics.find((metric) => metric?.name === "JSHeapUsedSize");
  if (typeof heap?.value !== "number" || !Number.isFinite(heap.value) || heap.value < 0)
    return null;
  return heap.value / BYTES_PER_MB;
}

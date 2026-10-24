import { isMissingApiError } from "@fleetscope/collector";
import { demoUrl, tid } from "./steps";
import type { Scenario } from "./types";

const NODE_COUNTS = [2000, 5000, 10_000, 20_000] as const;
const IMAGE_COUNTS = [20, 50, 100, 200] as const;

interface Probe {
  ok?: boolean;
  error?: string;
  detail?: string;
}

/**
 * Reads /js-heavy's result (`{"webWorker":{"ok":false,"error":"timeout after 3000ms"},...}`) and
 * names the failed probes: `webWorker: timeout after 3000ms; cryptoSubtleDigest: ...`. `null` when
 * every probe passed. Text that is not that JSON is not evidence about the engine: `null`.
 *
 * The code says what the failure shows. Only an error that proves the API is absent (a
 * ReferenceError, a TypeError naming a known API: `isMissingApiError`) is `unsupported_api`. A probe
 * that ran out of time is `timeout`: on a busy machine that says nothing about the engine, so it
 * must not become a verdict that the engine lacks the API. Anything else is `js_error`.
 */
export function failedProbes(
  text: string,
): { code: "unsupported_api" | "timeout" | "js_error"; message: string } | null {
  let probes: Record<string, Probe>;
  try {
    probes = JSON.parse(text) as Record<string, Probe>;
  } catch {
    return null;
  }
  if (typeof probes !== "object" || probes === null) return null;
  const failed = Object.entries(probes)
    .filter(([, probe]) => probe?.ok === false)
    .map(([name, probe]) => ({ name, error: probe.error ?? "failed" }));
  if (failed.length === 0) return null;

  const absent = failed.some(({ error }) =>
    isMissingApiError({ name: /^(\w+):/.exec(error)?.[1], message: error }),
  );
  const timedOut = failed.some(({ error }) => /^timeout after \d+ms/i.test(error));
  return {
    code: absent ? "unsupported_api" : timedOut ? "timeout" : "js_error",
    message: failed.map(({ name, error }) => `${name}: ${error}`).join("; "),
  };
}

/**
 * Crawl pages that are expensive for a browser: a few large /heavy pages (many DOM nodes and image
 * requests), a slow page, and the JS-heavy page that uses Web APIs some engines lack. The sizes
 * are seeded, so sessions differ in CPU and memory use.
 */
export const heavyPageCrawl: Scenario = async (page, ctx) => {
  await page.goto(demoUrl(ctx, "/"));

  const visits = ctx.rng.int(2, 4);
  for (let i = 0; i < visits; i++) {
    const nodes = ctx.rng.pick(NODE_COUNTS);
    const images = ctx.rng.pick(IMAGE_COUNTS);
    await page.goto(demoUrl(ctx, `/heavy?nodes=${nodes}&images=${images}`));
    const summary = await page.extract(tid("heavy-summary"));
    const domSize = await page.eval<number>("document.getElementsByTagName('*').length");
    ctx.logger.debug({ summary, domSize }, "crawled a heavy page");
  }

  await page.goto(demoUrl(ctx, `/slow?ms=${ctx.rng.int(300, 1200)}`));
  await page.extract(tid("slow-result"));

  // The page's script runs five probes (up to 3 s each) and then sets data-status="done".
  await page.goto(demoUrl(ctx, "/js-heavy"));
  await page.wait(`${tid("js-result")}[data-status="done"]`, { timeoutMs: 20_000 });
  // A failed probe means the engine lacks that API: this extract fails with unsupported_api (and
  // an issue naming the probes), so the session ends `failed`. Only this page counts.
  await page.extract(tid("js-result"), { check: failedProbes });

  await page.screenshot();
};

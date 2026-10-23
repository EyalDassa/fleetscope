import { demoUrl, tid } from "./steps";
import type { Scenario } from "./types";

const NODE_COUNTS = [2000, 5000, 10_000, 20_000] as const;
const IMAGE_COUNTS = [20, 50, 100, 200] as const;

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

  await page.screenshot();
};

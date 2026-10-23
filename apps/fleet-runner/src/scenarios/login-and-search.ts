import type { CollectedPage } from "@fleetscope/collector";
import { demoUrl, isMissingElement, login, tid } from "./steps";
import type { Scenario, ScenarioContext } from "./types";

const SEARCH_TERMS = [
  "lamp",
  "keyboard",
  "camera",
  "headphones",
  "chair",
  "monitor",
  "mug",
] as const;

/** Chance that a session also visits the flaky page (its button is missing about half the time). */
const FLAKY_VISIT_CHANCE = 0.4;

/**
 * Sign in, search the shop, open the first result.
 *
 * Seeded chaos: some sessions then visit /flaky and click its button. If the button is missing the
 * agent tries once more on a fresh page; if it is missing again the session fails. That gives a
 * 10-session run a few failed actions and now and then a failed session, without any fake data.
 */
export const loginAndSearch: Scenario = async (page, ctx) => {
  await login(page, ctx);

  const term = ctx.rng.pick(SEARCH_TERMS);
  await page.goto(demoUrl(ctx, `/search?q=${term}`));
  const results = await page.extract(tid("search-result"), { as: "count" });
  if (results === 0) throw new Error(`search for "${term}" found nothing`);

  await page.click(tid("search-result"));
  const title = await page.extract(tid("item-title"));
  ctx.logger.debug({ term, results, title }, "opened a search result");

  if (ctx.rng.chance(FLAKY_VISIT_CHANCE)) {
    await clickFlakyButton(page, ctx);
  }
};

async function clickFlakyButton(page: CollectedPage, ctx: ScenarioContext): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    // A different seed per attempt, so the retry is a fresh roll of the site's dice.
    const seed = ctx.rng.int(1, 1_000_000);
    await page.goto(demoUrl(ctx, `/flaky?rate=0.5&seed=${seed}`));
    try {
      await page.click(tid("flaky-button"), { timeoutMs: 1500 });
      return;
    } catch (error) {
      if (!isMissingElement(error) || attempt === 2) throw error;
      ctx.logger.debug({ seed }, "flaky button missing, trying once more");
    }
  }
}

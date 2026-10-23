import { demoUrl, login, tid } from "./steps";
import type { Scenario } from "./types";

/** About one visit in five meets the bot wall (HTTP 403 or a CAPTCHA page). */
const BOTWALL_RATE = 0.2;

/**
 * Walk through the members area, sign in, put an item in the cart and fill in the checkout form.
 *
 * Seeded chaos: the first page is /botwall?rate=0.2. When the wall fires the page answers 403 or
 * shows a CAPTCHA, the collector raises a `BlockedError`, and the session ends as `blocked`.
 */
export const checkoutForm: Scenario = async (page, ctx) => {
  const wallSeed = ctx.rng.int(1, 1_000_000);
  await page.goto(demoUrl(ctx, `/botwall?rate=${BOTWALL_RATE}&seed=${wallSeed}`));

  await login(page, ctx);

  const itemId = ctx.rng.int(1, 200);
  await page.goto(demoUrl(ctx, `/item/${itemId}`));
  await page.extract(tid("item-title"));
  await page.click(tid("add-to-cart")); // the site redirects to /checkout

  await page.fill(tid("checkout-name"), "Ada Agent");
  await page.fill(tid("checkout-email"), "ada.agent@example.com");
  await page.fill(tid("checkout-address"), "1 Browser Lane, Fleet City");
  await page.click(tid("checkout-submit"));

  const confirmation = await page.extract(tid("order-confirmation"));
  ctx.logger.debug({ itemId, confirmation: confirmation.slice(0, 80) }, "order placed");
};

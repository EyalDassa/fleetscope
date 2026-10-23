import { CollectedError, type CollectedPage } from "@fleetscope/collector";
import type { ScenarioContext } from "./types";

/** The demo site's accepted login. */
export const DEMO_USER = "agent";
export const DEMO_PASSWORD = "fleetscope";

/** Selector for a `data-testid`, the stable handles the demo site promises. */
export const tid = (id: string): string => `[data-testid="${id}"]`;

export function demoUrl(ctx: ScenarioContext, path: string): string {
  return `${ctx.baseUrl}${path}`;
}

/** /login -> /dashboard. Fails if the site did not let us in. */
export async function login(page: CollectedPage, ctx: ScenarioContext): Promise<void> {
  await page.goto(demoUrl(ctx, "/login"));
  await page.fill(tid("login-user"), DEMO_USER);
  await page.fill(tid("login-pass"), DEMO_PASSWORD);
  await page.click(tid("login-submit"));
  if (!new URL(page.url()).pathname.startsWith("/dashboard")) {
    throw new Error(`login did not reach the dashboard (ended on ${page.url()})`);
  }
}

/** Error codes that mean "the element is not there (yet)" rather than "the browser is broken". */
const MISSING = new Set(["selector_not_found", "timeout"]);

/** True if `error` is a failed action because an element was missing or too slow. */
export function isMissingElement(error: unknown): boolean {
  return error instanceof CollectedError && MISSING.has(error.code);
}

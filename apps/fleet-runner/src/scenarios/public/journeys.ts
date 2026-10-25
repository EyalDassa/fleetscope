import type { CollectedPage } from "@fleetscope/collector";
import type { Rng } from "../../rng";
import type { Scenario, ScenarioContext } from "../types";
import { createSitePacer, type SitePacer } from "./pacer";
import type { SiteRun } from "./robots";
import type { Landmark } from "./sites";

/**
 * The read-only journeys through the public sites (docs/adr/0007), one per site. Each opens a page,
 * checks the landmark elements it relies on, follows a link or two and stops. They use only the
 * collector-wrapped page, so every step is an `action`, and they never change how the browser
 * presents itself (no user agent, header or locale: the engines are measured as they are).
 *
 * A page that loads but lacks its landmark fails with `site_layout` (collector `landmark`); a 403,
 * 429 or CAPTCHA is a `BlockedError` and ends the session `blocked`, which pauses the site.
 */

/** Elements that mean "this is a challenge page" when the landmark is missing. */
export const CHALLENGE_SELECTOR = [
  "iframe[src*='recaptcha']",
  "iframe[src*='hcaptcha']",
  "iframe[src*='captcha']",
  "#challenge-form",
  "#cf-challenge-running",
  ".cf-turnstile",
  "[data-testid='captcha']",
].join(", ");

/**
 * The pacer of a site: the one prepareSites put on the SiteRun, so that every session of the site
 * shares it. A SiteRun built by hand (tests) gets one, kept per SiteRun object.
 */
const fallbackPacers = new WeakMap<SiteRun, SitePacer>();
function pacerOf(siteRun: SiteRun): SitePacer {
  if (siteRun.pacer) return siteRun.pacer;
  let pacer = fallbackPacers.get(siteRun);
  if (!pacer) {
    pacer = createSitePacer();
    fallbackPacers.set(siteRun, pacer);
  }
  return pacer;
}

/** One of the items, chosen with the seeded generator. */
export function pickOne<T>(rng: Rng, items: readonly T[]): T {
  const item = items[rng.int(0, items.length - 1)];
  if (item === undefined) throw new Error("nothing to pick from");
  return item;
}

interface Journey {
  siteRun: SiteRun;
  /** Open `url`, then check each landmark (in order). */
  visit(page: CollectedPage, url: string, landmarks: readonly Landmark[]): Promise<void>;
  /** Check a landmark on the current page; returns the selector that matched. */
  expect(page: CollectedPage, landmark: Landmark): Promise<string>;
  /**
   * Links on the current page that a journey may follow: https, this site's host, allowed by
   * robots.txt, not the current page, passing `accept`. `textPattern` keeps links whose text matches.
   */
  links(
    page: CollectedPage,
    selector: string,
    accept: (url: URL) => boolean,
    textPattern?: RegExp,
  ): Promise<URL[]>;
  absolute(path: string): string;
}

function journeyFor(ctx: ScenarioContext): Journey {
  const siteRun = ctx.siteRun;
  if (!siteRun) throw new Error("a public scenario needs ctx.siteRun (the runner sets it)");
  const pacer = pacerOf(siteRun);
  const { descriptor } = siteRun;
  const expectLandmark = (page: CollectedPage, landmark: Landmark) =>
    page.landmark(landmark, { challengeSelector: CHALLENGE_SELECTOR });
  return {
    siteRun,
    absolute: (path) => `${descriptor.baseUrl}${path}`,
    expect: expectLandmark,
    async visit(page, url, landmarks) {
      await pacer.beforeNavigation(siteRun.minDelayMs, ctx.signal);
      await page.goto(url);
      for (const landmark of landmarks) await expectLandmark(page, landmark);
    },
    async links(page, selector, accept, textPattern) {
      const raw = await page.eval<string[]>(
        `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))` +
          `.filter(a => ${textPattern ? `${textPattern}.test(a.textContent || '')` : "true"})` +
          ".slice(0, 400).map(a => a.href)",
      );
      const here = new URL(page.url());
      const seen = new Set<string>();
      const found: URL[] = [];
      for (const href of raw) {
        let url: URL;
        try {
          url = new URL(href);
        } catch {
          continue;
        }
        url.hash = "";
        const key = url.toString();
        if (seen.has(key) || key === here.toString()) continue;
        seen.add(key);
        if (url.protocol !== "https:" || url.host !== descriptor.host) continue;
        if (!siteRun.allows(url.pathname + url.search) || !accept(url)) continue;
        found.push(url);
      }
      return found;
    },
  };
}

const landmarks = (ctx: ScenarioContext, name: string): Landmark => {
  const landmark = ctx.siteRun?.descriptor.landmarks[name];
  if (!landmark) throw new Error(`no landmark "${name}" for ${ctx.siteRun?.descriptor.site}`);
  return landmark;
};

/** An article, then 2 or 3 internal links from its text. */
export const wikiRead: Scenario = async (page, ctx) => {
  const journey = journeyFor(ctx);
  const read = [landmarks(ctx, "heading"), landmarks(ctx, "content")];
  await journey.visit(page, journey.absolute(pickOne(ctx.rng, journey.siteRun.paths)), read);
  for (let hop = ctx.rng.int(2, 3); hop > 0; hop--) {
    const matched = await journey.expect(page, [
      // the links are "/wiki/X" in one rendering of an article and "https://en.wikipedia.org/wiki/X"
      // in another (rel="mw:WikiLink"), hence *= and not ^=
      "#mw-content-text .mw-parser-output > p a[href*='/wiki/']",
      "#mw-content-text a[href*='/wiki/']",
    ]);
    // an article: /wiki/Name, no namespace (File:, Help:, Special: ...)
    const links = await journey.links(
      page,
      matched,
      (url) => /^\/wiki\/[^:]+$/.test(url.pathname) && url.pathname !== "/wiki/Main_Page",
    );
    if (links.length === 0) return;
    await journey.visit(page, pickOne(ctx.rng, links).toString(), read);
  }
};

/** A reference page, a link from its sidebar, and a check that the page has a code example. */
export const mdnRead: Scenario = async (page, ctx) => {
  const journey = journeyFor(ctx);
  const content = landmarks(ctx, "content");
  const entry = pickOne(ctx.rng, journey.siteRun.paths);
  await journey.visit(page, journey.absolute(entry), [content]);
  const sidebar = await journey.expect(page, landmarks(ctx, "sidebar"));
  // a page under the entry (Array -> Array/from): those have code examples, a section's landing page has none
  const links = await journey.links(page, sidebar, (url) => url.pathname.startsWith(`${entry}/`));
  if (links.length === 0) return;
  await journey.visit(page, pickOne(ctx.rng, links).toString(), [
    content,
    landmarks(ctx, "example"),
  ]);
};

/** A guide, then its next part. */
export const govukRead: Scenario = async (page, ctx) => {
  const journey = journeyFor(ctx);
  const content = landmarks(ctx, "content");
  await journey.visit(page, journey.absolute(pickOne(ctx.rng, journey.siteRun.paths)), [content]);
  const next = await journey.expect(page, landmarks(ctx, "next"));
  const links = await journey.links(page, next, () => true);
  const target = links[0];
  if (!target) return;
  await journey.visit(page, target.toString(), [content]);
};

/** A front page of stories, then the comments of one of them (30 s apart: the site's crawl-delay). */
export const hnRead: Scenario = async (page, ctx) => {
  const journey = journeyFor(ctx);
  await journey.visit(page, journey.absolute(pickOne(ctx.rng, journey.siteRun.paths)), [
    landmarks(ctx, "stories"),
  ]);
  const comments = await journey.expect(page, landmarks(ctx, "comments"));
  const links = await journey.links(
    page,
    comments,
    (url) => url.pathname === "/item" && url.searchParams.has("id"),
    /comment|discuss/,
  );
  if (links.length === 0) return;
  await journey.visit(page, pickOne(ctx.rng, links.slice(0, 15)).toString(), [
    landmarks(ctx, "thread"),
  ]);
};

/** The index of a manual, then a page of that manual (for the library: a module page). */
export const pydocsRead: Scenario = async (page, ctx) => {
  const journey = journeyFor(ctx);
  const content = landmarks(ctx, "content");
  const entry = pickOne(ctx.rng, journey.siteRun.paths);
  await journey.visit(page, journey.absolute(entry), [content]);
  const section = entry.slice(0, entry.lastIndexOf("/") + 1); // /3/library/
  const matched = await journey.expect(page, landmarks(ctx, "links"));
  const links = await journey.links(
    page,
    matched,
    (url) =>
      url.pathname.startsWith(section) &&
      url.pathname.endsWith(".html") &&
      !url.pathname.endsWith("/index.html"),
  );
  if (links.length === 0) return;
  await journey.visit(page, pickOne(ctx.rng, links).toString(), [content]);
};

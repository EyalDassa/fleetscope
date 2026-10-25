/**
 * The public sites the fleet visits next to the demo site (docs/adr/0007), one descriptor each.
 *
 * Everything here is read-only and needs no account. `paths` is an ALLOWLIST: the only pages a
 * journey may open directly (links a journey follows are checked against robots.txt too). Each run
 * drops from it any path that the site's robots.txt disallows for `*` at that moment (robots.ts).
 *
 * `landmarks` are the elements a journey relies on: when a page loads (HTTP 200) but none of the
 * selectors matches, the site probably changed and the session fails with `site_layout`, not with a
 * browser error. Each landmark has a fallback after the primary selector.
 *
 * Adding a site: the checklist in docs/adr/0007-public-sites.md.
 */

export const PUBLIC_SITES = ["wikipedia", "mdn", "govuk", "hackernews", "python-docs"] as const;
export type PublicSite = (typeof PUBLIC_SITES)[number];

/** A selector and its fallbacks (first one that matches wins). */
export type Landmark = readonly [string, ...string[]];

export interface SiteDescriptor {
  site: PublicSite;
  host: string;
  baseUrl: string;
  /** Real pages a journey may open directly. Paths only, starting with "/". */
  paths: readonly string[];
  /**
   * Least time between the start of two navigations in one session. The site's crawl-delay when it
   * states one (Hacker News 30 s), otherwise what the ADR sets (GOV.UK 10 s, the others 2 s).
   */
  minDelayMs: number;
  landmarks: Readonly<Record<string, Landmark>>;
}

export const SITES: Readonly<Record<PublicSite, SiteDescriptor>> = {
  wikipedia: {
    site: "wikipedia",
    host: "en.wikipedia.org",
    baseUrl: "https://en.wikipedia.org",
    paths: [
      "/wiki/Fleet_management",
      "/wiki/Web_browser",
      "/wiki/Headless_browser",
      "/wiki/Hypertext_Transfer_Protocol",
      "/wiki/Transport_Layer_Security",
      "/wiki/Computer_cluster",
      "/wiki/Benchmark_(computing)",
      "/wiki/Web_crawler",
    ],
    minDelayMs: 2000,
    landmarks: {
      heading: ["#firstHeading", "h1"],
      content: ["#mw-content-text", "main"],
    },
  },
  mdn: {
    site: "mdn",
    host: "developer.mozilla.org",
    baseUrl: "https://developer.mozilla.org",
    paths: [
      "/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array",
      "/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map",
      "/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set",
      "/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise",
      "/en-US/docs/Web/JavaScript/Reference/Global_Objects/String",
      "/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object",
    ],
    minDelayMs: 2000,
    landmarks: {
      content: ["main#content", "article"],
      sidebar: ["nav.left-sidebar a[href^='/en-US/docs/']", "aside a[href^='/en-US/docs/']"],
      example: ["pre", ".code-example"],
    },
  },
  govuk: {
    site: "govuk",
    host: "www.gov.uk",
    baseUrl: "https://www.gov.uk",
    // Multi-part guides: each has a "Next" link to its following part.
    paths: [
      "/state-pension",
      "/universal-credit",
      "/tax-on-your-private-pension",
      "/marriages-civil-partnerships-abroad",
      "/child-benefit",
      "/council-tax",
    ],
    minDelayMs: 10_000,
    landmarks: {
      content: ["main#content", "main"],
      next: [".govuk-pagination__next a", "a[rel='next']"],
    },
  },
  hackernews: {
    site: "hackernews",
    host: "news.ycombinator.com",
    baseUrl: "https://news.ycombinator.com",
    paths: ["/", "/news", "/ask", "/show", "/best"],
    // robots.txt: Crawl-delay: 30
    minDelayMs: 30_000,
    landmarks: {
      stories: ["tr.athing", "#hnmain"],
      comments: [".subtext a[href^='item?id=']", ".subtext a[href*='item?id=']"],
      thread: [".comment-tree", ".fatitem"],
    },
  },
  "python-docs": {
    site: "python-docs",
    host: "docs.python.org",
    baseUrl: "https://docs.python.org",
    // The index page of each manual; the journey follows a link inside the same manual.
    paths: [
      "/3/library/index.html",
      "/3/tutorial/index.html",
      "/3/reference/index.html",
      "/3/howto/index.html",
      "/3/using/index.html",
    ],
    minDelayMs: 2000,
    landmarks: {
      content: ["div.body", "main", "[role='main']"],
      links: ["div.body a.reference.internal", "a.reference.internal"],
    },
  },
};

export function isPublicSite(value: string): value is PublicSite {
  return (PUBLIC_SITES as readonly string[]).includes(value);
}

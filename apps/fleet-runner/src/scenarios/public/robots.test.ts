import { readFileSync } from "node:fs";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createPauseStore } from "./pause";
import { type Fetch, parseRobots, prepareSites } from "./robots";
import { PUBLIC_SITES, type PublicSite, SITES } from "./sites";

const logger = pino({ level: "silent" });

/** robots.txt files saved from the real sites on 2026-10-25 (no network in unit tests). */
const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}.robots.txt`, import.meta.url), "utf8");

describe("parseRobots", () => {
  it("uses the * group only", () => {
    const rules = parseRobots(
      "User-agent: googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\n",
    );
    expect(rules.allows("/public/page")).toBe(true);
    expect(rules.allows("/private/page")).toBe(false);
  });

  it("no * group, no robots.txt content, or an empty Disallow: everything is allowed", () => {
    expect(parseRobots("User-agent: bot\nDisallow: /\n").allows("/x")).toBe(true);
    expect(parseRobots("").allows("/x")).toBe(true);
    expect(parseRobots("User-agent: *\nDisallow:\n").allows("/x")).toBe(true);
  });

  it("the longest matching rule wins, and Allow wins a tie", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /a/\nAllow: /a/open/\nDisallow: /a/open/closed\nDisallow: /t\nAllow: /t\n",
    );
    expect(rules.allows("/a/x")).toBe(false);
    expect(rules.allows("/a/open/x")).toBe(true);
    expect(rules.allows("/a/open/closed/x")).toBe(false);
    expect(rules.allows("/t")).toBe(true); // same length: Allow
  });

  it("* matches any characters and a trailing $ anchors the end", () => {
    const bom = String.fromCharCode(0xfeff);
    const rules = parseRobots(`${bom}User-agent: *
Disallow: /private/
`);
    expect(rules.allows("/private/x")).toBe(false);
    expect(rules.allows("/ok")).toBe(true);
  });

  it("reads Crawl-delay of the * group in ms", () => {
    expect(parseRobots("User-agent: *\nCrawl-delay: 30\n").crawlDelayMs).toBe(30_000);
    expect(parseRobots("User-agent: bot\nCrawl-delay: 30\n").crawlDelayMs).toBeNull();
    expect(parseRobots("User-agent: *\nDisallow: /x\n").crawlDelayMs).toBeNull();
  });
});

describe("the saved robots.txt of the five sites", () => {
  const rules = (name: string) => parseRobots(fixture(name));

  it("every path of every allowlist is allowed today", () => {
    for (const site of PUBLIC_SITES) {
      const parsed = rules(site === "wikipedia" ? "wikipedia" : site);
      for (const path of SITES[site].paths)
        expect(parsed.allows(path), `${site} ${path}`).toBe(true);
    }
  });

  it("Wikipedia: articles yes; API, special pages and deletion discussions no", () => {
    const wiki = rules("wikipedia");
    expect(wiki.allows("/wiki/Web_browser")).toBe(true);
    expect(wiki.allows("/wiki/Benchmark_(computing)")).toBe(true);
    expect(wiki.allows("/w/index.php?title=Web_browser&action=edit")).toBe(false);
    expect(wiki.allows("/api/rest_v1/page/summary/Web_browser")).toBe(false);
    expect(wiki.allows("/wiki/Special:Random")).toBe(false);
    expect(wiki.allows("/wiki/Wikipedia:Articles_for_deletion/Foo")).toBe(false);
  });

  it("MDN: docs yes; /api/ and the files of any locale no", () => {
    const mdn = rules("mdn");
    expect(mdn.allows("/en-US/docs/Web/API/fetch")).toBe(true);
    expect(mdn.allows("/api/v1/whoami")).toBe(false);
    expect(mdn.allows("/en-US/files/1234/x.png")).toBe(false);
  });

  it("GOV.UK: guides yes; print views and site search no", () => {
    const gov = rules("govuk");
    expect(gov.allows("/state-pension/how-much-you-get")).toBe(true);
    expect(gov.allows("/state-pension/print")).toBe(false);
    expect(gov.allows("/search/all?keywords=tax")).toBe(false);
  });

  it("Hacker News: front pages and items yes; vote, reply, login no; asks for 30 s", () => {
    const hn = rules("hackernews");
    expect(hn.allows("/")).toBe(true);
    expect(hn.allows("/item?id=1234")).toBe(true);
    expect(hn.allows("/vote?id=1&how=up")).toBe(false);
    expect(hn.allows("/reply?id=1")).toBe(false);
    expect(hn.allows("/login")).toBe(false);
    expect(hn.crawlDelayMs).toBe(30_000);
  });

  it("Python docs: the current docs yes; old versions and /dev no", () => {
    const py = rules("python-docs");
    expect(py.allows("/3/library/json.html")).toBe(true);
    expect(py.allows("/3.9/library/json.html")).toBe(false);
    expect(py.allows("/2.7/library/json.html")).toBe(false);
    expect(py.allows("/dev/library/json.html")).toBe(false);
  });
});

/** A fetch that answers each site's robots.txt from `answers` (by host), 404 for the others. */
function fakeFetch(answers: Partial<Record<PublicSite, string | number | Error>>): {
  fetch: Fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetch: Fetch = async (url) => {
    urls.push(url);
    const site = PUBLIC_SITES.find((s) => url.startsWith(SITES[s].baseUrl));
    const answer = site ? answers[site] : undefined;
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") return new Response("", { status: answer });
    if (typeof answer === "string") return new Response(answer, { status: 200 });
    return new Response("", { status: 404 });
  };
  return { fetch, urls };
}

describe("prepareSites", () => {
  it("fetches /robots.txt of every site with plain fetch and keeps the allowed paths", async () => {
    const { fetch, urls } = fakeFetch({
      wikipedia: fixture("wikipedia"),
      mdn: fixture("mdn"),
      govuk: fixture("govuk"),
      hackernews: fixture("hackernews"),
      "python-docs": fixture("python-docs"),
    });
    const sites = await prepareSites({ logger, fetch });
    expect([...sites.keys()]).toEqual([...PUBLIC_SITES]);
    expect(urls.sort()).toEqual(PUBLIC_SITES.map((s) => `${SITES[s].baseUrl}/robots.txt`).sort());
    expect(sites.get("wikipedia")?.paths).toEqual(SITES.wikipedia.paths);
    // the delay: the descriptor's, or the site's Crawl-delay if longer
    expect(sites.get("hackernews")?.minDelayMs).toBe(30_000);
    expect(sites.get("govuk")?.minDelayMs).toBe(10_000);
    expect(sites.get("mdn")?.minDelayMs).toBe(2000);
  });

  it("drops a path that robots.txt now disallows, and keeps the site if others remain", async () => {
    const { fetch } = fakeFetch({
      govuk: "User-agent: *\nDisallow: /state-pension\nDisallow: /universal-credit\n",
    });
    const gov = (await prepareSites({ logger, fetch })).get("govuk");
    expect(gov?.paths).not.toContain("/state-pension");
    expect(gov?.paths).not.toContain("/universal-credit");
    expect(gov?.paths).toContain("/child-benefit");
    expect(gov?.allows("/state-pension/how-much-you-get")).toBe(false); // links are checked too
  });

  it("skips a site that has no allowed path left", async () => {
    const { fetch } = fakeFetch({ mdn: "User-agent: *\nDisallow: /\n" });
    const sites = await prepareSites({ logger, fetch });
    expect(sites.has("mdn")).toBe(false);
    expect(sites.has("wikipedia")).toBe(true); // 404 = no robots.txt = everything allowed
  });

  it("a robots.txt it cannot read (5xx, network error) means the site is skipped, not visited blindly", async () => {
    const { fetch } = fakeFetch({ govuk: 503, hackernews: new Error("socket hang up") });
    const sites = await prepareSites({ logger, fetch });
    expect(sites.has("govuk")).toBe(false);
    expect(sites.has("hackernews")).toBe(false);
  });

  it("gives every site a pacer, and keeps the same one when the sites are prepared again", async () => {
    const { fetch } = fakeFetch({});
    const pacers = new Map();
    const first = await prepareSites({ logger, fetch, pacers });
    const second = await prepareSites({ logger, fetch, pacers });
    for (const site of PUBLIC_SITES) {
      expect(first.get(site)?.pacer).toBeDefined();
      expect(second.get(site)?.pacer).toBe(first.get(site)?.pacer);
    }
    expect(first.get("mdn")?.pacer).not.toBe(first.get("govuk")?.pacer);
  });

  it("skips a paused site without fetching its robots.txt", async () => {
    const pause = createPauseStore();
    pause.pause("wikipedia", 2_000_000);
    const { fetch, urls } = fakeFetch({});
    const sites = await prepareSites({ logger, fetch, pause, now: () => 1_000_000 });
    expect(sites.has("wikipedia")).toBe(false);
    expect(urls.some((u) => u.includes("wikipedia"))).toBe(false);
    // once the pause is over it is back
    const later = await prepareSites({ logger, fetch, pause, now: () => 2_000_001 });
    expect(later.has("wikipedia")).toBe(true);
  });
});

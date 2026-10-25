import { BlockedError, CollectedError, type CollectedPage } from "@fleetscope/collector";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createRng } from "../../rng";
import type { ScenarioContext } from "../types";
import { govukRead, hnRead, mdnRead, pydocsRead, wikiRead } from "./journeys";
import { createSitePacer } from "./pacer";
import { parseRobots, type SiteRun } from "./robots";
import { type PublicSite, SITES } from "./sites";

const logger = pino({ level: "silent" });

/** What the pages of the fake site contain: links per selector, and which landmark selectors exist. */
interface FakePageSpec {
  /** Selectors that match something (landmarks). Others are missing. */
  present?: Set<string>;
  /** hrefs `eval` returns for a page, by URL. */
  links?: Record<string, string[]>;
  /** URLs whose goto is refused. */
  blocked?: Map<string, "http_403" | "captcha">;
}

class FakeSitePage {
  readonly calls: string[] = [];
  private current = "about:blank";
  constructor(private readonly spec: FakePageSpec = {}) {}
  url = () => this.current;
  goto = async (url: string) => {
    this.calls.push(`goto ${url}`);
    const code = this.spec.blocked?.get(url);
    if (code) throw new BlockedError(code, `blocked ${url}`);
    this.current = url;
    return 200;
  };
  landmark = async (selectors: readonly string[]) => {
    this.calls.push(`landmark ${selectors.join(" | ")}`);
    const found = selectors.find(
      (s) => this.spec.present === undefined || this.spec.present.has(s),
    );
    if (!found)
      throw new CollectedError("site_layout", `landmark missing: ${selectors.join(" | ")}`);
    return found;
  };
  eval = async () => {
    this.calls.push("eval");
    return this.spec.links?.[this.current] ?? [];
  };
  asPage = () => this as unknown as CollectedPage;
}

function siteRun(site: PublicSite, robots = "", only?: string[]): SiteRun {
  const descriptor = SITES[site];
  const rules = parseRobots(robots);
  const c = clock();
  const run: SiteRun = {
    descriptor,
    paths: only ?? descriptor.paths.filter((p) => rules.allows(p)),
    allows: (p) => rules.allows(p),
    minDelayMs: descriptor.minDelayMs,
    pacer: createSitePacer(c),
  };
  clocks.set(run, c);
  return run;
}

/** The fake clock behind a test SiteRun's pacer. */
const clocks = new WeakMap<SiteRun, ReturnType<typeof clock>>();
const clockOf = (run: SiteRun) => clocks.get(run) as ReturnType<typeof clock>;

function context(run: SiteRun, extra: Partial<ScenarioContext> = {}): ScenarioContext {
  return { baseUrl: "unused", rng: createRng(1), logger, siteRun: run, ...extra };
}

/** A clock that only moves when the journey sleeps. */
function clock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createSitePacer", () => {
  it("waits so that two navigations start at least minDelayMs apart, and not before the first", async () => {
    const c = clock();
    const pacer = createSitePacer(c);
    await pacer.beforeNavigation(30_000);
    expect(c.sleeps).toEqual([]);
    c.advance(4000); // the page took 4 s
    await pacer.beforeNavigation(30_000);
    expect(c.sleeps).toEqual([26_000]);
    c.advance(40_000); // slower than the delay: no extra wait
    await pacer.beforeNavigation(30_000);
    expect(c.sleeps).toEqual([26_000]);
  });

  it("callers that arrive together queue: each starts minDelayMs after the one before", async () => {
    // a real clock, so that waiting callers really overlap
    const starts: number[] = [];
    const pacer = createSitePacer();
    const t0 = Date.now();
    await Promise.all(
      [0, 1, 2, 3].map(async () => {
        await pacer.beforeNavigation(60);
        starts.push(Date.now() - t0);
      }),
    );
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) {
      expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThanOrEqual(55);
    }
  });

  it("the gap holds from the last navigation of one session to the first of the next", async () => {
    const run = siteRun("hackernews", "", ["/"]);
    const c = clockOf(run);
    const fake = () => new FakeSitePage({ links: { "https://news.ycombinator.com/": [] } });
    await hnRead(fake().asPage(), context(run)); // one navigation (no story links)
    c.advance(5000);
    await hnRead(fake().asPage(), context(run)); // the next session, 5 s later
    expect(c.sleeps).toEqual([25_000]);
  });

  it("two sessions running at the same time on one site never start navigations less than minDelayMs apart", async () => {
    // real timers and a short delay, so that the sessions really overlap
    const run = {
      ...siteRun("govuk", "", ["/state-pension"]),
      minDelayMs: 80,
      pacer: createSitePacer(),
    };
    const starts: number[] = [];
    const session = () => {
      const fake = new FakeSitePage({ links: { "https://www.gov.uk/state-pension": [] } });
      const goto = fake.goto;
      fake.goto = async (url: string) => {
        starts.push(Date.now());
        return goto(url);
      };
      return govukRead(fake.asPage(), context(run));
    };
    await Promise.all([session(), session(), session()]);
    starts.sort((x, y) => x - y);
    expect(starts).toHaveLength(3);
    // (timers can fire a few ms early)
    for (let i = 1; i < starts.length; i++) {
      expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThanOrEqual(75);
    }
  });
});

describe("journeys", () => {
  const wikiLinks = [
    "https://en.wikipedia.org/wiki/HTTP",
    "https://en.wikipedia.org/wiki/Special:Random", // a namespace page
    "https://en.wikipedia.org/wiki/File:Logo.png", // a namespace page
    "https://en.wikipedia.org/w/index.php?title=HTTP&action=edit", // robots.txt: /w/
    "https://en.wikipedia.org/wiki/Main_Page",
    "https://example.org/wiki/Other", // another host
    "https://en.wikipedia.org/wiki/TCP#History", // same page with an anchor: still /wiki/TCP
  ];

  it("wiki-read: an article, then 2 or 3 articles linked from it, never a namespace page or a forbidden path", async () => {
    const robots = "User-agent: *\nDisallow: /w/\nDisallow: /wiki/Special:\n";
    const run = siteRun("wikipedia", robots);
    const fake = new FakeSitePage({
      links: Object.fromEntries(
        [
          ...run.paths,
          "https://en.wikipedia.org/wiki/HTTP",
          "https://en.wikipedia.org/wiki/TCP",
        ].map((p) => [p.startsWith("http") ? p : `https://en.wikipedia.org${p}`, wikiLinks]),
      ),
    });
    const c = clockOf(run);
    await wikiRead(fake.asPage(), context(run));
    const visited = fake.calls.filter((x) => x.startsWith("goto ")).map((x) => x.slice(5));
    expect(visited.length).toBeGreaterThanOrEqual(3); // entry + 2..3 hops
    expect(visited.length).toBeLessThanOrEqual(4);
    expect(run.paths).toContain(new URL(visited[0] as string).pathname);
    for (const url of visited.slice(1)) {
      expect(["/wiki/HTTP", "/wiki/TCP"]).toContain(new URL(url).pathname);
      expect(url).not.toContain("#");
    }
    // 2 s between navigations
    expect(c.sleeps.every((ms) => ms <= 2000)).toBe(true);
  });

  it("a journey never opens an allowlisted path that robots.txt forbids", async () => {
    const run = siteRun("wikipedia", "User-agent: *\nDisallow: /wiki/Web_\n");
    expect(run.paths.some((p) => p.startsWith("/wiki/Web_"))).toBe(false);
    for (let seed = 1; seed <= 30; seed++) {
      const fake = new FakeSitePage();
      await wikiRead(fake.asPage(), context(run, { rng: createRng(seed) }));
      const first = fake.calls.find((x) => x.startsWith("goto ")) as string;
      expect(first).not.toContain("/wiki/Web_");
    }
  });

  it("hn-read: the front page, then the comments of a story, 30 s later", async () => {
    const robots = ["User-agent: *", "Crawl-delay: 30", "Disallow: /vote?"].join("\n");
    const run = siteRun("hackernews", robots, ["/"]);
    const front = "https://news.ycombinator.com/";
    const fake = new FakeSitePage({
      links: {
        [front]: [
          "https://news.ycombinator.com/item?id=111",
          "https://news.ycombinator.com/vote?id=111&how=up", // forbidden
          "https://news.ycombinator.com/item?id=222",
        ],
      },
    });
    const c = clockOf(run);
    await hnRead(fake.asPage(), context({ ...run, minDelayMs: 30_000 }));
    const visited = fake.calls.filter((x) => x.startsWith("goto ")).map((x) => x.slice(5));
    expect(visited).toHaveLength(2);
    expect(visited[0]).toBe(front);
    expect([
      "https://news.ycombinator.com/item?id=111",
      "https://news.ycombinator.com/item?id=222",
    ]).toContain(visited[1]);
    expect(c.sleeps).toEqual([30_000]); // the second page waits the crawl-delay out
  });

  it("mdn-read: a docs page, a sidebar link, and a check for a code example", async () => {
    const run = siteRun("mdn", "", ["/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map"]);
    const page =
      "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map";
    const fake = new FakeSitePage({
      links: {
        [page]: [
          "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/get",
          "https://developer.mozilla.org/en-US/plus", // not docs
          "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects", // a landing page: no example
        ],
      },
    });
    await mdnRead(fake.asPage(), context(run));
    expect(fake.calls.filter((x) => x.startsWith("goto "))).toEqual([
      `goto ${page}`,
      "goto https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/get",
    ]);
    expect(fake.calls.at(-1)).toBe("landmark pre | .code-example"); // the code example check
  });

  it("pydocs-read: the index of a manual, then a page of the same manual", async () => {
    const run = siteRun("python-docs", "", ["/3/library/index.html"]);
    const index = "https://docs.python.org/3/library/index.html";
    const fake = new FakeSitePage({
      links: {
        [index]: [
          "https://docs.python.org/3/library/json.html",
          "https://docs.python.org/3/reference/index.html", // another manual
          "https://docs.python.org/3.9/library/os.html", // forbidden below
        ],
      },
    });
    const forbidden = siteRun("python-docs", "User-agent: *\nDisallow: /3.9/\n", [
      "/3/library/index.html",
    ]);
    await pydocsRead(fake.asPage(), context({ ...run, allows: forbidden.allows }));
    expect(fake.calls.filter((x) => x.startsWith("goto "))).toEqual([
      `goto ${index}`,
      "goto https://docs.python.org/3/library/json.html",
    ]);
  });

  it("a page that loads without its landmark fails the journey with site_layout (not a browser error)", async () => {
    const run = siteRun("wikipedia");
    const fake = new FakeSitePage({ present: new Set() });
    const error = await wikiRead(fake.asPage(), context(run)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CollectedError);
    expect((error as CollectedError).code).toBe("site_layout");
  });

  it("a refusal on the first page is a BlockedError and stops the journey there", async () => {
    const run = siteRun("govuk");
    const url = `https://www.gov.uk${run.paths[0]}`;
    for (const code of ["http_403", "captcha"] as const) {
      const fake = new FakeSitePage({
        blocked: new Map(run.paths.map((p) => [`https://www.gov.uk${p}`, code])),
      });
      const { govukRead } = await import("./journeys");
      const error = await govukRead(fake.asPage(), context(run)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BlockedError);
      expect(fake.calls.filter((x) => x.startsWith("goto "))).toHaveLength(1);
    }
    expect(url).toContain("gov.uk");
  });

  it("needs ctx.siteRun (the runner provides it)", async () => {
    const fake = new FakeSitePage();
    await expect(
      wikiRead(fake.asPage(), { baseUrl: "x", rng: createRng(1), logger }),
    ).rejects.toThrow(/siteRun/);
  });
});

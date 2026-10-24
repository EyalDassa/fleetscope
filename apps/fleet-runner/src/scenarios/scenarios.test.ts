import { BlockedError, CollectedError, type CollectedPage } from "@fleetscope/collector";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createRng, type Rng } from "../rng";
import { failedProbes } from "./heavy-page-crawl";
import { SCENARIO_NAMES, SCENARIOS, type ScenarioName, scenarioFor } from "./index";
import type { ScenarioContext } from "./types";

const BASE = "http://localhost:3100";
const logger = pino({ level: "silent" });

/**
 * The test ids the demo site promises (see the M1 plan) plus the three the chaos pages use. If a
 * scenario reaches for any other element, this test fails and someone has to check the site has it.
 */
const KNOWN_TEST_IDS = new Set([
  "login-user",
  "login-pass",
  "login-submit",
  "search-result",
  "item-title",
  "add-to-cart",
  "checkout-name",
  "checkout-email",
  "checkout-address",
  "checkout-submit",
  "order-confirmation",
  "flaky-button",
  "heavy-summary",
  "slow-result",
  "js-result",
]);

interface FakeOptions {
  /** Selectors whose click/extract fails, as a missing element would. */
  missing?: Set<string>;
  /** What /js-heavy's `js-result` contains. */
  jsResult?: string;
  /** URL paths whose goto is refused. */
  blockedPaths?: Set<string>;
}

/** A page that only writes down what it is asked to do. */
class RecordingPage {
  readonly calls: string[] = [];
  private currentUrl = "about:blank";

  constructor(private readonly options: FakeOptions = {}) {}

  url = () => this.currentUrl;

  goto = async (url: string) => {
    this.calls.push(`goto ${url}`);
    const { pathname } = new URL(url);
    if (this.options.blockedPaths?.has(pathname))
      throw new BlockedError("http_403", `HTTP 403 for ${url}`);
    this.currentUrl = url;
    return 200;
  };
  fill = async (selector: string, value: string) => {
    this.calls.push(`fill ${selector} ${value}`);
  };
  click = async (selector: string) => {
    this.calls.push(`click ${selector}`);
    if (this.options.missing?.has(selector)) {
      throw new CollectedError("selector_not_found", `no element for ${selector}`);
    }
    if (selector.includes("login-submit")) this.currentUrl = `${BASE}/dashboard`;
  };
  extract = async (
    selector: string,
    options?: {
      as?: string;
      check?: (
        text: string,
      ) => { code: "unsupported_api" | "timeout" | "js_error"; message: string } | null;
    },
  ): Promise<string | number> => {
    this.calls.push(`extract ${selector}`);
    if (options?.check) {
      const problem = options.check(this.options.jsResult ?? '{"webWorker":{"ok":true}}');
      if (problem) throw new CollectedError(problem.code, problem.message);
    }
    if (this.options.missing?.has(selector)) {
      throw new CollectedError("selector_not_found", `no element for ${selector}`);
    }
    return options?.as === "count" ? 12 : "some text";
  };
  eval = async (script: string) => {
    this.calls.push(`eval ${script}`);
    return 1234;
  };
  wait = async (what: number | string) => {
    this.calls.push(`wait ${what}`);
  };
  screenshot = async () => {
    this.calls.push("screenshot");
    return Buffer.from("");
  };

  asPage(): CollectedPage {
    return this as unknown as CollectedPage;
  }
}

function contextWith(rng: Rng): ScenarioContext {
  return { baseUrl: BASE, rng, logger };
}

/** A generator that makes every random choice the same way: the first option, chance = `chance`. */
function fixedRng(chance: boolean): Rng {
  return { next: () => 0, int: (min) => min, chance: () => chance, pick: (items) => items[0] };
}

async function run(name: ScenarioName, seed: number, options?: FakeOptions) {
  const page = new RecordingPage(options);
  await SCENARIOS[name](page.asPage(), contextWith(createRng(seed)));
  return page.calls;
}

describe("scenarioFor", () => {
  it("a named scenario is used for every session", () => {
    for (let i = 0; i < 5; i++) expect(scenarioFor("checkout-form", i, 99)).toBe("checkout-form");
  });

  it("mix goes round-robin through all three scenarios", () => {
    const picks = Array.from({ length: 6 }, (_, i) => scenarioFor("mix", i, 0));
    expect(picks.slice(0, 3).sort()).toEqual([...SCENARIO_NAMES].sort());
    expect(picks.slice(3)).toEqual(picks.slice(0, 3));
  });

  it("the seed picks where the round-robin starts", () => {
    const starts = new Set([0, 1, 2].map((seed) => scenarioFor("mix", 0, seed)));
    expect(starts.size).toBe(3);
  });
});

describe("every scenario", () => {
  for (const name of SCENARIO_NAMES) {
    it(`${name}: uses only known test ids and stays on the demo site`, async () => {
      for (let seed = 0; seed < 40; seed++) {
        const calls = await run(name, seed);
        for (const call of calls) {
          for (const match of call.matchAll(/data-testid="([^"]+)"/g)) {
            expect(KNOWN_TEST_IDS.has(match[1] as string), `${name}: ${call}`).toBe(true);
          }
          if (call.startsWith("goto ")) expect(call.slice(5).startsWith(`${BASE}/`)).toBe(true);
        }
      }
    });

    it(`${name}: makes at least 5 actions`, async () => {
      for (let seed = 0; seed < 20; seed++) {
        expect((await run(name, seed)).length).toBeGreaterThanOrEqual(5);
      }
    });

    it(`${name}: the same seed does exactly the same thing`, async () => {
      expect(await run(name, 7)).toEqual(await run(name, 7));
    });
  }

  it("different seeds make different choices", async () => {
    const runs = new Set<string>();
    for (let seed = 0; seed < 20; seed++) runs.add((await run("heavy-page-crawl", seed)).join("|"));
    expect(runs.size).toBeGreaterThan(5);
  });
});

describe("login-and-search", () => {
  it("signs in with the demo account, searches, and opens a result", async () => {
    const calls = await run("login-and-search", 1);
    expect(calls.slice(0, 5)).toEqual([
      `goto ${BASE}/login`,
      'fill [data-testid="login-user"] agent',
      'fill [data-testid="login-pass"] fleetscope',
      'click [data-testid="login-submit"]',
      expect.stringMatching(new RegExp(`^goto ${BASE}/search\\?q=[a-z]+$`)),
    ]);
    expect(calls).toContain('click [data-testid="search-result"]');
    expect(calls).toContain('extract [data-testid="item-title"]');
  });

  it("fails when the login does not reach the dashboard", async () => {
    const page = new RecordingPage();
    page.click = async () => undefined; // the site never redirects
    await expect(
      SCENARIOS["login-and-search"](page.asPage(), contextWith(createRng(1))),
    ).rejects.toThrow(/did not reach the dashboard/);
  });

  it("fails when the search finds nothing", async () => {
    const page = new RecordingPage();
    page.extract = async () => 0;
    await expect(
      SCENARIOS["login-and-search"](page.asPage(), contextWith(createRng(1))),
    ).rejects.toThrow(/found nothing/);
  });

  it("visits the flaky page in some sessions but not all", async () => {
    const visits = [];
    for (let seed = 0; seed < 60; seed++) {
      visits.push((await run("login-and-search", seed)).some((c) => c.includes("/flaky?")));
    }
    expect(visits.filter(Boolean).length).toBeGreaterThan(10);
    expect(visits.filter((v) => !v).length).toBeGreaterThan(10);
  });

  it("a missing flaky button is retried once on a fresh page, then the session fails", async () => {
    const page = new RecordingPage({ missing: new Set(['[data-testid="flaky-button"]']) });
    await expect(
      SCENARIOS["login-and-search"](page.asPage(), contextWith(fixedRng(true))),
    ).rejects.toMatchObject({ code: "selector_not_found" });
    expect(page.calls.filter((c) => c.includes("/flaky?")).length).toBe(2);
  });

  it("a flaky button that shows up on the second try is a success", async () => {
    const page = new RecordingPage();
    let clicks = 0;
    const originalClick = page.click;
    page.click = async (selector: string) => {
      if (selector.includes("flaky-button") && clicks++ === 0) {
        page.calls.push(`click ${selector}`);
        throw new CollectedError("selector_not_found", "missing");
      }
      return originalClick(selector);
    };
    await SCENARIOS["login-and-search"](page.asPage(), contextWith(fixedRng(true)));
    expect(page.calls.filter((c) => c.includes("/flaky?")).length).toBe(2);
  });

  it("does not hide a real failure (browser closed) behind the retry", async () => {
    const page = new RecordingPage();
    const originalClick = page.click;
    page.click = async (selector: string) => {
      if (selector.includes("flaky-button")) throw new CollectedError("browser_closed", "gone");
      return originalClick(selector);
    };
    await expect(
      SCENARIOS["login-and-search"](page.asPage(), contextWith(fixedRng(true))),
    ).rejects.toMatchObject({ code: "browser_closed" });
    expect(page.calls.filter((c) => c.includes("/flaky?")).length).toBe(1);
  });
});

describe("checkout-form", () => {
  it("starts at /botwall?rate=0.2 with a seed, then logs in and checks out", async () => {
    const calls = await run("checkout-form", 3);
    expect(calls[0]).toMatch(new RegExp(`^goto ${BASE}/botwall\\?rate=0\\.2&seed=\\d+$`));
    expect(calls).toContain('click [data-testid="add-to-cart"]');
    expect(calls).toContain('click [data-testid="checkout-submit"]');
    expect(calls.at(-1)).toBe('extract [data-testid="order-confirmation"]');
  });

  it("ends blocked right at the wall, before it signs in", async () => {
    const page = new RecordingPage({ blockedPaths: new Set(["/botwall"]) });
    await expect(
      SCENARIOS["checkout-form"](page.asPage(), contextWith(createRng(1))),
    ).rejects.toBeInstanceOf(BlockedError);
    expect(page.calls).toHaveLength(1);
  });
});

describe("heavy-page-crawl", () => {
  it("crawls two to four heavy pages, a slow page, the js page, and takes a screenshot", async () => {
    for (let seed = 0; seed < 20; seed++) {
      const calls = await run("heavy-page-crawl", seed);
      const heavy = calls.filter((c) => c.includes("/heavy?"));
      expect(heavy.length).toBeGreaterThanOrEqual(2);
      expect(heavy.length).toBeLessThanOrEqual(4);
      for (const call of heavy) {
        const url = new URL(call.slice(5));
        expect(Number(url.searchParams.get("nodes"))).toBeLessThanOrEqual(20_000);
        expect(Number(url.searchParams.get("images"))).toBeLessThanOrEqual(200);
      }
      expect(calls.some((c) => c.includes("/slow?ms="))).toBe(true);
      expect(calls.some((c) => c.endsWith("/js-heavy"))).toBe(true);
      expect(calls.at(-1)).toBe("screenshot");
    }
  });

  it("waits for the js probes to finish, with room for their 3 s timeouts", async () => {
    const calls = await run("heavy-page-crawl", 1);
    expect(calls).toContain('wait [data-testid="js-result"][data-status="done"]');
  });

  async function crawlWith(jsResult: string) {
    const page = new RecordingPage({ jsResult });
    return (await SCENARIOS["heavy-page-crawl"](page as unknown as CollectedPage, {
      baseUrl: BASE,
      rng: createRng(1),
      logger,
    }).catch((e: unknown) => e)) as CollectedError;
  }

  it("a /js-heavy probe that proves the API is absent fails the scenario with unsupported_api", async () => {
    const error = await crawlWith(
      '{"intersectionObserver":{"ok":true},"webWorker":{"ok":false,"error":"ReferenceError: Worker is not defined"}}',
    );
    expect(error).toBeInstanceOf(CollectedError);
    expect(error.code).toBe("unsupported_api");
    expect(error.message).toBe("webWorker: ReferenceError: Worker is not defined");
  });

  it("a /js-heavy probe that timed out is a timeout, not a missing API (R-M3-05)", async () => {
    const error = await crawlWith('{"webWorker":{"ok":false,"error":"timeout after 3000ms"}}');
    expect(error.code).toBe("timeout");
    expect(error.message).toBe("webWorker: timeout after 3000ms");
  });

  it("passing probes change nothing", async () => {
    const calls = await run("heavy-page-crawl", 1);
    expect(calls).toContain('extract [data-testid="js-result"]');
    expect(calls.at(-1)).toBe("screenshot");
  });
});

describe("failedProbes", () => {
  it("names every failed probe and ignores passing ones", () => {
    expect(
      failedProbes('{"a":{"ok":true},"b":{"ok":false,"error":"boom"},"c":{"ok":false}}'),
    ).toEqual({ code: "js_error", message: "b: boom; c: failed" });
    expect(failedProbes('{"a":{"ok":true}}')).toBeNull();
  });
  it("only an error that shows the API is absent is unsupported_api", () => {
    const code = (error: string) => failedProbes(JSON.stringify({ p: { ok: false, error } }))?.code;
    expect(code("ReferenceError: Worker is not defined")).toBe("unsupported_api");
    expect(code("TypeError: IntersectionObserver is not a constructor")).toBe("unsupported_api");
    expect(code("TypeError: Cannot read properties of undefined (reading 'digest')")).toBe(
      "unsupported_api",
    );
    expect(code("timeout after 3000ms")).toBe("timeout");
    expect(code("Error: something else")).toBe("js_error");
  });
  it("a real absence wins over a timeout in the same page", () => {
    const result = failedProbes(
      '{"a":{"ok":false,"error":"timeout after 3000ms"},"b":{"ok":false,"error":"ReferenceError: X is not defined"}}',
    );
    expect(result?.code).toBe("unsupported_api");
  });
  it("text that is not the probe JSON is not evidence", () => {
    expect(failedProbes("")).toBeNull();
    expect(failedProbes("not json")).toBeNull();
    expect(failedProbes("null")).toBeNull();
  });
});

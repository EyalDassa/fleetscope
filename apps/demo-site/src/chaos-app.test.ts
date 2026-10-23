import { Script } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JS_PROBE_SCRIPT } from "./js-probe";
import { count, get, login, makeApp, post, type TestApp } from "./testing";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.app.close();
});

async function setChaos(body: unknown) {
  return t.app.inject({
    method: "POST",
    url: "/admin/chaos",
    payload: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ZERO = { latencyMs: 0, flakyRate: 0, botwallRate: 0, errorRate: 0 };

describe("/admin/chaos", () => {
  it("starts with everything off", async () => {
    const res = await get(t.app, "/admin/chaos");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ZERO);
  });

  it("POST sets the given fields and keeps the others, GET reads them back", async () => {
    const first = await setChaos({ latencyMs: 250, errorRate: 0.5 });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ...ZERO, latencyMs: 250, errorRate: 0.5 });

    const second = await setChaos({ botwallRate: 0.2 });
    expect(second.json()).toEqual({ ...ZERO, latencyMs: 250, errorRate: 0.5, botwallRate: 0.2 });
    expect((await get(t.app, "/admin/chaos")).json()).toEqual(second.json());
  });

  it("DELETE resets everything", async () => {
    await setChaos({ latencyMs: 250, errorRate: 0.5, flakyRate: 0.3, botwallRate: 0.1 });
    const res = await t.app.inject({ method: "DELETE", url: "/admin/chaos" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ZERO);
    expect((await get(t.app, "/admin/chaos")).json()).toEqual(ZERO);
  });

  it("answers 400 and changes nothing for invalid input", async () => {
    await setChaos({ errorRate: 0.5 });
    for (const bad of [
      { errorRate: 2 },
      { latencyMs: 30001 },
      { latencyMs: -1 },
      { flakyRate: "0.3" },
      { unknown: 1 },
      [1, 2],
    ]) {
      const res = await setChaos(bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    const notJson = await t.app.inject({
      method: "POST",
      url: "/admin/chaos",
      payload: "{oops",
      headers: { "content-type": "application/json" },
    });
    expect(notJson.statusCode).toBe(400);
    expect((await get(t.app, "/admin/chaos")).json()).toEqual({ ...ZERO, errorRate: 0.5 });
  });

  it("treats an empty body, even with a JSON content type, as no change", async () => {
    const empty = await t.app.inject({
      method: "POST",
      url: "/admin/chaos",
      headers: { "content-type": "application/json" },
    });
    expect(empty.statusCode).toBe(200);
    const del = await t.app.inject({
      method: "DELETE",
      url: "/admin/chaos",
      headers: { "content-type": "application/json" },
    });
    expect(del.statusCode).toBe(200);
  });
});

describe("global chaos applies to pages", () => {
  it("errorRate 1 makes pages answer 500, but not health, admin or images", async () => {
    await setChaos({ errorRate: 1 });
    for (const url of ["/", "/login", "/heavy", "/slow", "/flaky", "/botwall", "/js-heavy"]) {
      const res = await get(t.app, url);
      expect(res.statusCode, url).toBe(500);
      expect(res.body).toContain('data-testid="server-error"');
    }
    const cookieless = await get(t.app, "/dashboard");
    expect(cookieless.statusCode).toBe(500);

    expect((await get(t.app, "/healthz")).statusCode).toBe(200);
    expect((await get(t.app, "/admin/chaos")).statusCode).toBe(200);
    expect((await get(t.app, "/img/1.svg")).statusCode).toBe(200);
  });

  it("query parameters override the global settings", async () => {
    await setChaos({ errorRate: 1, latencyMs: 400 });
    const res = await get(t.app, "/login?errorRate=0&latencyMs=0");
    expect(res.statusCode).toBe(200);
    expect(t.sleeps).toEqual([]);

    const raised = await get(t.app, "/login?errorRate=1");
    expect(raised.statusCode).toBe(500);
  });

  it("latencyMs delays pages but not health, admin or images", async () => {
    await setChaos({ latencyMs: 700 });
    await get(t.app, "/login");
    expect(t.sleeps).toEqual([700]);
    await get(t.app, "/healthz");
    await get(t.app, "/admin/chaos");
    await get(t.app, "/img/2.svg");
    expect(t.sleeps).toEqual([700]);
  });

  it("botwallRate 1 gives a 403 or a 200 CAPTCHA page, about half each", async () => {
    await setChaos({ botwallRate: 1 });
    let forbidden = 0;
    let captcha = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const res = await get(t.app, `/login?seed=${seed}`);
      if (res.statusCode === 403) {
        forbidden += 1;
        expect(res.body).toContain('data-testid="botwall-blocked"');
      } else {
        captcha += 1;
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('data-testid="captcha"');
        expect(res.body).not.toContain('data-testid="login-submit"');
      }
    }
    expect(forbidden).toBeGreaterThan(15);
    expect(captcha).toBeGreaterThan(15);
  });

  it("flakyRate 1 leaves out add-to-cart and checkout-submit", async () => {
    const cookie = await login(t.app);
    await setChaos({ flakyRate: 1 });
    const item = await get(t.app, "/item/3", cookie);
    expect(item.statusCode).toBe(200);
    expect(item.body).toContain('data-testid="item-title"');
    expect(item.body).not.toContain('data-testid="add-to-cart"');
    const checkout = await get(t.app, "/checkout", cookie);
    expect(checkout.body).toContain('data-testid="checkout-email"');
    expect(checkout.body).not.toContain('data-testid="checkout-submit"');
  });

  it("only affects GET pages: forms still work with every page broken", async () => {
    await setChaos({ errorRate: 1, botwallRate: 1, latencyMs: 500 });
    const res = await post(t.app, "/login", { user: "agent", pass: "fleetscope" });
    expect(res.statusCode).toBe(303);
    expect(t.sleeps).toEqual([]);
  });

  it("DELETE puts the pages back to normal", async () => {
    await setChaos({ errorRate: 1 });
    expect((await get(t.app, "/login")).statusCode).toBe(500);
    await t.app.inject({ method: "DELETE", url: "/admin/chaos" });
    expect((await get(t.app, "/login")).statusCode).toBe(200);
  });
});

describe("?seed makes the random choices repeatable", () => {
  it("gives the same status for the same seed, and both outcomes across seeds", async () => {
    await setChaos({ errorRate: 0.5 });
    const statuses: number[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const first = (await get(t.app, `/login?seed=${seed}`)).statusCode;
      const again = (await get(t.app, `/login?seed=${seed}`)).statusCode;
      expect(again, `seed ${seed}`).toBe(first);
      statuses.push(first);
    }
    expect(statuses).toContain(500);
    expect(statuses).toContain(200);
  });

  it("is not tied to the page: the same seed rolls the same dice everywhere", async () => {
    await setChaos({ errorRate: 0.5 });
    for (let seed = 1; seed <= 20; seed++) {
      const a = (await get(t.app, `/login?seed=${seed}`)).statusCode;
      const b = (await get(t.app, `/?seed=${seed}`)).statusCode;
      expect(a).toBe(b);
    }
  });

  it("without a seed, uses the injected random source", async () => {
    const draws = [0.9, 0.9, 0.9, 0.9, 0.0, 0.9, 0.9, 0.9];
    const { buildApp } = await import("./app");
    const app = await buildApp({ logLevel: false, random: () => draws.shift() ?? 0.99 });
    await app.inject({
      method: "POST",
      url: "/admin/chaos",
      payload: JSON.stringify({ errorRate: 0.5 }),
      headers: { "content-type": "application/json" },
    });
    expect((await app.inject({ method: "GET", url: "/login" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/login" })).statusCode).toBe(500);
    await app.close();
  });
});

describe("/slow", () => {
  it("waits 2000 ms by default", async () => {
    const res = await get(t.app, "/slow");
    expect(res.statusCode).toBe(200);
    expect(t.sleeps).toEqual([2000]);
    expect(res.body).toContain('data-testid="slow-result" data-waited-ms="2000"');
  });

  it("waits the requested time and never more than 30 s", async () => {
    await get(t.app, "/slow?ms=150");
    await get(t.app, "/slow?ms=999999");
    await get(t.app, "/slow?ms=-5");
    await get(t.app, "/slow?ms=abc");
    expect(t.sleeps).toEqual([150, 30_000, 2000]);
  });

  it("does not wait at all for ms=0", async () => {
    await get(t.app, "/slow?ms=0");
    expect(t.sleeps).toEqual([]);
  });

  it("caps the global latency too", async () => {
    await get(t.app, "/slow?latencyMs=99999999");
    expect(t.sleeps).toEqual([30_000]);
  });
});

describe("/flaky", () => {
  it("always shows the button at rate 0 and never at rate 1", async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const shown = await get(t.app, `/flaky?rate=0&seed=${seed}`);
      expect(shown.body).toContain('data-testid="flaky-button"');
      const missing = await get(t.app, `/flaky?rate=1&seed=${seed}`);
      expect(missing.statusCode).toBe(200);
      expect(missing.body).not.toContain('data-testid="flaky-button"');
      expect(missing.body).toContain("Flaky page");
    }
  });

  it("misses the button with about the requested probability", async () => {
    let missing = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const res = await get(t.app, `/flaky?rate=0.3&seed=${seed}`);
      if (!res.body.includes('data-testid="flaky-button"')) missing += 1;
    }
    expect(missing).toBeGreaterThan(35);
    expect(missing).toBeLessThan(85);
  });

  it("is repeatable for a seed", async () => {
    const a = await get(t.app, "/flaky?rate=0.5&seed=11");
    const b = await get(t.app, "/flaky?rate=0.5&seed=11");
    expect(a.body).toBe(b.body);
  });

  it("uses the global flakyRate when the query is silent", async () => {
    await setChaos({ flakyRate: 1 });
    const res = await get(t.app, "/flaky");
    expect(res.body).not.toContain('data-testid="flaky-button"');
  });
});

describe("/botwall", () => {
  it("is a normal page that links on at rate 0", async () => {
    const res = await get(t.app, "/botwall?rate=0");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-testid="botwall-ok"');
    expect(res.body).toContain('data-testid="botwall-next"');
    expect(res.body).toContain('href="/botwall?rate=0&amp;step=2"');
  });

  it("counts steps and keeps the rate in the next link", async () => {
    const res = await get(t.app, "/botwall?rate=0&step=7");
    expect(res.body).toContain("step 7");
    expect(res.body).toContain('href="/botwall?rate=0&amp;step=8"');
  });

  it("gives a 403 or a CAPTCHA at rate 1, repeatable per seed", async () => {
    const outcomes = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const res = await get(t.app, `/botwall?rate=1&seed=${seed}`);
      const kind = res.statusCode === 403 ? "403" : res.body.includes("captcha") ? "captcha" : "ok";
      outcomes.add(kind);
      const again = await get(t.app, `/botwall?rate=1&seed=${seed}`);
      expect(again.statusCode).toBe(res.statusCode);
    }
    expect([...outcomes].sort()).toEqual(["403", "captcha"]);
  });

  it("blocks about the requested share of requests", async () => {
    let blocked = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const res = await get(t.app, `/botwall?rate=0.2&seed=${seed}`);
      if (!res.body.includes('data-testid="botwall-ok"')) blocked += 1;
    }
    expect(blocked).toBeGreaterThan(20);
    expect(blocked).toBeLessThan(60);
  });

  it("uses 0.2 when nothing sets a rate", async () => {
    let blocked = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const res = await get(t.app, `/botwall?seed=${seed}`);
      if (!res.body.includes('data-testid="botwall-ok"')) blocked += 1;
    }
    expect(blocked).toBeGreaterThan(20);
    expect(blocked).toBeLessThan(60);
  });
});

describe("/heavy and /img", () => {
  it("renders the default 5000 nodes and 50 images", async () => {
    const res = await get(t.app, "/heavy");
    expect(res.statusCode).toBe(200);
    expect(count(res.body, '<div class="n">')).toBe(5000);
    expect(count(res.body, 'class="thumb"')).toBe(50);
    expect(res.body).toContain('data-nodes="5000" data-images="50"');
    expect(res.body).toContain('src="/img/1.svg"');
    expect(res.body).toContain('src="/img/50.svg"');
  });

  it("follows the query and caps it", async () => {
    const small = await get(t.app, "/heavy?nodes=12&images=3");
    expect(count(small.body, '<div class="n">')).toBe(12);
    expect(count(small.body, 'class="thumb"')).toBe(3);

    const none = await get(t.app, "/heavy?nodes=0&images=0");
    expect(count(none.body, '<div class="n">')).toBe(0);
    expect(count(none.body, 'class="thumb"')).toBe(0);

    const huge = await get(t.app, "/heavy?nodes=999999&images=99999");
    expect(count(huge.body, '<div class="n">')).toBe(50_000);
    expect(count(huge.body, 'class="thumb"')).toBe(500);
  });

  it("serves small generated SVGs, the same every time", async () => {
    const a = await get(t.app, "/img/7.svg");
    const b = await get(t.app, "/img/7.svg");
    const other = await get(t.app, "/img/8.svg");
    expect(a.statusCode).toBe(200);
    expect(a.headers["content-type"]).toContain("image/svg+xml");
    expect(a.body).toMatch(/^<svg /);
    expect(a.body.length).toBeLessThan(1000);
    expect(a.body).toBe(b.body);
    expect(a.body).not.toBe(other.body);
  });

  it("answers 404 for anything that is not /img/<number>.svg", async () => {
    for (const url of ["/img/abc.svg", "/img/7.png", "/img/7", "/img/1234567.svg"]) {
      expect((await get(t.app, url)).statusCode, url).toBe(404);
    }
  });
});

describe("/js-heavy", () => {
  it("has the result element and runs the five Web API probes", async () => {
    const res = await get(t.app, "/js-heavy");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-testid="js-result"');
    for (const api of [
      "new IntersectionObserver",
      "new ResizeObserver",
      "crypto.subtle.digest",
      "new Worker",
      "requestIdleCallback(",
      "URL.createObjectURL",
    ]) {
      expect(res.body, api).toContain(api);
    }
  });

  it("is valid JavaScript", () => {
    expect(() => new Script(JS_PROBE_SCRIPT)).not.toThrow();
  });

  it("calls the APIs directly instead of checking whether they exist", () => {
    // An engine without an API must fail with a real ReferenceError or TypeError.
    expect(JS_PROBE_SCRIPT).not.toMatch(/typeof\s+(IntersectionObserver|ResizeObserver|Worker)/);
    expect(JS_PROBE_SCRIPT).not.toMatch(/typeof\s+crypto|typeof\s+requestIdleCallback/);
    expect(JS_PROBE_SCRIPT).not.toMatch(
      /['"](IntersectionObserver|ResizeObserver|Worker)['"]\s+in\s/,
    );
    expect(JS_PROBE_SCRIPT).not.toMatch(/window\.(IntersectionObserver|ResizeObserver|Worker)/);
    expect(JS_PROBE_SCRIPT).not.toMatch(/\bin window\b/);
  });

  it("records an error and throws it again, uncaught, when an API is missing", async () => {
    // Run the page script in a sandbox that lacks every API. It should report ReferenceError /
    // TypeError for each probe, and rethrow them from timers (what a browser reports as page errors).
    const { runInNewContext } = await import("node:vm");
    const attributes: Record<string, string> = {};
    const result = {
      textContent: "",
      setAttribute: (k: string, v: string) => {
        attributes[k] = v;
      },
    };
    const thrown: unknown[] = [];
    const sandbox = {
      document: {
        getElementById: () => ({}),
        querySelector: (sel: string) => (sel.includes("js-result") ? result : null),
      },
      // Only the zero-delay timers (the rethrow) run. The 3 s probe timeouts never fire.
      setTimeout: (fn: () => void, ms: number) => {
        if (ms === 0) {
          try {
            fn();
          } catch (error) {
            thrown.push(error);
          }
        }
        return 1;
      },
      clearTimeout: () => {},
    };
    runInNewContext(JS_PROBE_SCRIPT, sandbox);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const parsed = JSON.parse(result.textContent) as Record<
      string,
      { ok: boolean; error?: string }
    >;
    expect(Object.keys(parsed)).toHaveLength(5);
    for (const probe of Object.values(parsed)) {
      expect(probe.ok).toBe(false);
      expect(probe.error).toMatch(/^(ReferenceError|TypeError): /);
    }
    expect(attributes["data-status"]).toBe("done");
    expect(attributes["data-failed"]).toBe("5");
    expect(thrown).toHaveLength(5);
    expect(
      thrown
        .map((e) => (e as Error).name)
        .every((n) => n === "ReferenceError" || n === "TypeError"),
    ).toBe(true);
  });
});

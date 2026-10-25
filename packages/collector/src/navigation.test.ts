import { EventBatch, type FleetEvent } from "@fleetscope/schema";
import { describe, expect, it } from "vitest";
import { BlockedError, CollectedError } from "./errors";
import { FakePage, makeCollector, rejection, sessionOptions } from "./test-utils";

function ofType<T extends FleetEvent["type"]>(events: FleetEvent[], type: T) {
  return events.filter((e): e is Extract<FleetEvent, { type: T }> => e.type === type);
}

async function setup() {
  const { collector, sink } = makeCollector();
  const session = collector.startSession(sessionOptions);
  const fake = new FakePage();
  const page = await session.collectPage(fake.asPage());
  const events = async () => {
    await collector.flush();
    return sink.events;
  };
  return { collector, sink, session, fake, page, events };
}

describe("a click that lands on an error page (R-M1-04)", () => {
  it("403: the click fails with http_403, raises a blocked issue, and the session can end blocked", async () => {
    const { session, fake, page, events } = await setup();
    fake.clickNavigations = [403];
    const error = await rejection(page.click("#go"));

    expect(error).toBeInstanceOf(BlockedError);
    expect(error.code).toBe("http_403");
    expect(session.issueKinds.has("blocked")).toBe(true);
    const all = await events();
    expect(ofType(all, "action")[0]).toMatchObject({
      action_type: "click",
      ok: false,
      error_code: "http_403",
    });
    expect(ofType(all, "issue")[0]).toMatchObject({ kind: "blocked" });
  });

  it("500: the click fails with http_5xx and a nav_error issue, with a clear message", async () => {
    const { session, fake, page, events } = await setup();
    fake.clickNavigations = [503];
    const error = await rejection(page.click("#go"));

    expect(error).not.toBeInstanceOf(BlockedError);
    expect(error.code).toBe("http_5xx");
    expect(error.message).toBe("HTTP 503 for http://demo.test/next");
    expect(session.issueKinds.has("nav_error")).toBe(true);
    const all = await events();
    expect(ofType(all, "action")[0]).toMatchObject({ ok: false, error_code: "http_5xx" });
    expect(ofType(all, "issue")[0]).toMatchObject({ kind: "nav_error" });
  });

  it("404: nav_error, like a goto to a missing page", async () => {
    const { fake, page } = await setup();
    fake.clickNavigations = [404];
    expect((await rejection(page.click("#go"))).code).toBe("nav_error");
  });

  it("a redirect chain is judged by its last hop: 303 then 200 is fine, 303 then 403 is blocked", async () => {
    const { fake, page } = await setup();
    fake.clickNavigations = [303, 200];
    await expect(page.click("#go")).resolves.toBeUndefined();
    fake.clickNavigations = [303, 403];
    expect((await rejection(page.click("#go"))).code).toBe("http_403");
  });

  it("a click that does not navigate is not judged by an earlier page's status", async () => {
    const { fake, page } = await setup();
    fake.clickNavigations = [403];
    await rejection(page.click("#go"));
    fake.clickNavigations = []; // the next click stays on the page
    await expect(page.click("#other")).resolves.toBeUndefined();
  });

  it("a 403 on an image, a script or a frame inside the page is not a blocked page", async () => {
    const { fake, page } = await setup();
    fake.click = async () => {
      fake.emitResponse(403, "http://demo.test/ad.js", { navigation: false });
      fake.emitResponse(403, "http://demo.test/frame", { navigation: true, mainFrame: false });
      fake.emitResponse(200, "http://demo.test/next");
    };
    await expect(page.click("#go")).resolves.toBeUndefined();
  });

  it("fill is checked too, and a normal 200 passes", async () => {
    const { fake, page } = await setup();
    fake.fill = async () => {
      fake.emitResponse(200, "http://demo.test/ok");
    };
    await expect(page.fill("#q", "x")).resolves.toBeUndefined();
    fake.fill = async () => {
      fake.emitResponse(403, "http://demo.test/wall");
    };
    expect((await rejection(page.fill("#q", "x"))).code).toBe("http_403");
  });

  it("goto: a server error is http_5xx, a 403 is http_403, a 404 is nav_error", async () => {
    const { fake, page } = await setup();
    fake.gotoStatus = 500;
    expect((await rejection(page.goto("http://x.test/"))).code).toBe("http_5xx");
    fake.gotoStatus = 502;
    expect((await rejection(page.goto("http://x.test/"))).code).toBe("http_5xx");
    fake.gotoStatus = 403;
    expect((await rejection(page.goto("http://x.test/"))).code).toBe("http_403");
    fake.gotoStatus = 404;
    expect((await rejection(page.goto("http://x.test/"))).code).toBe("nav_error");
    fake.gotoStatus = 301;
    await expect(page.goto("http://x.test/")).resolves.toBe(301);
  });

  it("everything it writes is valid against the schema", async () => {
    const { session, fake, page, events } = await setup();
    fake.clickNavigations = [403];
    await rejection(page.click("#go"));
    await session.endSession("blocked", "HTTP 403 for http://demo.test/next");
    expect(EventBatch.safeParse(await events()).success).toBe(true);
  });

  it("a CollectedError is what scenarios catch", async () => {
    const { fake, page } = await setup();
    fake.clickNavigations = [500];
    expect(await rejection(page.click("#go"))).toBeInstanceOf(CollectedError);
  });
});

describe("a runner that closes the browser itself (QA-M1-08)", () => {
  it("raises no crash issue for the action it cut off, but the action still says browser_closed", async () => {
    const { session, fake, page, events } = await setup();
    session.beginShutdown();
    fake.clickError = new Error("page.click: Target page, context or browser has been closed");
    const error = await rejection(page.click("#go"));

    expect(error.code).toBe("browser_closed");
    expect(session.issueKinds.has("crash")).toBe(false);
    const all = await events();
    expect(ofType(all, "action")[0]).toMatchObject({ ok: false, error_code: "browser_closed" });
    expect(ofType(all, "issue")).toHaveLength(0);
  });

  it("without a shutdown, a closed browser is still a crash", async () => {
    const { session, fake, page } = await setup();
    fake.clickError = new Error("page.click: Target page, context or browser has been closed");
    await rejection(page.click("#go"));
    expect(session.issueKinds.has("crash")).toBe(true);
  });

  it("other issues still count during a shutdown (a blocked page is blocked)", async () => {
    const { session, fake, page } = await setup();
    session.beginShutdown();
    fake.gotoStatus = 403;
    await rejection(page.goto("http://x.test/"));
    expect(session.issueKinds.has("blocked")).toBe(true);
  });
});

describe("every session that does not succeed says why", () => {
  it("fills in a reason when the caller gives none", async () => {
    const { collector, sink, session } = await setup();
    await session.endSession("failed");
    await collector.flush();
    const ended = ofType(sink.events, "session.ended")[0];
    expect(ended?.reason).toBe("no reason recorded");
  });

  it("an empty or blank reason counts as none; success keeps null", async () => {
    const a = await setup();
    await a.session.endSession("timeout", "   ");
    await a.collector.flush();
    expect(ofType(a.sink.events, "session.ended")[0]?.reason).toBe("no reason recorded");

    const b = await setup();
    await b.session.endSession("success", null);
    await b.collector.flush();
    expect(ofType(b.sink.events, "session.ended")[0]?.reason).toBeNull();
  });
});

describe("container samples carry the time the reading was taken", () => {
  it("uses readAt as ts, but never before the session started or in the future", async () => {
    const { collector, sink, session } = await setup();
    const now = Date.now();
    session.recordContainerSample({
      cpuPct: 1,
      memMb: 2,
      netRxBytes: 3,
      netTxBytes: 4,
      readAt: now - 5,
    });
    session.recordContainerSample({
      cpuPct: 1,
      memMb: 2,
      netRxBytes: 3,
      netTxBytes: 4,
      readAt: now - 60_000,
    });
    session.recordContainerSample({
      cpuPct: 1,
      memMb: 2,
      netRxBytes: 3,
      netTxBytes: 4,
      readAt: now + 60_000,
    });
    await collector.flush();
    const started = ofType(sink.events, "session.started")[0]?.ts ?? 0;
    const samples = ofType(sink.events, "resource.sample");
    expect(samples[0]?.ts).toBe(Math.max(now - 5, started));
    expect(samples[1]?.ts).toBe(started);
    expect(samples[2]?.ts).toBeLessThanOrEqual(Date.now());
  });
});

describe("429 and the landmark check (docs/adr/0007)", () => {
  it("a goto answered 429 is a block: BlockedError, http_429 (not http_403), a blocked issue", async () => {
    const { session, fake, page } = await setup();
    fake.gotoStatus = 429;
    const error = await rejection(page.goto("https://news.test/"));
    expect(error).toBeInstanceOf(BlockedError);
    expect(error.code).toBe("http_429");
    expect(error.message).toContain("429");
    expect(session.issueKinds.has("blocked")).toBe(true);
  });

  it("a click that lands on a 429 page fails with http_429 and a blocked issue", async () => {
    const { session, fake, page, events } = await setup();
    fake.clickNavigations = [429];
    const error = await rejection(page.click("#go"));
    expect(error).toBeInstanceOf(BlockedError);
    expect(error.code).toBe("http_429");
    expect(session.issueKinds.has("blocked")).toBe(true);
    expect(ofType(await events(), "action")[0]).toMatchObject({
      ok: false,
      error_code: "http_429",
    });
  });

  it("landmark: the first selector that matches is returned", async () => {
    const { fake, page } = await setup();
    fake.counts = { "#main": 1 };
    await expect(page.landmark(["#main"], { timeoutMs: 20 })).resolves.toBe("#main");
  });

  it("landmark: falls back to the second selector", async () => {
    const { fake, page, events } = await setup();
    fake.counts = { "#new": 0, "#old": 2 };
    await expect(page.landmark(["#new", "#old"], { timeoutMs: 20 })).resolves.toBe("#old");
    expect(ofType(await events(), "action")[0]).toMatchObject({ ok: true, action_type: "extract" });
  });

  it("landmark: no landmark but a challenge page -> captcha (blocked), not site_layout", async () => {
    const { session, fake, page, events } = await setup();
    fake.counts = { "#main": 0, "iframe.captcha": 1 };
    const error = await rejection(
      page.landmark(["#main"], { timeoutMs: 20, challengeSelector: "iframe.captcha" }),
    );
    expect(error).toBeInstanceOf(BlockedError);
    expect(error.code).toBe("captcha");
    expect(session.issueKinds.has("captcha")).toBe(true);
    expect(ofType(await events(), "action")[0]).toMatchObject({ ok: false, error_code: "captcha" });
  });

  it("landmark: none matches -> site_layout, no issue, the session is not blamed on the browser", async () => {
    const { session, fake, page, events } = await setup();
    fake.counts = { "#new": 0, "#old": 0 };
    const error = await rejection(page.landmark(["#new", "#old"], { timeoutMs: 20 }));
    expect(error.code).toBe("site_layout");
    expect(error).not.toBeInstanceOf(BlockedError);
    expect(session.issueKinds.size).toBe(0);
    const all = await events();
    expect(ofType(all, "action")[0]).toMatchObject({ ok: false, error_code: "site_layout" });
    expect(ofType(all, "issue")).toHaveLength(0);
    expect(EventBatch.safeParse(all).success).toBe(true);
  });
});

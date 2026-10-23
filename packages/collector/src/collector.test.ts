import { EventBatch, type FleetEvent } from "@fleetscope/schema";
import { describe, expect, it } from "vitest";
import { BlockedError, CollectedError } from "./errors";
import {
  FakePage,
  fakeRequest,
  makeCollector,
  recordingTransport,
  rejection,
  sessionOptions,
  timeoutError,
} from "./test-utils";

function ofType<T extends FleetEvent["type"]>(events: FleetEvent[], type: T) {
  return events.filter((e): e is Extract<FleetEvent, { type: T }> => e.type === type);
}

async function setup(overrides: Parameters<typeof makeCollector>[0] = {}) {
  const { collector, sink } = makeCollector(overrides);
  const session = collector.startSession(sessionOptions);
  const fake = new FakePage();
  const page = await session.collectPage(fake.asPage());
  const events = async () => {
    await collector.flush();
    return sink.events;
  };
  return { collector, sink, session, fake, page, events };
}

describe("session lifecycle", () => {
  it("sends session.started first and session.ended last, all valid against the schema", async () => {
    const { collector, sink, session, fake, page, events } = await setup();
    await page.goto("http://demo.test/login");
    await page.click("[data-testid=login-submit]");
    fake.emit(
      "pageerror",
      Object.assign(new Error("Worker is not defined"), { name: "ReferenceError" }),
    );
    await session.endSession("success", null);
    session.recordContainerSample({ cpuPct: 1, memMb: 2, netRxBytes: 3, netTxBytes: 4 }); // too late
    const all = await events();

    expect(EventBatch.safeParse(all).success).toBe(true);
    expect(all[0]?.type).toBe("session.started");
    expect(all.at(-1)?.type).toBe("session.ended");
    expect(ofType(all, "session.ended")).toHaveLength(1);
    expect(sink.events.filter((e) => e.type === "resource.sample")).toHaveLength(0);
    await collector.close();
  });

  it("puts the envelope, startup and connect times on session.started", async () => {
    const { collector, sink } = makeCollector({ agentId: "fleet-runner@box" });
    const session = collector.startSession({ ...sessionOptions, sessionId: "abc" });
    await collector.flush();

    expect(sink.events[0]).toMatchObject({
      type: "session.started",
      session_id: "abc",
      source: "real",
      agent_id: "fleet-runner@box",
      engine: "chromium",
      provider: "local-docker",
      engine_version: "chromium 150.0",
      scenario: "login-and-search",
      region: "local",
      startup_ms: 900,
      connect_ms: 40,
    });
    expect(session.sessionId).toBe("abc");
    await collector.close();
  });

  it("generates a session id when none is given", async () => {
    const { collector } = makeCollector();
    const a = collector.startSession(sessionOptions);
    const b = collector.startSession(sessionOptions);
    expect(a.sessionId).not.toBe(b.sessionId);
    await collector.close();
  });

  it("endSession records status, reason and the duration since startSession", async () => {
    const { collector, sink, session } = await setup();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await session.endSession("blocked", "HTTP 403");
    await collector.flush();

    const ended = ofType(sink.events, "session.ended")[0];
    expect(ended).toMatchObject({ status: "blocked", reason: "HTTP 403" });
    expect(ended?.duration_ms).toBeGreaterThanOrEqual(25);
    await collector.close();
  });

  it("endSession twice sends one session.ended", async () => {
    const { collector, sink, session } = await setup();
    await session.endSession("success");
    await session.endSession("failed", "again");
    await collector.flush();
    expect(ofType(sink.events, "session.ended")).toHaveLength(1);
    await collector.close();
  });

  it("many sessions keep their own order in the shared queue", async () => {
    const { collector, sink } = makeCollector();
    const sessions = [1, 2, 3].map((n) =>
      collector.startSession({ ...sessionOptions, sessionId: `s${n}` }),
    );
    for (const s of sessions) await s.endSession("success");
    await collector.close();

    for (const id of ["s1", "s2", "s3"]) {
      const types = sink.events.filter((e) => e.session_id === id).map((e) => e.type);
      expect(types).toEqual(["session.started", "session.ended"]);
    }
  });

  it("records container samples with all four metrics", async () => {
    const { collector, sink, session } = await setup();
    session.recordContainerSample({
      cpuPct: 12.5,
      memMb: 300.25,
      netRxBytes: 1000.4,
      netTxBytes: 50,
    });
    await collector.flush();
    expect(ofType(sink.events, "resource.sample")[0]).toMatchObject({
      origin: "container",
      cpu_pct: 12.5,
      mem_mb: 300.25,
      net_rx_bytes: 1000,
      net_tx_bytes: 50,
    });
    await collector.close();
  });
});

describe("actions", () => {
  it("one action event per call, numbered from 0, with the target and a duration", async () => {
    const { session, fake, page, events } = await setup();
    await page.goto("http://demo.test:3100/login");
    await page.fill("[data-testid=login-user]", "agent");
    await page.click("[data-testid=login-submit]");
    expect(await page.extract("[data-testid=search-result]", { as: "count" })).toBe(1);
    expect(await page.extract("h1")).toBe("hello");
    await page.wait(10);
    await page.screenshot();
    expect(await page.eval(() => 7)).toBe(7);
    await session.endSession("success");

    const actions = ofType(await events(), "action");
    expect(actions.map((a) => [a.seq, a.action_type, a.target])).toEqual([
      [0, "goto", "demo.test"],
      [1, "fill", "[data-testid=login-user]"],
      [2, "click", "[data-testid=login-submit]"],
      [3, "extract", "[data-testid=search-result]"],
      [4, "extract", "h1"],
      [5, "wait", "10ms"],
      [6, "screenshot", "demo.test"],
      [7, "eval", "function"],
    ]);
    expect(actions.every((a) => a.ok && a.error_code === null && a.duration_ms >= 0)).toBe(true);
    expect(session.actionCount).toBe(8);
    expect(fake.currentUrl).toBe("http://demo.test:3100/login");
  });

  it("never records the text typed into fill", async () => {
    const { session, page, events } = await setup();
    await page.fill("[data-testid=login-pass]", "fleetscope");
    await session.endSession("success");
    expect(JSON.stringify(await events())).not.toContain('fleetscope"');
  });

  it("action ts is when the action started, and a slow action shows its duration", async () => {
    const { fake, page, events } = await setup();
    const before = Date.now();
    fake.goto = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { status: () => 200 };
    };
    await page.goto("http://demo.test/");
    const action = ofType(await events(), "action")[0];
    expect(action?.duration_ms).toBeGreaterThanOrEqual(35);
    expect(action?.ts).toBeGreaterThanOrEqual(before);
    expect((action?.ts ?? 0) + (action?.duration_ms ?? 0)).toBeLessThanOrEqual(Date.now() + 5);
  });

  it("a Playwright timeout on a present element is error_code timeout, with a timeout issue", async () => {
    const { fake, page, events } = await setup();
    fake.clickError = timeoutError();
    const error = await rejection(page.click("#slow"));

    expect(error).toBeInstanceOf(CollectedError);
    expect(error.code).toBe("timeout");
    const all = await events();
    expect(ofType(all, "action")[0]).toMatchObject({ ok: false, error_code: "timeout" });
    expect(ofType(all, "issue")[0]).toMatchObject({ kind: "timeout" });
  });

  it("a timeout on a selector that matches nothing is selector_not_found, with no issue", async () => {
    const { fake, page, events } = await setup();
    fake.counts["#ghost"] = 0;
    fake.clickError = timeoutError();
    const error = await rejection(page.click("#ghost"));

    expect(error.code).toBe("selector_not_found");
    expect(error.message).toBe("selector not found: #ghost (page.click: Timeout 5000ms exceeded.)");
    const all = await events();
    expect(ofType(all, "action")[0]).toMatchObject({ ok: false, error_code: "selector_not_found" });
    expect(ofType(all, "issue")).toHaveLength(0);
  });

  it("extract text of a missing element fails with selector_not_found", async () => {
    const { fake, page, events } = await setup();
    fake.counts["#ghost"] = 0;
    const error = await rejection(page.extract("#ghost"));
    expect(error.code).toBe("selector_not_found");
    expect(ofType(await events(), "action")[0]).toMatchObject({
      action_type: "extract",
      ok: false,
    });
  });

  it("extract count of a missing element is zero, not an error", async () => {
    const { fake, page, events } = await setup();
    fake.counts[".row"] = 0;
    expect(await page.extract(".row", { as: "count" })).toBe(0);
    expect(ofType(await events(), "action")[0]).toMatchObject({ ok: true });
  });

  it("navigation errors are nav_error, with a nav_error issue", async () => {
    const { fake, page, events } = await setup();
    fake.gotoError = new Error(
      "page.goto: net::ERR_CONNECTION_REFUSED at http://x.test/\nCall log:\n...",
    );
    const error = await rejection(page.goto("http://x.test/"));

    expect(error.code).toBe("nav_error");
    const all = await events();
    expect(ofType(all, "action")[0]).toMatchObject({ error_code: "nav_error", target: "x.test" });
    expect(ofType(all, "issue")[0]).toMatchObject({
      kind: "nav_error",
      message: "page.goto: net::ERR_CONNECTION_REFUSED at http://x.test/", // first line only
    });
  });

  it("a goto that times out is timeout, not nav_error", async () => {
    const { fake, page } = await setup();
    fake.gotoError = timeoutError("page.goto: Timeout 30000ms exceeded.");
    const error = await rejection(page.goto("http://x.test/"));
    expect(error.code).toBe("timeout");
  });

  it("a server error (HTTP 500) is http_5xx, with a nav_error issue", async () => {
    const { fake, page } = await setup();
    fake.gotoStatus = 500;
    const error = await rejection(page.goto("http://x.test/"));
    expect(error.code).toBe("http_5xx");
  });

  it("a 403 on the main document is http_403, a blocked issue and a BlockedError", async () => {
    const { session, fake, page, events } = await setup();
    fake.gotoStatus = 403;
    const error = await rejection(page.goto("http://demo.test/botwall"));

    expect(error).toBeInstanceOf(BlockedError);
    expect(error.code).toBe("http_403");
    expect(session.issueKinds.has("blocked")).toBe(true);
    const all = await events();
    expect(ofType(all, "action")[0]).toMatchObject({ ok: false, error_code: "http_403" });
    expect(ofType(all, "issue")[0]).toMatchObject({ kind: "blocked" });
  });

  it("a page with the captcha marker is error_code captcha and a captcha issue", async () => {
    const { session, fake, page, events } = await setup();
    fake.counts['[data-testid="captcha"]'] = 1;
    const error = await rejection(page.goto("http://demo.test/botwall"));

    expect(error).toBeInstanceOf(BlockedError);
    expect(error.code).toBe("captcha");
    expect(session.issueKinds.has("captcha")).toBe(true);
    const all = await events();
    expect(ofType(all, "action")[0]).toMatchObject({ ok: false, error_code: "captcha" });
    expect(ofType(all, "issue")[0]).toMatchObject({ kind: "captcha" });
  });

  it("no captcha marker means no issue", async () => {
    const { session, fake, page } = await setup();
    fake.counts['[data-testid="captcha"]'] = 0;
    await page.goto("http://demo.test/dashboard");
    await page.click("#x");
    expect(session.issueKinds.size).toBe(0);
  });

  it("a page where the captcha check itself fails is treated as no captcha", async () => {
    const { fake, page } = await setup();
    fake.locator = () => {
      throw new Error("Execution context was destroyed");
    };
    await expect(page.goto("http://demo.test/")).resolves.toBe(200);
  });

  it("eval: a missing API is unsupported_api, other errors are js_error", async () => {
    const { session, fake, page, events } = await setup();
    fake.evalError = new Error("page.evaluate: ReferenceError: Worker is not defined");
    const missing = await rejection(page.eval(() => 1));
    fake.evalError = new Error("page.evaluate: TypeError: x is null");
    const other = await rejection(page.eval("x.y"));

    expect(missing.code).toBe("unsupported_api");
    expect(other.code).toBe("js_error");
    expect(session.issueKinds.has("unsupported_api")).toBe(true);
    const actions = ofType(await events(), "action");
    expect(actions.map((a) => a.error_code)).toEqual(["unsupported_api", "js_error"]);
    expect(actions[1]?.target).toBe("x.y");
  });

  it("a closed browser is browser_closed with a crash issue", async () => {
    const { fake, page, events } = await setup();
    fake.clickError = new Error("page.click: Target page, context or browser has been closed");
    const error = await rejection(page.click("#x"));
    expect(error.code).toBe("browser_closed");
    expect(ofType(await events(), "issue")[0]).toMatchObject({ kind: "crash" });
  });

  it("an unrecognised error is unknown and keeps its cause", async () => {
    const { fake, page } = await setup();
    const cause = new Error("something odd");
    fake.clickError = cause;
    const error = await rejection(page.click("#x"));
    expect(error.code).toBe("unknown");
    expect(error.cause).toBe(cause);
  });
});

describe("page events", () => {
  it("a page ReferenceError becomes one unsupported_api issue, repeats are not repeated", async () => {
    const { session, fake, events } = await setup();
    const boom = () =>
      fake.emit(
        "pageerror",
        Object.assign(new Error("IntersectionObserver is not defined"), { name: "ReferenceError" }),
      );
    boom();
    boom();
    fake.emit("pageerror", new Error("Unhandled app bug: boom")); // not an engine problem
    fake.emit(
      "pageerror",
      Object.assign(new Error("ResizeObserver is not defined"), { name: "ReferenceError" }),
    );

    const issues = ofType(await events(), "issue");
    expect(issues.map((i) => [i.kind, i.message])).toEqual([
      ["unsupported_api", "ReferenceError: IntersectionObserver is not defined"],
      ["unsupported_api", "ReferenceError: ResizeObserver is not defined"],
    ]);
    expect(session.issueKinds.has("unsupported_api")).toBe(true);
  });

  it("a page crash is a crash issue", async () => {
    const { fake, events } = await setup();
    fake.emit("crash");
    expect(ofType(await events(), "issue")[0]).toMatchObject({ kind: "crash" });
  });

  it("records one network request in five by default, starting with the first", async () => {
    const { fake, session, events } = await setup();
    for (let i = 0; i < 12; i++) {
      fake.emit(
        "requestfinished",
        fakeRequest(`http://demo.test/asset-${i}.js`, { resourceType: () => "script" }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20)); // async size lookups
    await session.endSession("success");

    const requests = ofType(await events(), "network.request");
    expect(requests).toHaveLength(3); // requests 0, 5 and 10
    expect(requests[0]).toMatchObject({
      domain: "demo.test",
      status: 200,
      bytes: 1000,
      duration_ms: 42,
      resource_type: "script",
    });
  });

  it("networkSampleEvery is configurable", async () => {
    const { fake, events } = await setup({ networkSampleEvery: 1 });
    for (let i = 0; i < 4; i++) fake.emit("requestfinished", fakeRequest("http://demo.test/a"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ofType(await events(), "network.request")).toHaveLength(4);
  });

  it("a failed request has status null and no bytes", async () => {
    const { fake, events } = await setup({ networkSampleEvery: 1 });
    fake.emit("request", fakeRequest("http://demo.test/gone"));
    fake.emit(
      "requestfailed",
      fakeRequest("http://demo.test/gone", { timing: () => ({ responseEnd: -1 }) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ofType(await events(), "network.request")[0]).toMatchObject({
      status: null,
      bytes: null,
    });
  });

  it("unknown sizes stay null instead of a guess", async () => {
    const { fake, events } = await setup({ networkSampleEvery: 1 });
    fake.emit(
      "requestfinished",
      fakeRequest("http://demo.test/a", {
        sizes: async () => {
          throw new Error("not supported by this engine");
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ofType(await events(), "network.request")[0]).toMatchObject({
      status: 200,
      bytes: null,
    });
  });

  it("ignores data: and about: requests", async () => {
    const { fake, events } = await setup({ networkSampleEvery: 1 });
    fake.emit("requestfinished", fakeRequest("data:image/png;base64,AAAA"));
    fake.emit("requestfinished", fakeRequest("about:blank"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ofType(await events(), "network.request")).toHaveLength(0);
  });

  it("stops listening after the session ends", async () => {
    const { fake, session, events } = await setup({ networkSampleEvery: 1 });
    await session.endSession("success");
    fake.emit("requestfinished", fakeRequest("http://demo.test/late"));
    fake.emit(
      "pageerror",
      Object.assign(new Error("Late is not defined"), { name: "ReferenceError" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const all = await events();
    expect(all.at(-1)?.type).toBe("session.ended");
    expect(fake.listenerCount("pageerror")).toBe(0);
  });
});

describe("JS heap sampling through CDP", () => {
  it("emits cdp resource.sample events with js_heap_mb and the other metrics null", async () => {
    const { session, events } = await setup({ heapSampleIntervalMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 70));
    await session.endSession("success");

    const samples = ofType(await events(), "resource.sample");
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(samples[0]).toMatchObject({
      origin: "cdp",
      js_heap_mb: 5,
      cpu_pct: null,
      mem_mb: null,
      net_rx_bytes: null,
      net_tx_bytes: null,
    });
  });

  it("an engine without CDP: the scenario runs, js_heap_mb is null, nothing crashes", async () => {
    const { collector, sink } = makeCollector({ heapSampleIntervalMs: 20 });
    const session = collector.startSession(sessionOptions);
    const fake = new FakePage();
    fake.cdp = new Error("CDP session is only available in Chromium");
    const page = await session.collectPage(fake.asPage());

    await page.goto("http://demo.test/login");
    await page.click("#go");
    await session.endSession("success");
    await collector.close();

    const samples = ofType(sink.events, "resource.sample");
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ origin: "cdp", js_heap_mb: null });
    expect(EventBatch.safeParse(sink.events).success).toBe(true);
    expect(ofType(sink.events, "action")).toHaveLength(2);
  });

  it("takes a last reading when the session ends, so a short session has an end value", async () => {
    const { session, events } = await setup({ heapSampleIntervalMs: 60_000 });
    await session.endSession("success");
    const all = await events();
    const samples = ofType(all, "resource.sample");
    expect(samples).toHaveLength(2); // at start and at the end
    expect(all.at(-1)?.type).toBe("session.ended");
  });

  it("no extra null sample at the end when the engine has no CDP", async () => {
    const { collector, sink } = makeCollector({ heapSampleIntervalMs: 60_000 });
    const session = collector.startSession(sessionOptions);
    const fake = new FakePage();
    fake.cdp = new Error("no CDP");
    await session.collectPage(fake.asPage());
    await session.endSession("success");
    await collector.close();
    expect(ofType(sink.events, "resource.sample")).toHaveLength(1);
  });

  it("endSession called twice at once still sends one session.ended", async () => {
    const { collector, sink, session } = await setup();
    await Promise.all([session.endSession("success"), session.endSession("failed", "x")]);
    await collector.flush();
    expect(ofType(sink.events, "session.ended")).toHaveLength(1);
    await collector.close();
  });

  it("heapSampleIntervalMs 0 turns heap sampling off", async () => {
    const { session, events } = await setup({ heapSampleIntervalMs: 0 });
    await session.endSession("success");
    expect(ofType(await events(), "resource.sample")).toHaveLength(0);
  });
});

describe("transport outcomes", () => {
  it("a collector keeps working when the API rejects everything", async () => {
    const sink = recordingTransport(() => ({
      status: "rejected",
      httpStatus: 400,
      error: "invalid",
    }));
    const { collector } = makeCollector({ transport: sink.transport });
    const session = collector.startSession(sessionOptions);
    await session.endSession("success");
    await collector.close();
    expect(collector.stats()).toMatchObject({ pushed: 2, sent: 0, dropped: 2 });
  });
});

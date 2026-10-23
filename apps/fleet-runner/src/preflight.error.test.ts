import { afterEach, describe, expect, it, vi } from "vitest";
import { describeFetchError, preflight } from "./preflight";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** What Node's fetch throws when `localhost` (::1 and 127.0.0.1) refuses the connection. */
function localhostRefused() {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(
      new AggregateError([
        Object.assign(new Error("connect ECONNREFUSED ::1:4000"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4000"), { code: "ECONNREFUSED" }),
      ]),
      { code: "ECONNREFUSED" },
    ),
  });
}

describe("describeFetchError (QA-M1-02: a reason is never empty)", () => {
  it("looks inside the AggregateError that Node's fetch throws for localhost", () => {
    const reason = describeFetchError(localhostRefused());
    expect(reason).not.toBe("");
    expect(reason).toContain("ECONNREFUSED");
  });

  it("adds the error code when the only message is the useless fetch failed", () => {
    const empty = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new AggregateError([new Error(), new Error()]), {
        code: "ECONNREFUSED",
      }),
    });
    expect(describeFetchError(empty)).toBe("fetch failed (ECONNREFUSED)");
  });

  it("falls back to the error name, then to a plain sentence", () => {
    expect(describeFetchError(new DOMException("", "TimeoutError"))).toBe("TimeoutError");
    expect(describeFetchError({})).toBe("no answer");
    expect(describeFetchError(undefined)).toBe("no answer");
    expect(describeFetchError("boom")).toBe("no answer");
  });

  it("keeps a normal message, and adds the code when the message lacks it", () => {
    expect(describeFetchError(new Error("getaddrinfo ENOTFOUND demo.test"))).toBe(
      "getaddrinfo ENOTFOUND demo.test",
    );
    expect(
      describeFetchError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })),
    ).toBe("socket hang up (ECONNRESET)");
  });

  it("does not loop on a cause that points back at itself", () => {
    const loop: { cause?: unknown; message: string } = { message: "loop" };
    loop.cause = loop;
    expect(describeFetchError(loop)).toBe("loop");
  });
});

describe("preflight with an API and a demo site that are down on localhost", () => {
  const docker = { ping: async () => undefined, hasImage: async () => true };

  it("reports both, with a reason (it used to say nothing and start the run)", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(localhostRefused()));
    const problems = await preflight({
      apiUrl: "http://localhost:4000",
      demoSiteUrl: "http://localhost:3100",
      browserImage: "img:1",
      docker,
    });
    expect(problems.map((p) => p.check).sort()).toEqual(["api", "demo-site"]);
    for (const problem of problems) {
      expect(problem.message).toContain("ECONNREFUSED");
      expect(problem.message).not.toMatch(/\(\)/); // no empty reason in the brackets
    }
  });

  it("an error with no message at all still counts as a failure", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("")));
    const problems = await preflight({
      apiUrl: "http://localhost:4000",
      demoSiteUrl: "http://localhost:3100",
      browserImage: "img:1",
      docker,
    });
    expect(problems.map((p) => p.check).sort()).toEqual(["api", "demo-site"]);
  });
});

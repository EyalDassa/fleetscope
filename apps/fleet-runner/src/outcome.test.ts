import { BlockedError, CollectedError } from "@fleetscope/collector";
import { describe, expect, it } from "vitest";
import { classifyOutcome } from "./outcome";

const base = {
  interrupted: false,
  timedOut: false,
  sessionTimeoutMs: 120_000,
  disconnected: false,
};

describe("classifyOutcome", () => {
  it("a scenario that finished is a success", () => {
    expect(classifyOutcome({ ...base })).toEqual({ status: "success", reason: null });
  });

  it("stays a success even if the run was interrupted just afterwards", () => {
    expect(classifyOutcome({ ...base, interrupted: true }).status).toBe("success");
  });

  it("a 403 or a captcha is blocked", () => {
    expect(
      classifyOutcome({ ...base, error: new BlockedError("http_403", "HTTP 403 for /botwall") }),
    ).toEqual({
      status: "blocked",
      reason: "HTTP 403 for /botwall",
    });
    expect(
      classifyOutcome({ ...base, error: new BlockedError("captcha", "captcha on /x") }).status,
    ).toBe("blocked");
  });

  it("an action timeout is timeout", () => {
    expect(
      classifyOutcome({
        ...base,
        error: new CollectedError("timeout", "page.click: Timeout 5000ms exceeded."),
      }).status,
    ).toBe("timeout");
  });

  it("running past the session limit is timeout, whatever error the closing browser caused", () => {
    expect(
      classifyOutcome({
        ...base,
        timedOut: true,
        sessionTimeoutMs: 90_000,
        error: new CollectedError("browser_closed", "closed"),
      }),
    ).toEqual({ status: "timeout", reason: "session exceeded 90s" });
  });

  it("a browser that went away is crashed", () => {
    expect(classifyOutcome({ ...base, disconnected: true, error: new Error("x") })).toEqual({
      status: "crashed",
      reason: "browser disconnected",
    });
    expect(
      classifyOutcome({
        ...base,
        error: new CollectedError(
          "browser_closed",
          "Target page, context or browser has been closed",
        ),
      }).status,
    ).toBe("crashed");
  });

  it("Ctrl+C is failed with the reason interrupted, even though closing the browser broke an action", () => {
    expect(
      classifyOutcome({
        ...base,
        interrupted: true,
        error: new CollectedError("browser_closed", "closed"),
      }),
    ).toEqual({ status: "failed", reason: "interrupted" });
  });

  it("anything else is failed with the message", () => {
    expect(classifyOutcome({ ...base, error: new Error("search for lamp found nothing") })).toEqual(
      {
        status: "failed",
        reason: "search for lamp found nothing",
      },
    );
    expect(
      classifyOutcome({
        ...base,
        error: new CollectedError("selector_not_found", "no such element"),
      }).status,
    ).toBe("failed");
    expect(classifyOutcome({ ...base, error: "a string" })).toEqual({
      status: "failed",
      reason: "a string",
    });
  });
});

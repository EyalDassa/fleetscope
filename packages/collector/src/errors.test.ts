import { describe, expect, it } from "vitest";
import { classifyError, isMissingApiError, isUnsupportedFeatureError } from "./errors";

describe("isMissingApiError (known API names)", () => {
  const typeError = (message: string) => ({ name: "TypeError", message });

  it.each([
    "IntersectionObserver is not a constructor",
    "window.ResizeObserver is not a constructor",
    "window.requestIdleCallback is not a function",
    "crypto.subtle.digest is not a function",
    "Worker is not a constructor",
    "navigator.serviceWorker.register is not a function",
    "Cannot read properties of undefined (reading 'digest')",
    "Cannot read properties of undefined (reading 'importKey')",
  ])("recognises %s", (message) => {
    expect(isMissingApiError(typeError(message))).toBe(true);
  });

  it.each([
    "x.map is not a function",
    "Cannot read properties of undefined (reading 'name')",
    "myWorker is not a function",
    "cart.Worker2 is not a constructor",
    "callback is not a function",
  ])("does not call %s a missing API", (message) => {
    expect(isMissingApiError(typeError(message))).toBe(false);
  });
});

describe("unsupported_feature", () => {
  it("recognises a CDP method the engine does not implement", () => {
    const message = "Protocol error (Page.captureScreenshot): 'Page.captureScreenshot' wasn't found";
    expect(isUnsupportedFeatureError({ message })).toBe(true);
    expect(classifyError(new Error(message))).toBe("unsupported_feature");
  });

  it("recognises JSON-RPC -32601", () => {
    expect(classifyError(new Error("Protocol error: {code: -32601, message: 'x'}"))).toBe(
      "unsupported_feature",
    );
  });

  it("does not take a page's own 'not supported' for an engine limit", () => {
    expect(classifyError(new Error("This browser is not supported"))).toBe("unknown");
  });

  it("a closed browser is still browser_closed", () => {
    expect(classifyError(new Error("Target closed: not supported"))).toBe("browser_closed");
  });
});

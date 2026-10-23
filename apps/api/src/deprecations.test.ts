import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";

// QA-M0-13: Fastify 5 warns (FSTDEP023) about the top-level `disableRequestLogging` option. The app
// uses `logController` instead. Fastify's warnings go through process.emitWarning.

afterEach(() => {
  vi.restoreAllMocks();
});

/** Fastify calls process.emitWarning(message, type, code). */
function warningCodes(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(([, , code]) => (typeof code === "string" ? code : ""));
}

describe("Fastify deprecation warnings", () => {
  it("are not triggered by the app's own configuration", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const app = buildApp({ ping: async () => true, logLevel: false });
    await app.ready();
    await app.close();
    expect(warningCodes(spy).filter((code) => code.startsWith("FSTDEP"))).toEqual([]);
  });

  it("would be triggered by the old option (so this test can fail)", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const app = Fastify({ disableRequestLogging: () => true });
    await app.ready();
    await app.close();
    expect(warningCodes(spy)).toContain("FSTDEP023");
  });
});

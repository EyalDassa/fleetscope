import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { parseRunArgs, UsageError } from "./options";

const seed = () => 12345;

describe("parseRunArgs", () => {
  it("has sensible defaults and prints a random seed", () => {
    expect(parseRunArgs([], seed)).toEqual({
      engines: ["chromium"],
      sessions: 10,
      concurrency: 4,
      scenario: "mix",
      seed: 12345,
      agentId: `fleet-runner@${hostname()}`,
      sessionTimeoutMs: 120_000,
    });
  });

  it("reads every option", () => {
    const options = parseRunArgs(
      [
        "--engines",
        "chromium",
        "--sessions",
        "20",
        "--concurrency",
        "8",
        "--scenario",
        "checkout-form",
        "--seed",
        "7",
        "--agent",
        "my-agent",
        "--session-timeout",
        "30",
      ],
      seed,
    );
    expect(options).toEqual({
      engines: ["chromium"],
      sessions: 20,
      concurrency: 8,
      scenario: "checkout-form",
      seed: 7,
      agentId: "my-agent",
      sessionTimeoutMs: 30_000,
    });
  });

  it("accepts --seed 0", () => {
    expect(parseRunArgs(["--seed", "0"], seed).seed).toBe(0);
  });

  it("never runs more containers than sessions", () => {
    expect(parseRunArgs(["--sessions", "2", "--concurrency", "8"], seed).concurrency).toBe(2);
  });

  it("rejects an engine that is not chromium, with a clear message", () => {
    expect(() => parseRunArgs(["--engines", "lightpanda"], seed)).toThrow(
      /not supported by the runner yet/,
    );
    expect(() => parseRunArgs(["--engines", "chromium,lightpanda"], seed)).toThrow(/lightpanda/);
    expect(() => parseRunArgs(["--engines", "chrome-headless-shell"], seed)).toThrow(UsageError);
  });

  it("rejects an unknown engine and hints at chromium for chrome", () => {
    expect(() => parseRunArgs(["--engines", "firefox"], seed)).toThrow(/unknown engine "firefox"/);
    expect(() => parseRunArgs(["--engines", "chrome"], seed)).toThrow(/did you mean "chromium"/);
  });

  it("rejects bad numbers", () => {
    for (const args of [
      ["--sessions", "0"],
      ["--sessions", "-3"],
      ["--sessions", "ten"],
      ["--sessions", "1.5"],
      ["--concurrency", "0"],
      ["--concurrency", "1000"],
      ["--seed", "abc"],
      ["--seed", "-1"],
      ["--session-timeout", "0"],
    ]) {
      expect(() => parseRunArgs(args, seed), args.join(" ")).toThrow(UsageError);
    }
  });

  it("rejects an unknown scenario and lists the valid ones", () => {
    expect(() => parseRunArgs(["--scenario", "nope"], seed)).toThrow(
      /login-and-search, checkout-form, heavy-page-crawl, mix/,
    );
  });

  it("rejects unknown flags and stray words", () => {
    expect(() => parseRunArgs(["--bogus"], seed)).toThrow(UsageError);
    expect(() => parseRunArgs(["extra"], seed)).toThrow(UsageError);
  });
});

describe("config", () => {
  it("uses the documented defaults", () => {
    expect(loadConfig({})).toEqual({
      apiUrl: "http://localhost:4000",
      demoSiteUrl: "http://localhost:3100",
      demoSiteBrowserUrl: "http://localhost:3100",
      demoSiteUpstream: undefined,
      browserImage: "fleetscope/playwright-chromium:1.64.1",
      logLevel: "info",
    });
  });

  it("reads the environment, ignoring empty values and trailing slashes", () => {
    const config = loadConfig({
      FLEETSCOPE_API_URL: "http://api.test:9000/",
      DEMO_SITE_URL: "http://127.0.0.1:3200/",
      DEMO_SITE_BROWSER_URL: "http://localhost:3200/",
      DEMO_SITE_UPSTREAM: " host.docker.internal:3200 ",
      FLEET_BROWSER_IMAGE: "  my/image:1  ",
      LOG_LEVEL: "",
    });
    expect(config).toEqual({
      apiUrl: "http://api.test:9000",
      demoSiteUrl: "http://127.0.0.1:3200",
      demoSiteBrowserUrl: "http://localhost:3200",
      demoSiteUpstream: "host.docker.internal:3200",
      browserImage: "my/image:1",
      logLevel: "info",
    });
  });

  it("the host-side demo site URL does not change what the browser browses", () => {
    expect(loadConfig({ DEMO_SITE_URL: "http://10.0.0.5:3100" }).demoSiteBrowserUrl).toBe(
      "http://localhost:3100",
    );
  });

  it("an empty DEMO_SITE_UPSTREAM counts as unset", () => {
    expect(loadConfig({ DEMO_SITE_UPSTREAM: "  " }).demoSiteUpstream).toBeUndefined();
  });
});

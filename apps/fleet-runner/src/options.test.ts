import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import {
  defaultAgentId,
  parseDuration,
  parseRunArgs,
  parseTrafficArgs,
  UsageError,
} from "./options";

const seed = () => 12345;

describe("parseRunArgs", () => {
  it("has sensible defaults and prints a random seed", () => {
    expect(parseRunArgs([], seed)).toEqual({
      engines: ["chromium"],
      sessions: 10,
      concurrency: 4,
      scenario: "mix",
      seed: 12345,
      agentId: defaultAgentId(hostname()),
      routing: "fixed",
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
        "--routing",
        "by-scenario",
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
      routing: "by-scenario",
      sessionTimeoutMs: 30_000,
    });
  });

  it("rejects an unknown routing policy and lists the valid ones", () => {
    expect(() => parseRunArgs(["--routing", "smart"], seed)).toThrow(/fixed, by-scenario/);
  });

  it("accepts --seed 0", () => {
    expect(parseRunArgs(["--seed", "0"], seed).seed).toBe(0);
  });

  it("never runs more containers than sessions", () => {
    expect(parseRunArgs(["--sessions", "2", "--concurrency", "8"], seed).concurrency).toBe(2);
  });

  it("accepts all three engines, once each", () => {
    expect(
      parseRunArgs(["--engines", "chromium,chrome-headless-shell,lightpanda,lightpanda"], seed)
        .engines,
    ).toEqual(["chromium", "chrome-headless-shell", "lightpanda"]);
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
      browserImage: "fleetscope/playwright-chromium:1.64.1-2",
      browserImages: {
        chromium: "fleetscope/playwright-chromium:1.64.1-2",
        "chrome-headless-shell":
          "chromedp/headless-shell:156.0.8078.48@sha256:3da74b0945e4f80f00f0310bcda9f76cee283539ebd200a053a7bebf3de89423",
        lightpanda:
          "lightpanda/browser:1.0.2@sha256:5d1d724c476957d8c2f8393a51fd089477523b0e5aa9c783c48688785d934fb9",
      },
      forwarderImage: "fleetscope/forwarder:1-1",
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
      browserImages: {
        chromium: "my/image:1",
        "chrome-headless-shell":
          "chromedp/headless-shell:156.0.8078.48@sha256:3da74b0945e4f80f00f0310bcda9f76cee283539ebd200a053a7bebf3de89423",
        lightpanda:
          "lightpanda/browser:1.0.2@sha256:5d1d724c476957d8c2f8393a51fd089477523b0e5aa9c783c48688785d934fb9",
      },
      forwarderImage: "fleetscope/forwarder:1-1",
      logLevel: "info",
    });
  });

  it("FLEET_BROWSER_IMAGE_<ENGINE> wins over the old FLEET_BROWSER_IMAGE", () => {
    const config = loadConfig({
      FLEET_BROWSER_IMAGE: "old/image:1",
      FLEET_BROWSER_IMAGE_CHROMIUM: "new/image:2",
      FLEET_BROWSER_IMAGE_LIGHTPANDA: "lp:9",
      FLEET_BROWSER_IMAGE_CHROME_HEADLESS_SHELL: "hs:8",
      FLEET_FORWARDER_IMAGE: "fwd:3",
    });
    expect(config.browserImages).toEqual({
      chromium: "new/image:2",
      "chrome-headless-shell": "hs:8",
      lightpanda: "lp:9",
    });
    expect(config.forwarderImage).toBe("fwd:3");
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

describe("the agent id (dashboards put it into SQL, so the schema allows A-Z a-z 0-9 . _ : @ / + - only)", () => {
  const safe = /^[A-Za-z0-9._:@/+-]{1,128}$/;

  it("is fleet-runner@<host>, with the characters the schema refuses replaced by _", () => {
    expect(defaultAgentId("LAPTOP-G1JS2HFL")).toBe("fleet-runner@LAPTOP-G1JS2HFL");
    expect(defaultAgentId("build_agent-07.example.com")).toBe(
      "fleet-runner@build_agent-07.example.com",
    );
    expect(defaultAgentId("Eyal's PC")).toBe("fleet-runner@Eyal_s_PC");
    expect(defaultAgentId("caf\u00e9")).toBe("fleet-runner@caf_");
  });

  it("always fits the schema, whatever the host is called, and is cut at 128 characters", () => {
    for (const host of ["", "a'b", "\\", "x".repeat(500), "\u{1F680}", "a b\nc"]) {
      expect(safe.test(defaultAgentId(host)), JSON.stringify(host)).toBe(true);
    }
    expect(defaultAgentId("x".repeat(500))).toHaveLength(128);
  });

  it("accepts a --agent that fits", () => {
    expect(parseRunArgs(["--agent", "my-agent@host.example"], seed).agentId).toBe(
      "my-agent@host.example",
    );
  });

  it.each(["it's", "a b", "back\\slash", "caf\u00e9", "x".repeat(129), "a;b"])(
    "rejects --agent %j with a message that says what is allowed",
    (agent) => {
      expect(() => parseRunArgs(["--agent", agent], seed)).toThrow(UsageError);
      expect(() => parseRunArgs(["--agent", agent], seed)).toThrow(/1 to 128 characters from A-Z/);
    },
  );
});

describe("parseTrafficArgs", () => {
  it("defaults to 3 sessions a minute, 2 at a time, until Ctrl+C", () => {
    const options = parseTrafficArgs([], seed);
    expect(options.ratePerMinute).toBe(3);
    expect(options.concurrency).toBe(2);
    expect(options.durationMs).toBeUndefined();
    expect(options.agentId).toMatch(/^traffic@/);
    expect(options.engines).toEqual(["chromium"]);
  });

  it("reads rate, concurrency, duration and agent", () => {
    const options = parseTrafficArgs(
      [
        "--engines",
        "chromium,lightpanda",
        "--rate",
        "12",
        "--concurrency",
        "5",
        "--duration",
        "10m",
        "--agent",
        "t@x",
      ],
      seed,
    );
    expect(options).toMatchObject({
      ratePerMinute: 12,
      concurrency: 5,
      durationMs: 600_000,
      agentId: "t@x",
      engines: ["chromium", "lightpanda"],
    });
  });

  it("reads --routing, default fixed", () => {
    expect(parseTrafficArgs([], seed).routing).toBe("fixed");
    expect(parseTrafficArgs(["--routing", "by-scenario"], seed).routing).toBe("by-scenario");
    expect(() => parseTrafficArgs(["--routing", "x"], seed)).toThrow(UsageError);
  });

  it("rejects bad values", () => {
    expect(() => parseTrafficArgs(["--rate", "0"], seed)).toThrow(UsageError);
    expect(() => parseTrafficArgs(["--duration", "soon"], seed)).toThrow(UsageError);
    expect(() => parseTrafficArgs(["--sessions", "5"], seed)).toThrow(UsageError);
  });
});

describe("parseDuration", () => {
  it("understands s, m, h and bare seconds", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("2m")).toBe(120_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("45")).toBe(45_000);
  });
});

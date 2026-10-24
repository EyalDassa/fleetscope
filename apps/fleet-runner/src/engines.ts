import type { Engine } from "@fleetscope/schema";
import type { Capability } from "./scenarios";

/**
 * How the runner talks to each engine's container. One entry per `ENGINES` value, so a new engine
 * that is added to the schema without an entry here fails to compile.
 *
 *  - `playwright-server`: our own image runs `playwright run-server`; the client does
 *    `chromium.connect(ws://...)` and the server launches Chromium for it.
 *  - `cdp-http`: the image is a browser with CDP on a port; `chromium.connectOverCDP(http://...)`
 *    asks `/json/version` for the WebSocket URL.
 *  - `cdp-ws`: same, but we hand Playwright the WebSocket URL directly (Lightpanda's own docs do
 *    this, and its `/json/version` may name an address that is only valid inside the container).
 */
export type ConnectMode = "playwright-server" | "cdp-http" | "cdp-ws";

export interface EngineSpec {
  /** Port the browser listens on inside its container. */
  port: number;
  /** Readiness: an HTTP GET to this path must answer 2xx. */
  readyPath: string;
  connect: ConnectMode;
  /** Environment variable that overrides `defaultImage`. */
  imageEnv: string;
  /** Pinned. Keep in sync with `infra/browsers/README.md`. */
  defaultImage: string;
  /** Environment of the browser container. */
  env: readonly string[];
  /**
   * Browser features this engine is verified NOT to have. `--routing by-scenario` keeps a scenario
   * that needs one of them off this engine. Empty for the Chrome-based engines.
   */
  lacks: readonly Capability[];
}

export const ENGINE_SPECS: Record<Engine, EngineSpec> = {
  chromium: {
    port: 3000,
    readyPath: "/",
    connect: "playwright-server",
    imageEnv: "FLEET_BROWSER_IMAGE_CHROMIUM",
    // Keep this tag in sync with the Playwright version pinned in package.json (CI checks it).
    defaultImage: "fleetscope/playwright-chromium:1.64.1-2",
    env: [],
    lacks: [],
  },
  "chrome-headless-shell": {
    port: 9222,
    readyPath: "/json/version",
    connect: "cdp-http",
    imageEnv: "FLEET_BROWSER_IMAGE_CHROME_HEADLESS_SHELL",
    defaultImage:
      "chromedp/headless-shell:156.0.8078.48@sha256:3da74b0945e4f80f00f0310bcda9f76cee283539ebd200a053a7bebf3de89423",
    env: [],
    lacks: [],
  },
  lightpanda: {
    port: 9222,
    readyPath: "/json/version",
    connect: "cdp-ws",
    imageEnv: "FLEET_BROWSER_IMAGE_LIGHTPANDA",
    defaultImage:
      "lightpanda/browser:1.0.2@sha256:5d1d724c476957d8c2f8393a51fd089477523b0e5aa9c783c48688785d934fb9",
    // A benchmark fleet should not phone home.
    env: ["LIGHTPANDA_DISABLE_TELEMETRY=true"],
    // Verified on 1.0.2 and on nightly 1.1.0-nightly.11062: `Worker` exists but no worker ever runs
    // (script URL, blob: or data:), so the /js-heavy probe times out. See docs/adr/0005 and
    // tools/worker-probe.mjs. Remove this when a Lightpanda release passes the probe.
    lacks: ["webWorker"],
  },
};

export const DEFAULT_FORWARDER_IMAGE = "fleetscope/forwarder:1-1";

/** Image per engine from the environment. `FLEET_BROWSER_IMAGE` is the old name for chromium's. */
export function engineImages(env: NodeJS.ProcessEnv): Record<Engine, string> {
  const pick = (...names: (string | undefined)[]): string | undefined =>
    names.map((name) => name?.trim()).find((value) => value !== undefined && value !== "");
  return Object.fromEntries(
    (Object.entries(ENGINE_SPECS) as [Engine, EngineSpec][]).map(([engine, spec]) => [
      engine,
      pick(
        env[spec.imageEnv],
        engine === "chromium" ? env.FLEET_BROWSER_IMAGE : undefined,
        spec.defaultImage,
      ),
    ]),
  ) as Record<Engine, string>;
}

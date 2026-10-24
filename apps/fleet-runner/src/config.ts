import type { Engine } from "@fleetscope/schema";
import { DEFAULT_FORWARDER_IMAGE, ENGINE_SPECS, engineImages } from "./engines";

/** Settings that come from the environment (`.env` is loaded by the `fleet` script). */
export interface RunnerConfig {
  /** Fleetscope API, as the runner (on the host) reaches it. */
  apiUrl: string;
  /** Demo site, as the runner (on the host) reaches it. Used for the preflight check only. */
  demoSiteUrl: string;
  /**
   * Demo site, as the browser inside a container reaches it. Scenarios browse this URL. It is
   * `http://localhost:3100` by default: `localhost` is a secure origin in every engine (so
   * `crypto.subtle` exists), and the browser image forwards its port 3100 to the host.
   */
  demoSiteBrowserUrl: string;
  /**
   * `host:port` the forwarder sidecar sends 127.0.0.1:3100 to. Passed to the sidecar
   * as `DEMO_SITE_UPSTREAM` when set; otherwise the sidecar image's default applies.
   */
  demoSiteUpstream: string | undefined;
  /** Docker image of the chromium browser container (`browserImages.chromium`). */
  browserImage: string;
  /** Docker image per engine (`FLEET_BROWSER_IMAGE_<ENGINE>`). */
  browserImages: Record<Engine, string>;
  /** Image of the forwarder sidecar (`FLEET_FORWARDER_IMAGE`). */
  forwarderImage: string;
  logLevel: string;
}

/** Kept for the chromium default; the engine table (`engines.ts`) is the source. */
export const DEFAULT_BROWSER_IMAGE = ENGINE_SPECS.chromium.defaultImage;

const orDefault = (value: string | undefined, fallback: string): string =>
  value === undefined || value.trim() === "" ? fallback : value.trim();

const withoutTrailingSlash = (url: string): string => url.replace(/\/$/, "");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const upstream = env.DEMO_SITE_UPSTREAM?.trim();
  const browserImages = engineImages(env);
  return {
    apiUrl: withoutTrailingSlash(orDefault(env.FLEETSCOPE_API_URL, "http://localhost:4000")),
    demoSiteUrl: withoutTrailingSlash(orDefault(env.DEMO_SITE_URL, "http://localhost:3100")),
    demoSiteBrowserUrl: withoutTrailingSlash(
      orDefault(env.DEMO_SITE_BROWSER_URL, "http://localhost:3100"),
    ),
    demoSiteUpstream: upstream === "" ? undefined : upstream,
    browserImage: browserImages.chromium,
    browserImages,
    forwarderImage: orDefault(env.FLEET_FORWARDER_IMAGE, DEFAULT_FORWARDER_IMAGE),
    logLevel: orDefault(env.LOG_LEVEL, "info"),
  };
}

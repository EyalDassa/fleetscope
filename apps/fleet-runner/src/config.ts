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
   * `host:port` the forwarder in the browser image sends 127.0.0.1:3100 to. Passed to the container
   * as `DEMO_SITE_UPSTREAM` when set; otherwise the image's own default applies.
   */
  demoSiteUpstream: string | undefined;
  /** Docker image of the browser container. */
  browserImage: string;
  logLevel: string;
}

/** Keep this tag in sync with the Playwright version pinned in package.json (CI checks it). */
export const DEFAULT_BROWSER_IMAGE = "fleetscope/playwright-chromium:1.64.1";

const orDefault = (value: string | undefined, fallback: string): string =>
  value === undefined || value.trim() === "" ? fallback : value.trim();

const withoutTrailingSlash = (url: string): string => url.replace(/\/$/, "");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const upstream = env.DEMO_SITE_UPSTREAM?.trim();
  return {
    apiUrl: withoutTrailingSlash(orDefault(env.FLEETSCOPE_API_URL, "http://localhost:4000")),
    demoSiteUrl: withoutTrailingSlash(orDefault(env.DEMO_SITE_URL, "http://localhost:3100")),
    demoSiteBrowserUrl: withoutTrailingSlash(
      orDefault(env.DEMO_SITE_BROWSER_URL, "http://localhost:3100"),
    ),
    demoSiteUpstream: upstream === "" ? undefined : upstream,
    browserImage: orDefault(env.FLEET_BROWSER_IMAGE, DEFAULT_BROWSER_IMAGE),
    logLevel: orDefault(env.LOG_LEVEL, "info"),
  };
}

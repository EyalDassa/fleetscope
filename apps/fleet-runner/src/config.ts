/** Settings that come from the environment (`.env` is loaded by the `fleet` script). */
export interface RunnerConfig {
  /** Fleetscope API, as the runner (on the host) reaches it. */
  apiUrl: string;
  /** Demo site, as the runner (on the host) reaches it. */
  demoSiteUrl: string;
  /** Demo site, as a browser inside a container reaches it. */
  demoSiteContainerUrl: string;
  /** Docker image of the browser container. */
  browserImage: string;
  logLevel: string;
}

/** Keep this tag in sync with the Playwright version pinned in package.json (CI checks it). */
export const DEFAULT_BROWSER_IMAGE = "fleetscope/playwright-chromium:1.64.1";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * `http://localhost:3100` on the host is `http://host.docker.internal:3100` inside a container
 * (the container is started with `host.docker.internal:host-gateway`). Other hosts stay as they are.
 */
export function containerUrlFor(hostUrl: string): string {
  const url = new URL(hostUrl);
  if (LOCAL_HOSTS.has(url.hostname)) url.hostname = "host.docker.internal";
  return url.toString().replace(/\/$/, "");
}

const orDefault = (value: string | undefined, fallback: string): string =>
  value === undefined || value.trim() === "" ? fallback : value.trim();

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const demoSiteUrl = orDefault(env.DEMO_SITE_URL, "http://localhost:3100").replace(/\/$/, "");
  return {
    apiUrl: orDefault(env.FLEETSCOPE_API_URL, "http://localhost:4000").replace(/\/$/, ""),
    demoSiteUrl,
    demoSiteContainerUrl: containerUrlFor(demoSiteUrl),
    browserImage: orDefault(env.FLEET_BROWSER_IMAGE, DEFAULT_BROWSER_IMAGE),
    logLevel: orDefault(env.LOG_LEVEL, "info"),
  };
}

import type { DockerFleet } from "./docker";

export interface PreflightTarget {
  apiUrl: string;
  demoSiteUrl: string;
  browserImage: string;
  docker: Pick<DockerFleet, "ping" | "hasImage">;
}

export interface PreflightFailure {
  check: "api" | "demo-site" | "docker" | "image";
  message: string;
}

async function fetchOk(url: string, timeoutMs = 3000): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await response.arrayBuffer().catch(() => undefined);
    return response.ok ? null : `answered HTTP ${response.status}`;
  } catch (error) {
    return error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : error instanceof Error
        ? error.message
        : String(error);
  }
}

/**
 * Checks everything a run needs before it starts anything: the API, the demo site, Docker and the
 * browser image. Returns all the problems at once, so one run of the command shows everything to fix.
 */
export async function preflight(target: PreflightTarget): Promise<PreflightFailure[]> {
  const failures: PreflightFailure[] = [];
  const fail = (check: PreflightFailure["check"], message: string) =>
    failures.push({ check, message });

  await Promise.all([
    (async () => {
      const problem = await fetchOk(`${target.apiUrl}/healthz`);
      if (problem) {
        fail(
          "api",
          `API not healthy at ${target.apiUrl}/healthz (${problem}). Start it with: pnpm --filter @fleetscope/api dev`,
        );
      }
    })(),
    (async () => {
      const problem = await fetchOk(`${target.demoSiteUrl}/`);
      if (problem) {
        fail(
          "demo-site",
          `demo site not answering at ${target.demoSiteUrl} (${problem}). Start it with: pnpm --filter @fleetscope/demo-site dev`,
        );
      }
    })(),
    (async () => {
      try {
        await target.docker.ping();
      } catch (error) {
        fail(
          "docker",
          `cannot reach Docker (${error instanceof Error ? error.message : String(error)}). Is Docker Desktop running?`,
        );
        return;
      }
      try {
        if (!(await target.docker.hasImage())) {
          fail(
            "image",
            `browser image ${target.browserImage} not found locally. Run: pnpm browsers:build`,
          );
        }
      } catch (error) {
        fail(
          "image",
          `could not look up image ${target.browserImage} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    })(),
  ]);
  return failures;
}

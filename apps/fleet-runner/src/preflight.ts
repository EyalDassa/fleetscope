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

type CheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Why a `fetch` failed, as text that is never empty. Node wraps the real cause: `fetch failed` has
 * a `cause`, and for `localhost` (which can be both ::1 and 127.0.0.1) that cause is an
 * AggregateError whose own message is "" and whose details are in `errors` and `code`.
 */
export function describeFetchError(error: unknown): string {
  const candidates: unknown[] = [];
  const seen = new Set<unknown>();
  const collect = (value: unknown, depth = 0): void => {
    if (typeof value !== "object" || value === null || seen.has(value) || depth > 4) return;
    seen.add(value);
    candidates.push(value);
    const { cause, errors } = value as { cause?: unknown; errors?: unknown };
    collect(cause, depth + 1);
    if (Array.isArray(errors)) for (const inner of errors) collect(inner, depth + 1);
  };
  collect(error);

  const text = (field: "message" | "code" | "name"): string | undefined =>
    candidates
      .map((c) => (c as Record<string, unknown>)[field])
      .find((v): v is string => typeof v === "string" && v.trim() !== "");
  // "fetch failed" says nothing, so prefer the deepest message that does.
  const messages = candidates
    .map((c) => (c as { message?: unknown }).message)
    .filter((v): v is string => typeof v === "string" && v.trim() !== "" && v !== "fetch failed");
  const message = messages.at(-1) ?? text("message");
  const code = text("code");
  if (message) return code && !message.includes(code) ? `${message} (${code})` : message;
  return code ?? text("name") ?? "no answer";
}

/** Asks for `url`. Never treats a missing explanation as success: the result says ok or why not. */
async function check(url: string, timeoutMs = 3000): Promise<CheckResult> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await response.arrayBuffer().catch(() => undefined);
    return response.ok ? { ok: true } : { ok: false, reason: `answered HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, reason: describeFetchError(error) };
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
      const result = await check(`${target.apiUrl}/healthz`);
      if (!result.ok) {
        fail(
          "api",
          `API not healthy at ${target.apiUrl}/healthz (${result.reason}). Start it with: pnpm --filter @fleetscope/api dev`,
        );
      }
    })(),
    (async () => {
      const result = await check(`${target.demoSiteUrl}/`);
      if (!result.ok) {
        fail(
          "demo-site",
          `demo site not answering at ${target.demoSiteUrl} (${result.reason}). Start it with: pnpm --filter @fleetscope/demo-site dev`,
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

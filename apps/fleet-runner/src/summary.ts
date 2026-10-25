import type { QueueStats } from "@fleetscope/collector";
import { type ResultStatus, type SessionResult, wasReported } from "./session-runner";

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function pad(text: string, width: number, right = false): string {
  return right ? text.padStart(width) : text.padEnd(width);
}

/** Startup plus connect: until the browser can be driven. `null` if it never came up. */
const timeToBrowser = (r: SessionResult): number | null =>
  r.startupMs === null ? null : r.startupMs + (r.connectMs ?? 0);

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

/** `chrome-headless-shell (from lightpanda)` for a routed session, else just the engine. */
export const engineLabel = (r: Pick<SessionResult, "engine" | "routedFrom">): string =>
  r.routedFrom === null ? r.engine : `${r.engine} (from ${r.routedFrom})`;

/** `demo` for the demo site, `public/wikipedia` for a public one. */
export const visitLabel = (r: Pick<SessionResult, "target" | "site">): string =>
  r.target === "demo" ? "demo" : `${r.target}/${r.site}`;

/** One row per site that was visited: how many sessions, how they ended. Empty without public sessions. */
function siteTotals(results: readonly SessionResult[]): string[] {
  if (!results.some((r) => r.target === "public")) return [];
  const sites = [...new Set(results.map((r) => r.site))].sort();
  const rows = sites.map((site) => {
    const mine = results.filter((r) => r.site === site);
    const counts = new Map<ResultStatus, number>();
    for (const r of mine) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    return [
      site,
      `${mine.length} sessions`,
      [...counts].map(([status, n]) => `${status} ${n}`).join(", "),
    ];
  });
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => row[i]?.length ?? 0))) ?? [];
  return rows.map((row) => `  ${row.map((cell, i) => pad(cell, widths[i] ?? 0)).join("  ")}`);
}

/** One row per engine: how its sessions ended and what it cost. */
function engineTotals(results: readonly SessionResult[]): string[] {
  const engines = [...new Set(results.map((r) => r.engine))].sort();
  if (engines.length === 0) return [];
  const rows = engines.map((engine) => {
    const mine = results.filter((r) => r.engine === engine);
    const reported = mine.filter((r) => wasReported(r.status));
    const ok = mine.filter((r) => r.status === "success").length;
    const actions = reported.reduce((n, r) => n + r.actions, 0);
    const failedActions = reported.reduce((n, r) => n + r.failedActions, 0);
    const toBrowser = mean(mine.map(timeToBrowser).filter((v): v is number => v !== null));
    const peaks = mine.map((r) => r.peakMemMb).filter((v): v is number => v !== null);
    return [
      engine,
      `${mine.length} sessions`,
      `${ok} success`,
      `actions ${actions - failedActions}/${actions}`,
      `to browser avg ${toBrowser === null ? "-" : seconds(toBrowser)}`,
      `peak mem max ${peaks.length === 0 ? "-" : `${Math.round(Math.max(...peaks))} MB`}`,
    ];
  });
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => row[i]?.length ?? 0))) ?? [];
  return rows.map((row) => `  ${row.map((cell, i) => pad(cell, widths[i] ?? 0)).join("  ")}`);
}

/** One line per session plus totals, as plain text (no colours, so it also reads well in CI logs). */
export function formatSummary(
  results: readonly SessionResult[],
  delivery: QueueStats,
  elapsedMs: number,
  skipped = 0,
): string {
  const ordered = [...results].sort((a, b) => a.index - b.index);
  const rows = ordered.map((r) => [
    String(r.index + 1),
    r.sessionId.slice(0, 8),
    engineLabel(r),
    visitLabel(r),
    r.scenario,
    r.status,
    wasReported(r.status) ? seconds(r.durationMs) : "-",
    r.startupMs === null ? "-" : seconds(r.startupMs),
    timeToBrowser(r) === null ? "-" : seconds(timeToBrowser(r) as number),
    wasReported(r.status) ? `${r.actions - r.failedActions}/${r.actions}` : "-",
    r.peakMemMb === null ? "-" : `${Math.round(r.peakMemMb)} MB`,
  ]);
  const header = [
    "#",
    "session",
    "engine",
    "target/site",
    "scenario",
    "status",
    "duration",
    "startup",
    "to browser",
    "ok/actions",
    "peak mem",
  ];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, i) => pad(cell, widths[i] ?? 0, i === 0 || i >= 6)).join("  ");

  const lines = [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)];

  const problems = results.filter((r) => r.status !== "success" && r.reason);
  if (problems.length > 0) {
    lines.push("", "Why not success:");
    for (const r of problems) {
      lines.push(`  #${r.index + 1} ${r.status}: ${r.reason?.split("\n")[0]?.slice(0, 200)}`);
    }
  }

  const counts = new Map<ResultStatus, number>();
  for (const r of ordered) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const byStatus = [...counts].map(([status, n]) => `${status} ${n}`).join(", ");
  const totals = engineTotals(results);
  if (totals.length > 0) {
    lines.push(
      "",
      results.some((r) => r.routedFrom !== null)
        ? "By engine (routed sessions count on the engine that ran them):"
        : "By engine:",
      ...totals,
    );
  }
  const sites = siteTotals(results);
  if (sites.length > 0) lines.push("", "By site:", ...sites);
  const routed = results.filter((r) => r.routedFrom !== null);
  if (routed.length > 0) {
    const moves = new Map<string, number>();
    for (const r of routed) {
      const move = `${r.routedFrom} -> ${r.engine}`;
      moves.set(move, (moves.get(move) ?? 0) + 1);
    }
    lines.push(
      "",
      `routed: ${routed.length} of ${results.length} sessions (${[...moves].map(([move, n]) => `${move} ${n}`).join(", ")})`,
    );
  }
  lines.push(
    "",
    `${results.length} sessions in ${seconds(elapsedMs)}: ${byStatus || "none"}${skipped > 0 ? `, ${skipped} not started (interrupted)` : ""}`,
    `events: ${delivery.sent} sent, ${delivery.duplicates} duplicates, ${delivery.dropped} dropped`,
  );
  return `${lines.join("\n")}\n`;
}

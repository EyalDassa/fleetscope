import type { QueueStats } from "@fleetscope/collector";
import type { ResultStatus, SessionResult } from "./session-runner";

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function pad(text: string, width: number, right = false): string {
  return right ? text.padStart(width) : text.padEnd(width);
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
    r.scenario,
    r.status,
    r.status === "infra_error" ? "-" : seconds(r.durationMs),
    r.startupMs === null ? "-" : seconds(r.startupMs),
    r.status === "infra_error" ? "-" : `${r.actions - r.failedActions}/${r.actions}`,
    r.peakMemMb === null ? "-" : `${Math.round(r.peakMemMb)} MB`,
  ]);
  const header = [
    "#",
    "session",
    "scenario",
    "status",
    "duration",
    "startup",
    "ok/actions",
    "peak mem",
  ];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, i) => pad(cell, widths[i] ?? 0, i === 0 || i >= 4)).join("  ");

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
  lines.push(
    "",
    `${results.length} sessions in ${seconds(elapsedMs)}: ${byStatus || "none"}${skipped > 0 ? `, ${skipped} not started (interrupted)` : ""}`,
    `events: ${delivery.sent} sent, ${delivery.duplicates} duplicates, ${delivery.dropped} dropped`,
  );
  return `${lines.join("\n")}\n`;
}

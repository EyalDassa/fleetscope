// The colours dashboards may use: the Dark column of design/DESIGN.md section 2.
// If that table changes, change this file too (design-rules.test.ts compares the two).
// Engines differ by colour only: every time series line is solid (DESIGN.md section 2).
export interface Engine {
  name: string;
  color: string;
}

export const ENGINES: readonly Engine[] = [
  { name: "chromium", color: "#56B4E9" },
  { name: "chrome-headless-shell", color: "#E69F00" },
  { name: "lightpanda", color: "#CC79A7" },
];

/** The field default colour of time series: nothing falls back to Grafana's classic palette. */
export const FIELD_DEFAULT_COLOR = "#9AA9BB";

export const STATUS_COLORS = [
  "#6EE7A8", // healthy
  "#FFD95A", // degraded
  "#FF7B7B", // failed
  "#D9CCFF", // blocked
  "#9AA9BB", // running
  "#7D8DA1", // interrupted
] as const;

/** Neutral for the gauge cells in tables (the approved `--bar`). */
export const BAR_COLOR = "#5B7491";

export const ALLOWED_COLORS: ReadonlySet<string> = new Set(
  [...ENGINES.map((e) => e.color), ...STATUS_COLORS, BAR_COLOR, FIELD_DEFAULT_COLOR].map((c) =>
    c.toLowerCase(),
  ),
);

/** Colour names that follow the theme and are allowed anyway (a threshold base). */
export const ALLOWED_COLOR_NAMES: ReadonlySet<string> = new Set(["text", "transparent"]);

/**
 * Colours for the Capacity dashboard ("Fleetscope / Capacity") only. They mean something only there:
 * the dashboard compares the fleet with ClickHouse, not engines with each other. Every other dashboard
 * is refused these (the same hex on the Overview would read as an engine or a status).
 */
export const CAPACITY_DASHBOARD_UID = "fleetscope-capacity";
export const CAPACITY_COLORS = {
  /** What ClickHouse wrote or used. */
  clickhouse: "#0072B2",
  /** What the fleet sent. */
  fleet: "#009E73",
  /** A limit (solid line, never dashed). */
  limit: "#9AA9BB",
  /** Sessions. */
  sessions: "#F0E442",
} as const;

/** Capacity-only colours that are not already in the shared palette (`limit` equals the neutral grey). */
export const CAPACITY_ONLY_COLORS: ReadonlySet<string> = new Set(
  [CAPACITY_COLORS.clickhouse, CAPACITY_COLORS.fleet, CAPACITY_COLORS.sessions].map((c) =>
    c.toLowerCase(),
  ),
);

/** The colours a dashboard may use: the shared palette, plus the capacity colours on the capacity dashboard. */
export function allowedColorsFor(dashboardUid: string | undefined): ReadonlySet<string> {
  return dashboardUid === CAPACITY_DASHBOARD_UID
    ? new Set([...ALLOWED_COLORS, ...CAPACITY_ONLY_COLORS])
    : ALLOWED_COLORS;
}

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

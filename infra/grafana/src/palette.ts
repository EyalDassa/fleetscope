// The colours dashboards may use: the Dark column of design/DESIGN.md section 2.
// If that table changes, change this file too (design-rules.test.ts compares the two).
export interface Engine {
  name: string;
  color: string;
  /** `custom.lineStyle.fill` of the engine's series. */
  lineFill: "solid" | "dash" | "dot";
}

export const ENGINES: readonly Engine[] = [
  { name: "chromium", color: "#56B4E9", lineFill: "solid" },
  { name: "chrome-headless-shell", color: "#E69F00", lineFill: "dash" },
  { name: "lightpanda", color: "#CC79A7", lineFill: "dot" },
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

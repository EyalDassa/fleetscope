import { describe, expect, it } from "vitest";
import { designProblems } from "./design-rules";
import { allowedColorsFor, CAPACITY_COLORS, CAPACITY_DASHBOARD_UID } from "./palette";
import { dashboardJson } from "./test-fixtures";

function seriesPanel(color: string, overrides: unknown[]): Record<string, unknown> {
  return {
    id: 1,
    type: "timeseries",
    title: "Rows",
    fieldConfig: {
      defaults: {
        color: { mode: "fixed", fixedColor: "#9AA9BB" },
        custom: { spanNulls: false },
        noValue: "No data",
      },
      overrides: [
        {
          matcher: { id: "byName", options: "rows_written" },
          properties: [{ id: "color", value: { mode: "fixed", fixedColor: color } }],
        },
        ...overrides,
      ],
    },
  };
}

describe("capacity palette", () => {
  it("has the four colours of the Capacity dashboard", () => {
    expect(CAPACITY_COLORS).toEqual({
      clickhouse: "#0072B2",
      fleet: "#009E73",
      limit: "#9AA9BB",
      sessions: "#F0E442",
    });
  });

  it("is allowed on the capacity dashboard only", () => {
    expect(allowedColorsFor(CAPACITY_DASHBOARD_UID).has("#0072b2")).toBe(true);
    expect(allowedColorsFor("fleetscope-overview").has("#0072b2")).toBe(false);
    expect(allowedColorsFor(undefined).has("#f0e442")).toBe(false);
    // the limit grey is the neutral grey of the shared palette, so it is allowed everywhere
    expect(allowedColorsFor("fleetscope-overview").has("#9aa9bb")).toBe(true);
  });

  it("names the rule when another dashboard uses a capacity colour", () => {
    const other = dashboardJson({
      uid: "fleetscope-overview",
      panels: [seriesPanel("#0072B2", [])],
    });
    const text = designProblems(other)
      .map((p) => p.message)
      .join("\n");
    expect(text).toContain("Capacity colour");
    expect(text).toContain(CAPACITY_DASHBOARD_UID);
  });

  it("the capacity dashboard may use them, and its series need no engine overrides", () => {
    const capacity = dashboardJson({
      uid: CAPACITY_DASHBOARD_UID,
      panels: [seriesPanel("#0072B2", [])],
    });
    expect(designProblems(capacity)).toEqual([]);
  });

  it("still refuses a dashed line and a colour shared by two series on the capacity dashboard", () => {
    const dashed = seriesPanel("#0072B2", []);
    (dashed.fieldConfig as { defaults: Record<string, unknown> }).defaults.custom = {
      spanNulls: false,
      lineStyle: { fill: "dash", dash: [10, 10] },
    };
    const text = designProblems(dashboardJson({ uid: CAPACITY_DASHBOARD_UID, panels: [dashed] }))
      .map((p) => p.message)
      .join("\n");
    expect(text.toLowerCase()).toContain("solid");

    const shared = seriesPanel("#0072B2", [
      {
        matcher: { id: "byName", options: "rows_sent" },
        properties: [{ id: "color", value: { mode: "fixed", fixedColor: "#0072B2" } }],
      },
    ]);
    const sharedText = designProblems(
      dashboardJson({ uid: CAPACITY_DASHBOARD_UID, panels: [shared] }),
    )
      .map((p) => p.message)
      .join("\n");
    expect(sharedText.length).toBeGreaterThan(0);
  });
});

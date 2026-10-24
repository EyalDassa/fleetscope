import { describe, expect, it } from "vitest";
import type { DashboardFile } from "./dashboards";
import { editAs, fakeGrafana } from "./fake-grafana";
import { TEAM_FOLDER_UID } from "./folder-access";
import type { JsonObject } from "./json";
import { buildDataSource, GrafanaClient, pushToGrafana } from "./push";
import { dashboardJson, testPassword } from "./test-fixtures";

// The folder lock, the team folder and the drift guard of `grafana:push`.

const env = {
  CLICKHOUSE_URL: "https://abc.eu-central-1.aws.clickhouse.cloud:8443",
  CLICKHOUSE_GRAFANA_USER: "grafana_ro",
  CLICKHOUSE_GRAFANA_PASSWORD: testPassword(),
};
const overview = dashboardJson({ uid: "fleetscope-overview", title: "Fleetscope / Overview" });
const sessions = dashboardJson({ uid: "fleetscope-sessions", title: "Fleetscope / Sessions" });

function file(name: string, json: JsonObject): DashboardFile {
  return { file: name, path: name, json, parseError: undefined };
}

function setup(overrides: Partial<Parameters<typeof pushToGrafana>[0]> = {}) {
  const grafana = fakeGrafana();
  const lines: string[] = [];
  const options = {
    client: new GrafanaClient("https://stack.grafana.net", testPassword(), grafana.fetchImpl),
    dataSource: buildDataSource(env, false),
    dashboardFiles: [
      file("fleetscope-overview.json", overview),
      file("fleetscope-sessions.json", sessions),
    ],
    apiUrl: undefined,
    grafanaIsLocal: false,
    dryRun: false,
    canRead: true,
    skipHealthCheck: true,
    log: (line: string) => lines.push(line),
    ...overrides,
  };
  return { ...grafana, lines, options };
}

/** What a role can do in a folder, from the fake's permission rows. */
function permissionOf(rows: JsonObject[] | undefined, role: string): unknown {
  return rows?.find((r) => r.builtInRole === role && r.isManaged === true)?.permission;
}

const writes = (calls: string[]): string[] => calls.filter((c) => !c.startsWith("GET "));

describe("the official folder is locked", () => {
  it("lets Viewers and Editors view, and Admins administer", async () => {
    const { state, options, lines } = setup();
    const result = await pushToGrafana(options);

    const rows = state.permissions.get("fleetscope");
    expect(permissionOf(rows, "Viewer")).toBe("View");
    expect(permissionOf(rows, "Editor")).toBe("View");
    expect(rows?.some((r) => r.builtInRole === "Admin" && r.permission === "Admin")).toBe(true);
    expect(result.lock).toBe("updated");
    expect(lines.join("\n")).toMatch(
      /lock\s+fleetscope: Viewer View, Editor View, Admin Admin\s+updated \(Editor: Edit -> View\)/,
    );
  });

  it("uses the built-in-role permission endpoint, one POST per changed role", async () => {
    const { state, options } = setup();
    await pushToGrafana(options);
    const posts = state.calls.filter((c) => c.includes("/api/access-control/folders/fleetscope/"));
    expect(posts).toEqual(["POST /api/access-control/folders/fleetscope/builtInRoles/Editor"]);
  });

  it("is idempotent: a second push changes no permission", async () => {
    const { state, options, lines } = setup();
    await pushToGrafana(options);
    state.calls.length = 0;
    lines.length = 0;
    const second = await pushToGrafana(options);

    expect(second.lock).toBe("unchanged");
    expect(second.teamFolder).toBe("unchanged");
    expect(second.teamAccess).toBe("unchanged");
    expect(
      state.calls.filter((c) => c.includes("/api/access-control/") && c.startsWith("POST")),
    ).toEqual([]);
    expect(lines.join("\n")).toMatch(/lock\s+fleetscope:.*unchanged/);
  });

  it("puts a loosened folder back and leaves single-user grants alone, but says so", async () => {
    const { state, options, lines } = setup();
    await pushToGrafana(options);
    const rows = state.permissions.get("fleetscope") as JsonObject[];
    (rows.find((r) => r.builtInRole === "Editor") as JsonObject).permission = "Edit";
    rows.push({ userLogin: "alice", permission: "Edit", isManaged: true, isInherited: false });
    lines.length = 0;

    const result = await pushToGrafana(options);
    expect(result.lock).toBe("updated");
    expect(permissionOf(state.permissions.get("fleetscope"), "Editor")).toBe("View");
    expect(state.permissions.get("fleetscope")?.some((r) => r.userLogin === "alice")).toBe(true);
    expect(lines.join("\n")).toMatch(
      /note\s+fleetscope also has grants to single users or teams \(alice: Edit\)/,
    );
  });

  it("in a dry run reads the permissions but changes nothing", async () => {
    const { state, options, lines } = setup();
    await pushToGrafana(options);
    const rows = state.permissions.get("fleetscope") as JsonObject[];
    (rows.find((r) => r.builtInRole === "Editor") as JsonObject).permission = "Edit";
    state.calls.length = 0;
    lines.length = 0;

    const result = await pushToGrafana({ ...options, dryRun: true });
    expect(result.lock).toBe("updated");
    expect(writes(state.calls)).toEqual([]);
    expect(permissionOf(state.permissions.get("fleetscope"), "Editor")).toBe("Edit");
    expect(lines.join("\n")).toMatch(
      /lock\s+fleetscope:.*would be updated \(Editor: Edit -> View\)/,
    );
  });
});

describe("the team folder", () => {
  it("is created with Editor Edit and Viewer View", async () => {
    const { state, options, lines } = setup();
    const result = await pushToGrafana(options);

    expect(result.teamFolder).toBe("created");
    expect(state.folders.get(TEAM_FOLDER_UID)).toEqual({
      uid: "fleetscope-team",
      title: "Team dashboards",
    });
    const rows = state.permissions.get(TEAM_FOLDER_UID);
    expect(permissionOf(rows, "Editor")).toBe("Edit");
    expect(permissionOf(rows, "Viewer")).toBe("View");
    expect(lines.join("\n")).toMatch(/folder\s+fleetscope-team \("Team dashboards"\)\s+created/);
    expect(lines.join("\n")).toMatch(
      /access\s+fleetscope-team: Viewer View, Editor Edit, Admin Admin/,
    );
  });

  it("is repaired when somebody changed its access, and kept otherwise", async () => {
    const { state, options } = setup();
    await pushToGrafana(options);
    const rows = state.permissions.get(TEAM_FOLDER_UID) as JsonObject[];
    (rows.find((r) => r.builtInRole === "Editor") as JsonObject).permission = "View";
    const result = await pushToGrafana(options);
    expect(result.teamAccess).toBe("updated");
    expect(permissionOf(state.permissions.get(TEAM_FOLDER_UID), "Editor")).toBe("Edit");
  });

  it("never reads, writes or lists what is inside, and is not part of the 'left alone' report", async () => {
    const { state, options, lines } = setup();
    await pushToGrafana(options);
    // somebody's own dashboard in the team folder, and one in the official folder that the repo lacks
    state.dashboards.set("team-mine", dashboardJson({ uid: "team-mine", title: "Mine" }));
    state.meta.set("team-mine", { updatedBy: "alice", folderUid: TEAM_FOLDER_UID });
    state.dashboards.set(
      "official-extra",
      dashboardJson({ uid: "official-extra", title: "Extra" }),
    );
    state.meta.set("official-extra", { updatedBy: "admin", folderUid: "fleetscope" });
    state.calls.length = 0;
    lines.length = 0;

    const result = await pushToGrafana(options);

    expect(state.calls.filter((c) => c.includes("team-mine"))).toEqual([]);
    expect(state.dashboards.has("team-mine")).toBe(true);
    expect(result.extraDashboards).toEqual(["official-extra"]);
    expect(lines.join("\n")).not.toContain("team-mine");
    expect(state.calls).toContain("GET /api/search");
    // the search is limited to the official folder
    expect(state.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
  });

  it("is only planned in a dry run", async () => {
    const { state, options, lines } = setup();
    const result = await pushToGrafana({ ...options, dryRun: true });
    expect(result.teamFolder).toBe("created");
    expect(state.folders.size).toBe(0);
    expect(writes(state.calls)).toEqual([]);
    expect(lines.join("\n")).toMatch(/fleetscope-team \("Team dashboards"\)\s+would be created/);
  });
});

describe("the drift guard", () => {
  /** A repo dashboard that somebody else changed in Grafana. */
  async function driftedSetup(
    meta: JsonObject = { updatedBy: "alice", updated: "2026-10-24T18:30:00Z" },
  ) {
    const grafana = setup();
    await pushToGrafana(grafana.options);
    // alice's edit: different content, saved by alice
    grafana.state.dashboards.set(
      "fleetscope-overview",
      dashboardJson({ uid: "fleetscope-overview", title: "Fleetscope / Overview (alice)" }),
    );
    const { updatedBy, ...rest } = meta;
    editAs(grafana.state, "fleetscope-overview", String(updatedBy), rest);
    grafana.state.calls.length = 0;
    grafana.lines.length = 0;
    return grafana;
  }
  const dashboardPosts = (calls: string[]): number =>
    calls.filter((c) => c === "POST /api/dashboards/db").length;

  it("refuses a dashboard that somebody else saved, says who and when, and pushes the rest", async () => {
    const { state, options, lines } = await driftedSetup();
    state.dashboards.set(
      "fleetscope-sessions",
      dashboardJson({ uid: "fleetscope-sessions", title: "stale" }),
    ); // own account's older version: updates normally
    const result = await pushToGrafana(options);

    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toMatchObject({
      uid: "fleetscope-overview",
      by: "alice",
      at: "2026-10-24T18:30:00Z",
    });
    expect(result.dashboards).toEqual([
      { uid: "fleetscope-overview", action: "refused" },
      { uid: "fleetscope-sessions", action: "updated" },
    ]);
    expect((state.dashboards.get("fleetscope-overview") as JsonObject).title).toContain("(alice)");
    expect(dashboardPosts(state.calls)).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("REFUSED     dashboard fleetscope-overview");
    expect(text).toContain("last saved in Grafana by alice at 2026-10-24T18:30:00Z");
    expect(text).toContain("pnpm grafana:pull fleetscope-overview");
    expect(text).toContain("pnpm grafana:push --force");
  });

  it("--force overwrites it", async () => {
    const { state, options } = await driftedSetup();
    const result = await pushToGrafana({ ...options, force: true });
    expect(result.refused).toEqual([]);
    expect(result.dashboards[0]).toEqual({ uid: "fleetscope-overview", action: "updated" });
    expect((state.dashboards.get("fleetscope-overview") as JsonObject).title).toBe(
      "Fleetscope / Overview",
    );
  });

  it("does not refuse what the push's own account saved last, or what equals the repository", async () => {
    const own = await driftedSetup({
      updatedBy: "fleetscope-push", // a service account is recorded by its name
      updated: "2026-10-24T18:30:00Z",
    });
    expect((await pushToGrafana(own.options)).refused).toEqual([]);

    // alice saved it, but the content is the repo's: nothing to refuse, and nothing to lose
    const same = setup();
    await pushToGrafana(same.options);
    editAs(same.state, "fleetscope-overview", "alice");
    const result = await pushToGrafana(same.options);
    expect(result.refused).toEqual([]);
    expect(result.dashboards[0]).toEqual({ uid: "fleetscope-overview", action: "adopted" });
  });

  it("adopts a dashboard that equals the repository but was saved by somebody else, once", async () => {
    // RV-RT-01: alice edits, push refuses, her version is pulled and merged, push adopts it,
    // the next repository change goes through without --force.
    const g = setup();
    await pushToGrafana(g.options);
    const aliceVersion = dashboardJson({
      uid: "fleetscope-overview",
      title: "Fleetscope / Overview (alice)",
    });
    g.state.dashboards.set("fleetscope-overview", aliceVersion);
    editAs(g.state, "fleetscope-overview", "alice");
    expect((await pushToGrafana(g.options)).refused).toHaveLength(1);

    // the pull was merged: the repository now has alice's version
    const files = [
      file("fleetscope-overview.json", aliceVersion),
      file("fleetscope-sessions.json", sessions),
    ];
    const merged = { ...g.options, dashboardFiles: files };

    g.state.calls.length = 0;
    g.lines.length = 0;
    const dry = await pushToGrafana({ ...merged, dryRun: true });
    expect(dry.dashboards[0]).toEqual({ uid: "fleetscope-overview", action: "adopted" });
    expect(g.lines.join("\n")).toMatch(/fleetscope-overview\s+would be adopted/);
    expect(g.state.calls.filter((c) => c === "POST /api/dashboards/db")).toEqual([]);

    g.state.calls.length = 0;
    const adopted = await pushToGrafana(merged);
    // two saves: Grafana records no new author for a save that changes nothing
    expect(g.state.calls.filter((c) => c === "POST /api/dashboards/db")).toHaveLength(2);
    expect(adopted.dashboards[0]).toEqual({ uid: "fleetscope-overview", action: "adopted" });
    expect(adopted.refused).toEqual([]);
    expect(g.state.meta.get("fleetscope-overview")?.updatedBy).toBe("fleetscope-push");
    expect(g.lines.join("\n")).toMatch(/fleetscope-overview\s+adopted/);

    // adopted once: the next run has nothing to do
    const again = await pushToGrafana(merged);
    expect(again.dashboards[0]).toEqual({ uid: "fleetscope-overview", action: "unchanged" });

    // an ordinary repository change is pushed, no --force needed
    const changed = dashboardJson({
      uid: "fleetscope-overview",
      title: "Fleetscope / Overview v3",
    });
    const next = await pushToGrafana({
      ...merged,
      dashboardFiles: [
        file("fleetscope-overview.json", changed),
        file("fleetscope-sessions.json", sessions),
      ],
    });
    expect(next.refused).toEqual([]);
    expect(next.dashboards[0]).toEqual({ uid: "fleetscope-overview", action: "updated" });
    expect((g.state.dashboards.get("fleetscope-overview") as JsonObject).title).toBe(
      "Fleetscope / Overview v3",
    );
  });

  it("trusts the version history over meta: a dashboard the push only created is not 'adopted'", async () => {
    // Measured on Grafana 13.2.4: meta.updatedBy of a service account's first save says "Anonymous",
    // the version history says the service account. The second push must find nothing to do.
    const g = setup();
    await pushToGrafana(g.options);
    expect(g.state.meta.get("fleetscope-overview")?.updatedBy).toBe("Anonymous");
    g.state.calls.length = 0;
    const second = await pushToGrafana(g.options);
    expect(second.dashboards.map((d) => d.action)).toEqual(["unchanged", "unchanged"]);
    expect(g.state.calls.filter((c) => c === "POST /api/dashboards/db")).toEqual([]);
  });

  it("does not adopt a dashboard that is in the team folder", async () => {
    const g = await driftedSetup({ updatedBy: "alice", folderUid: TEAM_FOLDER_UID });
    g.state.dashboards.set("fleetscope-overview", overview); // equals the repository
    const result = await pushToGrafana(g.options);
    expect(result.dashboards[0]).toEqual({ uid: "fleetscope-overview", action: "unchanged" });
    expect(g.state.calls.filter((c) => c === "POST /api/dashboards/db")).toEqual([]);
  });

  it("--force <uid> discards only that dashboard", async () => {
    const g = await driftedSetup();
    g.state.dashboards.set(
      "fleetscope-sessions",
      dashboardJson({ uid: "fleetscope-sessions", title: "Fleetscope / Sessions (bob)" }),
    );
    editAs(g.state, "fleetscope-sessions", "bob");

    const result = await pushToGrafana({ ...g.options, forceUids: ["fleetscope-overview"] });
    expect(result.dashboards).toEqual([
      { uid: "fleetscope-overview", action: "updated" },
      { uid: "fleetscope-sessions", action: "refused" },
    ]);
    expect(result.refused.map((r) => r.uid)).toEqual(["fleetscope-sessions"]);
    expect(g.lines.join("\n")).toContain("pnpm grafana:push --force fleetscope-sessions");
  });

  it("--force <uid> with a uid that is not in the repository stops before any write", async () => {
    const g = await driftedSetup();
    await expect(pushToGrafana({ ...g.options, forceUids: ["nope"] })).rejects.toThrow(
      /--force nope: no dashboard file/,
    );
    expect(writes(g.state.calls)).toEqual([]);
  });

  it("does not refuse what Grafana's own file provisioning saved (local development)", async () => {
    const provisioned = await driftedSetup({
      updatedBy: "Anonymous",
      provisionedExternalId: "fleetscope-overview.json",
    });
    expect((await pushToGrafana(provisioned.options)).refused).toEqual([]);
    // "Anonymous" without a provisioning id is not an exemption
    const anonymous = await driftedSetup({ updatedBy: "Anonymous" });
    expect((await pushToGrafana(anonymous.options)).refused).toHaveLength(1);
  });

  it("refuses when it cannot tell who the token is", async () => {
    const { state, options } = await driftedSetup();
    state.user = {}; // /api/user without a login
    expect((await pushToGrafana(options)).refused).toHaveLength(1);
  });

  it("in a dry run says what would be refused and writes nothing", async () => {
    const { state, options, lines } = await driftedSetup();
    const result = await pushToGrafana({ ...options, dryRun: true });
    expect(result.refused).toHaveLength(1);
    expect(writes(state.calls)).toEqual([]);
    expect(lines.join("\n")).toMatch(/REFUSED\s+dashboard fleetscope-overview\s+would be refused/);
  });

  it("never overwrites or moves a repository uid that lives in the team folder, even with --force", async () => {
    const { state, options } = await driftedSetup({
      updatedBy: "alice",
      folderUid: TEAM_FOLDER_UID,
    });
    const result = await pushToGrafana({ ...options, force: true });
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.reason).toContain("Team dashboards");
    expect(dashboardPosts(state.calls)).toBe(0);
  });
});

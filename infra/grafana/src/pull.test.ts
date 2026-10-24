import { describe, expect, it } from "vitest";
import { fakeGrafana } from "./fake-grafana";
import { TEAM_FOLDER_UID } from "./folder-access";
import type { JsonObject } from "./json";
import { API_URL_PLACEHOLDER, fetchDashboard, normaliseDashboard, pullReminder } from "./pull";
import { buildDataSource, GrafanaClient, PushError, pushToGrafana } from "./push";
import { dashboardJson, testPassword } from "./test-fixtures";

const REMOTE_URL = "https://api.fleetscope.example";

// What Grafana returns for a dashboard somebody built or edited in the UI.
function fromGrafana(meta: JsonObject = {}): JsonObject {
  const chDatasource = { type: "grafana-clickhouse-datasource", uid: "abcd1234" };
  return {
    dashboard: {
      id: 42,
      version: 7,
      uid: "team-latency",
      title: "Latency, my view",
      tags: ["fleetscope"],
      panels: [
        {
          id: 1,
          type: "stat",
          datasource: chDatasource,
          targets: [{ refId: "A", rawSql: "SELECT 1", datasource: { ...chDatasource } }],
        },
      ],
      templating: {
        list: [
          {
            name: "api_url",
            type: "constant",
            query: REMOTE_URL,
            current: { text: REMOTE_URL, value: REMOTE_URL },
            options: [{ selected: true, text: REMOTE_URL, value: REMOTE_URL }],
          },
        ],
      },
    },
    meta: { folderUid: TEAM_FOLDER_UID, folderTitle: "Team dashboards", ...meta },
  };
}

function apiUrlVariable(dashboard: JsonObject): JsonObject {
  const list = (dashboard.templating as JsonObject).list as JsonObject[];
  return list[0] as JsonObject;
}

describe("normaliseDashboard", () => {
  it("strips id, version and meta, restores api_url and the data source uid", () => {
    const pulled = normaliseDashboard(fromGrafana());
    const dashboard = pulled.json;

    expect(dashboard).not.toHaveProperty("id");
    expect(dashboard).not.toHaveProperty("version");
    expect(dashboard).not.toHaveProperty("meta");
    expect(dashboard.uid).toBe("team-latency");
    expect(apiUrlVariable(dashboard).query).toBe(API_URL_PLACEHOLDER);
    expect(apiUrlVariable(dashboard).current).toMatchObject({ value: API_URL_PLACEHOLDER });
    const panel = (dashboard.panels as JsonObject[])[0] as JsonObject;
    expect((panel.datasource as JsonObject).uid).toBe("fleetscope-clickhouse");
    const target = (panel.targets as JsonObject[])[0] as JsonObject;
    expect((target.datasource as JsonObject).uid).toBe("fleetscope-clickhouse");
    expect(pulled.notes.join("\n")).toContain(`api_url set back to ${API_URL_PLACEHOLDER}`);
    expect(pulled.notes.join("\n")).toContain("2 data source reference");
  });

  it("uses the api_url of the existing repository file when there is one", () => {
    const pulled = normaliseDashboard(fromGrafana(), "http://localhost:4100");
    expect(apiUrlVariable(pulled.json).query).toBe("http://localhost:4100");
  });

  it("writes two-space JSON with a final newline, and does not change its input", () => {
    const response = fromGrafana();
    const before = JSON.stringify(response);
    const pulled = normaliseDashboard(response);
    expect(JSON.stringify(response)).toBe(before);
    expect(pulled.text.endsWith("}\n")).toBe(true);
    expect(pulled.text).toBe(`${JSON.stringify(pulled.json, null, 2)}\n`);
    expect(pulled.text).toContain('\n  "uid": "team-latency",');
  });

  it("follows the key order and the api_url variable of the existing repository file", () => {
    const committed = {
      uid: "team-latency",
      title: "Latency",
      templating: {
        list: [{ type: "constant", name: "api_url", query: API_URL_PLACEHOLDER, hide: 2 }],
      },
      tags: ["fleetscope"],
    };
    const pulled = normaliseDashboard(fromGrafana(), API_URL_PLACEHOLDER, committed);
    // committed order first (uid, title, templating, tags), then what Grafana added
    expect(Object.keys(pulled.json).slice(0, 4)).toEqual(["uid", "title", "templating", "tags"]);
    expect(Object.keys(pulled.json)).toContain("panels");
    // the variable is exactly the committed one, not a rebuilt copy
    expect(apiUrlVariable(pulled.json)).toEqual(committed.templating.list[0]);
  });

  it("leaves a dashboard without api_url or ClickHouse references as it is", () => {
    const pulled = normaliseDashboard({
      dashboard: { id: 1, version: 2, uid: "plain", title: "Plain", panels: [] },
      meta: {},
    });
    expect(pulled.json).toEqual({ uid: "plain", title: "Plain", panels: [] });
    expect(pulled.notes).toEqual(["removed id and version"]);
  });

  it("rejects an answer without a dashboard", () => {
    expect(() => normaliseDashboard({})).toThrow(PushError);
  });

  it("round trip: what push wrote and pull reads back pushes again as unchanged", async () => {
    const grafana = fakeGrafana();
    const client = new GrafanaClient(
      "https://stack.grafana.net",
      testPassword(),
      grafana.fetchImpl,
    );
    const options = {
      client,
      dataSource: buildDataSource(
        {
          CLICKHOUSE_URL: "https://abc.clickhouse.cloud:8443",
          CLICKHOUSE_GRAFANA_USER: "grafana_ro",
          CLICKHOUSE_GRAFANA_PASSWORD: testPassword(),
        },
        false,
      ),
      dashboardFiles: [
        {
          file: "d.json",
          path: "d.json",
          parseError: undefined,
          json: dashboardJson({
            uid: "fleetscope-session",
            templating: {
              list: [{ name: "api_url", type: "constant", query: API_URL_PLACEHOLDER, hide: 2 }],
            },
          }),
        },
      ],
      apiUrl: REMOTE_URL,
      grafanaIsLocal: false,
      dryRun: false,
      canRead: true,
      skipHealthCheck: true,
      log: () => {},
    };
    await pushToGrafana(options);
    const pulled = await fetchDashboard(client, "fleetscope-session");
    expect(apiUrlVariable(pulled.json).query).toBe(API_URL_PLACEHOLDER);

    const again = await pushToGrafana({
      ...options,
      dashboardFiles: [
        { file: "d.json", path: "d.json", parseError: undefined, json: pulled.json },
      ],
    });
    expect(again.dashboards).toEqual([{ uid: "fleetscope-session", action: "unchanged" }]);
  });
});

describe("fetchDashboard", () => {
  it("says so when Grafana has no such dashboard, and refuses a malformed uid without asking", async () => {
    const grafana = fakeGrafana();
    const client = new GrafanaClient(
      "https://stack.grafana.net",
      testPassword(),
      grafana.fetchImpl,
    );
    await expect(fetchDashboard(client, "nope")).rejects.toThrow(/no dashboard with uid nope/);
    await expect(fetchDashboard(client, "../admin")).rejects.toThrow(/not a dashboard uid/);
    expect(grafana.state.calls).toEqual(["GET /api/dashboards/uid/nope"]);
  });
});

describe("pullReminder", () => {
  it("tells a team dashboard to go through grafana:check and a pull request", () => {
    const text = pullReminder(normaliseDashboard(fromGrafana()), "team-latency").join("\n");
    expect(text).toContain("official dashboard CANDIDATE");
    expect(text).toContain("the team folder");
    expect(text).toContain("grafana:check");
    expect(text).toContain("pull request");
  });

  it("warns that a team dashboard keeps its uid, and gives --as for the fix", () => {
    const text = pullReminder(normaliseDashboard(fromGrafana()), "team-latency").join("\n");
    expect(text).toContain("push would refuse it");
    expect(text).toContain("pnpm grafana:pull team-latency --as fleetscope-<name>");
  });

  it("with --as the file gets the new uid and the warning goes away", () => {
    const pulled = normaliseDashboard(
      fromGrafana(),
      API_URL_PLACEHOLDER,
      undefined,
      "fleetscope-latency",
    );
    expect(pulled.json.uid).toBe("fleetscope-latency");
    expect(pullReminder(pulled, "team-latency").join("\n")).not.toContain("push would refuse it");
  });

  it("tells an official dashboard to be committed", () => {
    const official = fromGrafana({ folderUid: "fleetscope", folderTitle: "Fleetscope" });
    const text = pullReminder(normaliseDashboard(official), "fleetscope-overview").join("\n");
    expect(text).toContain("is an official dashboard");
    expect(text).toContain("adopted");
  });
});

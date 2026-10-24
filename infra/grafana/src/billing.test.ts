import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BILLING_DATASOURCE_UID,
  buildBillingDataSource,
  CH_ORG_VARIABLE,
  chOrgFromEnv,
  ensureInfinityPlugin,
  INFINITY_PLUGIN_ID,
  INFINITY_PLUGIN_VERSION,
  withConstantVariable,
} from "./billing";
import { loadDashboardFiles } from "./dashboards";
import { fakeGrafana } from "./fake-grafana";
import type { JsonObject } from "./json";
import { buildDataSource, GrafanaClient, type PushOptions, pushToGrafana } from "./push";
import { dashboardJson, testPassword } from "./test-fixtures";

const KEY_ID = `id_${testPassword()}`;
const KEY_SECRET = `secret_${testPassword()}`;
const ORG = "3f1c2d4e-0000-4000-8000-000000000001";
const TOKEN = `glsa_${testPassword()}`;

describe("buildBillingDataSource", () => {
  it("builds the data source with basic auth, one allowed host and the secret in secureJsonData", () => {
    const built = buildBillingDataSource({
      CLICKHOUSE_CLOUD_KEY_ID: KEY_ID,
      CLICKHOUSE_CLOUD_KEY_SECRET: KEY_SECRET,
    });
    expect(built.enabled).toBe(true);
    if (!built.enabled) return;
    expect(built.dataSource).toMatchObject({
      uid: "clickhouse-cloud-api",
      name: "ClickHouse Cloud API",
      type: "yesoreyeram-infinity-datasource",
      url: "https://api.clickhouse.cloud",
      basicAuth: true,
      basicAuthUser: KEY_ID,
      jsonData: { auth_method: "basicAuth", allowedHosts: ["https://api.clickhouse.cloud"] },
      secureJsonData: { basicAuthPassword: KEY_SECRET },
    });
    // the secret is only in secureJsonData
    expect(JSON.stringify({ ...built.dataSource, secureJsonData: undefined })).not.toContain(
      KEY_SECRET,
    );
  });

  it("is skipped, not an error, without the key", () => {
    const built = buildBillingDataSource({});
    expect(built.enabled).toBe(false);
    if (!built.enabled) expect(built.reason).toMatch(/not set.*skipped/);
  });

  it("is skipped with a clear note when only one of the two is set", () => {
    const onlyId = buildBillingDataSource({ CLICKHOUSE_CLOUD_KEY_ID: KEY_ID });
    expect(onlyId.enabled).toBe(false);
    if (!onlyId.enabled) expect(onlyId.reason).toContain("CLICKHOUSE_CLOUD_KEY_SECRET");
    const onlySecret = buildBillingDataSource({ CLICKHOUSE_CLOUD_KEY_SECRET: KEY_SECRET });
    if (!onlySecret.enabled) expect(onlySecret.reason).toContain("CLICKHOUSE_CLOUD_KEY_ID");
    // the reason never contains a value
    if (!onlyId.enabled) expect(onlyId.reason).not.toContain(KEY_ID);
  });

  it("reads the org id, empty counts as unset", () => {
    expect(chOrgFromEnv({ CLICKHOUSE_CLOUD_ORG_ID: ` ${ORG} ` })).toBe(ORG);
    expect(chOrgFromEnv({ CLICKHOUSE_CLOUD_ORG_ID: "" })).toBeUndefined();
    expect(chOrgFromEnv({})).toBeUndefined();
  });
});

describe("withConstantVariable", () => {
  const dashboard = dashboardJson({
    templating: {
      list: [
        { name: CH_ORG_VARIABLE, type: "constant", query: "", hide: 2 },
        { name: "other", type: "constant", query: "keep" },
      ],
    },
  });

  it("writes query, current and options of the named constant only", () => {
    const out = withConstantVariable(dashboard, CH_ORG_VARIABLE, ORG);
    const list = (out.templating as JsonObject).list as JsonObject[];
    expect(list[0]).toMatchObject({
      name: "ch_org",
      query: ORG,
      current: { value: ORG },
      options: [{ value: ORG, selected: true }],
      hide: 2,
    });
    expect(list[1]?.query).toBe("keep");
  });

  it("returns the dashboard itself when it has no such variable", () => {
    const plain = dashboardJson();
    expect(withConstantVariable(plain, CH_ORG_VARIABLE, ORG)).toBe(plain);
  });
});

describe("pinned plugin version", () => {
  it("equals the version preinstalled by docker-compose (local Grafana)", () => {
    const compose = readFileSync(
      fileURLToPath(new URL("../../docker-compose.yml", import.meta.url)),
      "utf8",
    );
    expect(compose).toContain(`${INFINITY_PLUGIN_ID}@${INFINITY_PLUGIN_VERSION}`);
  });
});

describe("ensureInfinityPlugin", () => {
  const client = (): { c: GrafanaClient; grafana: ReturnType<typeof fakeGrafana> } => {
    const grafana = fakeGrafana();
    return { c: new GrafanaClient("https://stack.grafana.net", TOKEN, grafana.fetchImpl), grafana };
  };

  it("leaves an installed plugin alone, and notes a different version", async () => {
    const { c, grafana } = client();
    grafana.state.plugins.set(INFINITY_PLUGIN_ID, INFINITY_PLUGIN_VERSION);
    expect(await ensureInfinityPlugin(c, { dryRun: false, read: true })).toMatchObject({
      state: "unchanged",
      note: undefined,
    });
    grafana.state.plugins.set(INFINITY_PLUGIN_ID, "3.0.0");
    const older = await ensureInfinityPlugin(c, { dryRun: false, read: true });
    expect(older.state).toBe("unchanged");
    expect(older.note).toContain("3.0.0");
    expect(grafana.state.calls.filter((call) => call.includes("/install"))).toEqual([]);
  });

  it("installs the pinned version when missing, and only says so in a dry run", async () => {
    const dry = client();
    expect((await ensureInfinityPlugin(dry.c, { dryRun: true, read: true })).state).toBe(
      "would-install",
    );
    expect(dry.grafana.state.plugins.size).toBe(0);
    const real = client();
    expect((await ensureInfinityPlugin(real.c, { dryRun: false, read: true })).state).toBe(
      "installed",
    );
    expect(real.grafana.state.plugins.get(INFINITY_PLUGIN_ID)).toBe(INFINITY_PLUGIN_VERSION);
  });

  it("reports 'unavailable' with the manual step when the install is refused", async () => {
    const { c, grafana } = client();
    grafana.state.allowPluginInstall = false;
    const result = await ensureInfinityPlugin(c, { dryRun: false, read: true });
    expect(result.state).toBe("unavailable");
    expect(result.note).toContain("Install it by hand");
  });
});

describe("pushToGrafana: billing and ch_org", () => {
  const chEnv = {
    CLICKHOUSE_URL: "https://abc.eu-central-1.aws.clickhouse.cloud:8443",
    CLICKHOUSE_GRAFANA_USER: "grafana_ro",
    CLICKHOUSE_GRAFANA_PASSWORD: testPassword(),
  };
  const capacity = dashboardJson({
    uid: "fleetscope-capacity",
    title: "Fleetscope / Capacity",
    templating: { list: [{ name: "ch_org", type: "constant", query: "", hide: 2 }] },
  });

  function run(
    overrides: Partial<PushOptions> = {},
    key: Record<string, string> = {
      CLICKHOUSE_CLOUD_KEY_ID: KEY_ID,
      CLICKHOUSE_CLOUD_KEY_SECRET: KEY_SECRET,
    },
  ) {
    const grafana = fakeGrafana();
    const lines: string[] = [];
    const options: PushOptions = {
      client: new GrafanaClient("https://stack.grafana.net", TOKEN, grafana.fetchImpl),
      dataSource: buildDataSource(chEnv, false),
      dashboardFiles: [
        { file: "fleetscope-capacity.json", path: "x", json: capacity, parseError: undefined },
      ],
      billing: buildBillingDataSource(key),
      chOrg: ORG,
      apiUrl: undefined,
      grafanaIsLocal: false,
      dryRun: false,
      canRead: true,
      skipHealthCheck: true,
      log: (line) => lines.push(line),
      ...overrides,
    };
    return { grafana, lines, options, result: () => pushToGrafana(options) };
  }

  it("installs the plugin, creates the data source, writes ch_org, and never prints the key", async () => {
    const t = run();
    const result = await t.result();
    expect(result.infinityPlugin).toBe("installed");
    expect(result.billingSource).toBe("created");
    expect(t.grafana.state.sources.get(BILLING_DATASOURCE_UID)).toMatchObject({
      basicAuthUser: KEY_ID,
      secureJsonData: { basicAuthPassword: KEY_SECRET },
    });
    const stored = t.grafana.state.dashboards.get("fleetscope-capacity") as JsonObject;
    const org = ((stored.templating as JsonObject).list as JsonObject[])[0];
    expect(org?.query).toBe(ORG);
    const output = t.lines.join("\n");
    expect(output).not.toContain(KEY_SECRET);
    expect(output).not.toContain(KEY_ID);
    expect(output).toContain("data source clickhouse-cloud-api  created");
  });

  it("a second push finds the plugin and updates the data source, the dashboard is unchanged", async () => {
    const first = run();
    await first.result();
    const second = await pushToGrafana({ ...first.options, log: () => undefined });
    expect(second.infinityPlugin).toBe("unchanged");
    expect(second.billingSource).toBe("updated");
    expect(second.dashboards).toEqual([{ uid: "fleetscope-capacity", action: "unchanged" }]);
  });

  it("without the key the data source is skipped with a note, and the push still works", async () => {
    const t = run({ billing: buildBillingDataSource({}) });
    const result = await t.result();
    expect(result.billingSource).toBe("skipped");
    expect(result.infinityPlugin).toBe("not-needed");
    expect(t.grafana.state.sources.has(BILLING_DATASOURCE_UID)).toBe(false);
    expect(t.lines.join("\n")).toContain("note        billing: CLICKHOUSE_CLOUD_KEY_ID");
  });

  it("an install refused by Grafana skips the data source and warns, it does not fail the push", async () => {
    const t = run();
    t.grafana.state.allowPluginInstall = false;
    const result = await t.result();
    expect(result.infinityPlugin).toBe("unavailable");
    expect(result.billingSource).toBe("skipped");
    expect(result.warnings.join(" ")).toContain("Infinity plugin is not available");
  });

  it("dry run changes nothing", async () => {
    const t = run({ dryRun: true });
    const result = await t.result();
    expect(result.billingSource).toBe("created");
    expect(t.grafana.state.sources.size).toBe(0);
    expect(t.grafana.state.plugins.size).toBe(0);
    expect(
      t.grafana.state.calls.filter((c) => c.startsWith("POST") || c.startsWith("PUT")),
    ).toEqual([]);
  });

  it("warns when a dashboard has ch_org but CLICKHOUSE_CLOUD_ORG_ID is not set", async () => {
    const t = run({ chOrg: undefined });
    const result = await t.result();
    expect(result.warnings.join(" ")).toContain("CLICKHOUSE_CLOUD_ORG_ID is not set");
  });
});

describe("the committed Capacity dashboard and ch_org", () => {
  const files = loadDashboardFiles(fileURLToPath(new URL("../dashboards", import.meta.url))).filter(
    (f) => f.json?.uid === "fleetscope-capacity",
  );
  const variable = (json: JsonObject): JsonObject | undefined =>
    (((json.templating as JsonObject).list as JsonObject[]) ?? []).find((v) => v.name === "ch_org");

  function push(chOrg: string | undefined) {
    const grafana = fakeGrafana();
    const lines: string[] = [];
    const options: PushOptions = {
      client: new GrafanaClient("https://stack.grafana.net", TOKEN, grafana.fetchImpl),
      dataSource: buildDataSource(
        {
          CLICKHOUSE_URL: "https://abc.eu-central-1.aws.clickhouse.cloud:8443",
          CLICKHOUSE_GRAFANA_USER: "grafana_ro",
          CLICKHOUSE_GRAFANA_PASSWORD: testPassword(),
        },
        false,
      ),
      dashboardFiles: files,
      billing: buildBillingDataSource({}),
      chOrg,
      apiUrl: undefined,
      grafanaIsLocal: false,
      dryRun: false,
      canRead: true,
      skipHealthCheck: true,
      log: (line) => lines.push(line),
    };
    return { grafana, lines, run: () => pushToGrafana(options) };
  }

  it("is in the repository with a placeholder ch_org", () => {
    expect(files).toHaveLength(1);
    expect(variable((files[0] as { json: JsonObject }).json)?.query).toBe("set-by-grafana-push");
  });

  it("the push overwrites the placeholder with CLICKHOUSE_CLOUD_ORG_ID (query, current and options)", async () => {
    const t = push(ORG);
    await t.run();
    const stored = variable(t.grafana.state.dashboards.get("fleetscope-capacity") as JsonObject);
    expect(stored).toMatchObject({
      query: ORG,
      current: { value: ORG, text: ORG },
      options: [{ value: ORG }],
    });
  });

  it("without the env the placeholder stays and the push says so", async () => {
    const t = push(undefined);
    await t.run();
    const stored = variable(t.grafana.state.dashboards.get("fleetscope-capacity") as JsonObject);
    expect(stored?.query).toBe("set-by-grafana-push");
    expect(t.lines.join("\n")).toContain("CLICKHOUSE_CLOUD_ORG_ID is not set");
  });
});

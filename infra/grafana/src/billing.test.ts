import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAlertFiles } from "./alerts";
import {
  BILLING_DATASOURCE_UID,
  buildBillingDataSource,
  ensureInfinityPlugin,
  INFINITY_PLUGIN_ID,
  INFINITY_PLUGIN_VERSION,
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
const ENV = {
  CLICKHOUSE_CLOUD_KEY_ID: KEY_ID,
  CLICKHOUSE_CLOUD_KEY_SECRET: KEY_SECRET,
  CLICKHOUSE_CLOUD_ORG_ID: ORG,
};

describe("buildBillingDataSource", () => {
  it("puts the organisation in the base URL and pins the one endpoint it needs", () => {
    const built = buildBillingDataSource(ENV);
    expect(built.enabled).toBe(true);
    if (!built.enabled) return;
    const base = `https://api.clickhouse.cloud/v1/organizations/${ORG}`;
    expect(built.dataSource).toMatchObject({
      uid: "clickhouse-cloud-api",
      name: "ClickHouse Cloud API",
      type: "yesoreyeram-infinity-datasource",
      url: base,
      basicAuth: true,
      basicAuthUser: KEY_ID,
      jsonData: { auth_method: "basicAuth", allowedHosts: [`${base}/usageCost`] },
      secureJsonData: { basicAuthPassword: KEY_SECRET },
    });
    // the secret is only in secureJsonData
    expect(JSON.stringify({ ...built.dataSource, secureJsonData: undefined })).not.toContain(
      KEY_SECRET,
    );
  });

  it("is skipped, not an error, without the key or the org id, and names what is missing", () => {
    const none = buildBillingDataSource({});
    expect(none.enabled).toBe(false);
    if (!none.enabled) {
      expect(none.reason).toContain("CLICKHOUSE_CLOUD_KEY_ID");
      expect(none.reason).toContain("CLICKHOUSE_CLOUD_ORG_ID");
    }
    const noOrg = buildBillingDataSource({ ...ENV, CLICKHOUSE_CLOUD_ORG_ID: "" });
    expect(noOrg.enabled).toBe(false);
    if (!noOrg.enabled) {
      expect(noOrg.reason).toContain("CLICKHOUSE_CLOUD_ORG_ID");
      expect(noOrg.reason).not.toContain("KEY_ID");
    }
    const noSecret = buildBillingDataSource({ ...ENV, CLICKHOUSE_CLOUD_KEY_SECRET: "" });
    if (!noSecret.enabled) expect(noSecret.reason).toContain("CLICKHOUSE_CLOUD_KEY_SECRET");
    // a reason never contains a value
    for (const r of [none, noOrg, noSecret]) {
      if (!r.enabled) {
        expect(r.reason).not.toContain(KEY_ID);
        expect(r.reason).not.toContain(KEY_SECRET);
      }
    }
  });

  it("refuses an organisation id that is not a UUID (it becomes part of a URL)", () => {
    const bad = buildBillingDataSource({ ...ENV, CLICKHOUSE_CLOUD_ORG_ID: "x/../services" });
    expect(bad.enabled).toBe(false);
    if (!bad.enabled) expect(bad.reason).toContain("not an organisation id");
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

  it("the local provisioning file has the same shape as the one the push builds", () => {
    const yaml = readFileSync(
      fileURLToPath(new URL("../optional-provisioning/clickhouse-cloud-api.yaml", import.meta.url)),
      "utf8",
    );
    expect(yaml).toContain("uid: clickhouse-cloud-api");
    expect(yaml).toContain(
      "url: https://api.clickhouse.cloud/v1/organizations/$CLICKHOUSE_CLOUD_ORG_ID",
    );
    expect(yaml).toContain(
      "- https://api.clickhouse.cloud/v1/organizations/$CLICKHOUSE_CLOUD_ORG_ID/usageCost",
    );
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

describe("pushToGrafana: billing data source and billing alerts", () => {
  const chEnv = {
    CLICKHOUSE_URL: "https://abc.eu-central-1.aws.clickhouse.cloud:8443",
    CLICKHOUSE_GRAFANA_USER: "grafana_ro",
    CLICKHOUSE_GRAFANA_PASSWORD: testPassword(),
  };
  const alertFiles = loadAlertFiles(fileURLToPath(new URL("../alerts", import.meta.url)));
  const billingGroup = "Fleetscope billing";
  const groupKey = `fleetscope/${billingGroup}`;

  function run(overrides: Partial<PushOptions> = {}, env: Record<string, string> = ENV) {
    const grafana = fakeGrafana();
    const lines: string[] = [];
    const options: PushOptions = {
      client: new GrafanaClient("https://stack.grafana.net", TOKEN, grafana.fetchImpl),
      dataSource: buildDataSource(chEnv, false),
      dashboardFiles: [
        {
          file: "d.json",
          path: "d",
          json: dashboardJson({ uid: "fleetscope-capacity", title: "Capacity" }),
          parseError: undefined,
        },
      ],
      billing: buildBillingDataSource(env),
      alertFiles,
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

  it("installs the plugin, creates the data source with the org in its URL, pushes both billing rules, never prints the key", async () => {
    const t = run();
    const result = await t.result();
    expect(result.infinityPlugin).toBe("installed");
    expect(result.billingSource).toBe("created");
    expect(t.grafana.state.sources.get(BILLING_DATASOURCE_UID)).toMatchObject({
      url: `https://api.clickhouse.cloud/v1/organizations/${ORG}`,
      basicAuthUser: KEY_ID,
      secureJsonData: { basicAuthPassword: KEY_SECRET },
    });
    expect(t.grafana.state.ruleGroups.get(groupKey)?.rules).toHaveLength(2);
    const output = t.lines.join("\n");
    for (const secret of [KEY_SECRET, KEY_ID, ORG]) expect(output).not.toContain(secret);
    expect(output).toContain("data source clickhouse-cloud-api  created");
  });

  it("a second push finds the plugin and updates the data source, the rules are unchanged", async () => {
    const first = run();
    await first.result();
    const second = await pushToGrafana({ ...first.options, log: () => undefined });
    expect(second.infinityPlugin).toBe("unchanged");
    expect(second.billingSource).toBe("updated");
    expect(second.alerts.map((a) => a.action)).toEqual(["unchanged", "unchanged"]);
  });

  it("RV-CAP-02: a push without the key leaves an existing billing group and data source as they are", async () => {
    const first = run();
    await first.result();
    const before = JSON.stringify(first.grafana.state.ruleGroups.get(groupKey));
    // same Grafana, a machine without the key
    const second = await pushToGrafana({
      ...first.options,
      billing: buildBillingDataSource({}),
      log: (l) => first.lines.push(l),
    });
    expect(second.billingSource).toBe("skipped");
    expect(second.alerts.find((a) => a.group === billingGroup)).toMatchObject({
      rules: 2,
      action: "unchanged",
    });
    expect(JSON.stringify(first.grafana.state.ruleGroups.get(groupKey))).toBe(before);
    expect(first.grafana.state.sources.has(BILLING_DATASOURCE_UID)).toBe(true);
    const billingPuts = first.grafana.state.calls.filter(
      (c) => c.startsWith("PUT") && c.includes("rule-groups/Fleetscope%20billing"),
    );
    expect(billingPuts).toHaveLength(1); // the first push only
    expect(first.lines.join("\n")).toContain("exists on this Grafana");
  });

  it("RV-CAP-02: no data source anywhere: the billing group is not sent at all, an existing one is not emptied", async () => {
    const t = run({ billing: buildBillingDataSource({}) });
    // an earlier push left a billing group, then somebody deleted the data source
    t.grafana.state.ruleGroups.set(groupKey, {
      title: billingGroup,
      rules: [{ uid: "x" }, { uid: "y" }],
    });
    const result = await t.result();
    expect(result.alerts.find((a) => a.group === billingGroup)).toMatchObject({
      rules: 0,
      action: "unchanged",
    });
    expect(t.grafana.state.ruleGroups.get(groupKey)?.rules).toHaveLength(2);
    expect(
      t.grafana.state.calls.filter(
        (c) => c.startsWith("PUT") && c.includes("rule-groups/Fleetscope%20billing"),
      ),
    ).toEqual([]);
    expect(t.lines.join("\n")).toContain("left as it is");
  });

  it("without the key and without a billing group on Grafana, the push still works and says why", async () => {
    const t = run({ billing: buildBillingDataSource({}) });
    const result = await t.result();
    expect(result.billingSource).toBe("skipped");
    expect(result.infinityPlugin).toBe("not-needed");
    expect(t.grafana.state.sources.has(BILLING_DATASOURCE_UID)).toBe(false);
    expect(t.grafana.state.ruleGroups.has(groupKey)).toBe(false);
    expect(t.grafana.state.ruleGroups.has("fleetscope/Fleetscope capacity")).toBe(true);
    expect(t.lines.join("\n")).toContain("note        billing: ");
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
});

describe("the committed Capacity dashboard and billing alerts need no variable", () => {
  const dir = fileURLToPath(new URL("../dashboards", import.meta.url));
  const capacity = loadDashboardFiles(dir).find((f) => f.json?.uid === "fleetscope-capacity");
  const alerts = loadAlertFiles(fileURLToPath(new URL("../alerts", import.meta.url)));

  it("has no ch_org variable and no billing URL with a variable or an organisation", () => {
    const text = JSON.stringify(capacity?.json);
    expect(capacity).toBeDefined();
    expect(text).not.toContain("ch_org");
    expect(text).not.toContain("/v1/organizations");
  });

  it("the billing alert rules call /usageCost with a literal date range, execErrState Error", () => {
    const rules = alerts
      .flatMap((f) => f.json.rules as JsonObject[])
      .filter((r) =>
        (r.data as JsonObject[]).some((q) => q.datasourceUid === BILLING_DATASOURCE_UID),
      );
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(rule.execErrState).toBe("Error");
      const model = (rule.data as JsonObject[])[0]?.model as JsonObject;
      expect(model.url).toMatch(
        /^\/usageCost\?from_date=\d{4}-\d{2}-\d{2}&to_date=\d{4}-\d{2}-\d{2}$/,
      );
    }
  });

  it("the trial constants agree everywhere (RV-CAP-13): start 2026-10-24, end 2026-11-23, credit 300", () => {
    const billing = JSON.stringify(alerts.find((f) => f.file === "billing.json")?.json);
    const dashboard = JSON.stringify(capacity?.json);
    for (const [name, text] of [
      ["billing.json", billing],
      ["fleetscope-capacity.json", dashboard],
    ] as const) {
      expect(text, `${name} start`).toContain("2026-10-24");
      expect(text, `${name} end`).toContain("2026-11-23");
      expect(text, `${name} credit`).toMatch(/\b300\b/);
      // no other trial-looking date sneaks in
      const dates = new Set(text.match(/2026-1[01]-\d{2}/g));
      expect([...dates].sort(), name).toEqual(["2026-10-24", "2026-11-23"]);
    }
  });
});

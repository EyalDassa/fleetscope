import { readFileSync as readFile } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type AlertFile,
  alertSnippetProblems,
  alertStructureProblems,
  checkAlerts,
  containsAll,
  groupBody,
  loadAlertFiles,
  pushAlertGroups,
} from "./alerts";
import { BILLING_DATASOURCE_UID } from "./billing";
import { fakeGrafana } from "./fake-grafana";
import { infinityQueryProblems } from "./infinity";
import type { JsonObject } from "./json";
import { GrafanaClient } from "./push";
import { readNamedSnippets, snippetNameOf } from "./snippet-copies";
import { testPassword } from "./test-fixtures";

const ALERTS_DIR = fileURLToPath(new URL("../alerts", import.meta.url));
const README = fileURLToPath(new URL("../../../packages/db/README.md", import.meta.url));
const SQL = "SELECT maxOrNull(x) AS value FROM t";

function chQuery(sql = `-- snippet: capacity-alerts-demo\n${SQL}`): JsonObject {
  return {
    refId: "A",
    relativeTimeRange: { from: 600, to: 0 },
    datasourceUid: "fleetscope-clickhouse",
    model: { refId: "A", format: 1, rawSql: sql },
  };
}

function rule(overrides: JsonObject = {}): JsonObject {
  return {
    uid: "fs-demo",
    title: "Demo",
    condition: "C",
    data: [
      chQuery(),
      {
        refId: "B",
        datasourceUid: "__expr__",
        model: { type: "reduce", expression: "A", reducer: "last" },
      },
      {
        refId: "C",
        datasourceUid: "__expr__",
        model: { type: "threshold", expression: "B" },
      },
    ],
    for: "10m",
    noDataState: "OK",
    execErrState: "Error",
    annotations: { summary: "something" },
    labels: { severity: "warning" },
    ...overrides,
  };
}

function file(rules: JsonObject[] = [rule()], extra: JsonObject = {}): AlertFile {
  return { file: "demo.json", json: { title: "Demo group", interval: 60, rules, ...extra } };
}

const messages = (files: AlertFile[]): string =>
  alertStructureProblems(files)
    .map((p) => p.message)
    .join("\n");

describe("the alert files in the repository", () => {
  const files = loadAlertFiles(ALERTS_DIR);

  it("exist and have no structural problem", () => {
    expect(files.map((f) => f.file)).toEqual(["billing.json", "capacity.json"]);
    expect(alertStructureProblems(files)).toEqual([]);
  });

  it("form the groups the lead asked for: capacity (1 min) and billing (15 min), in one folder", () => {
    const byTitle = Object.fromEntries(files.map((f) => [String(f.json.title), f.json]));
    expect(byTitle["Fleetscope capacity"]?.interval).toBe(60);
    expect(byTitle["Fleetscope billing"]?.interval).toBe(900);
  });

  it("use the default notification policy: no contact point or notification settings on any rule", () => {
    for (const { json } of files) {
      for (const r of json.rules as JsonObject[]) {
        expect(r).not.toHaveProperty("notification_settings");
        expect(r).not.toHaveProperty("notificationSettings");
      }
    }
  });

  it("copy the README alert SQL exactly (memory uses the 1-minute block)", () => {
    const snippets = readNamedSnippets(readFileSync(README));
    expect([...snippets.keys()].filter((n) => n.startsWith("capacity-alerts-")).sort()).toEqual([
      "capacity-alerts-cpu-pct",
      "capacity-alerts-limits-changed",
      "capacity-alerts-load-mismatch-pct",
      "capacity-alerts-mem-pct",
      "capacity-alerts-mem-pct-1m",
      "capacity-alerts-minutes-since-write",
    ]);
    const used = files.flatMap((f) => JSON.stringify(f.json).match(/-- snippet: [\w-]+/g) ?? []);
    expect(used).toContain("-- snippet: capacity-alerts-mem-pct-1m");
    expect(alertSnippetProblems(files, snippets)).toEqual([]);
  });

  it("check without ClickHouse is clean (the CLI runs the SQL as grafana_ro)", async () => {
    const report = await checkAlerts({
      dir: ALERTS_DIR,
      readme: readFileSync(README),
      connection: undefined,
    });
    expect(report.problems).toEqual([]);
    expect(report.files).toHaveLength(2);
  });
});

function readFileSync(path: string): string {
  return readFile(path, "utf8");
}

describe("alertStructureProblems", () => {
  it("accepts a sound group", () => {
    expect(alertStructureProblems([file()])).toEqual([]);
  });

  it("wants a uid, a duration for 'for', explicit states, a severity and a summary", () => {
    const text = messages([
      file([
        rule({
          uid: "has space",
          for: "ten minutes",
          noDataState: "Maybe",
          labels: { severity: "huge" },
          annotations: {},
        }),
      ]),
    ]);
    expect(text).toContain('"uid" must be');
    expect(text).toContain('"for" must be a duration');
    expect(text).toContain('"noDataState" must be one of');
    expect(text).toContain("labels.severity");
    expect(text).toContain("annotations.summary");
  });

  it("wants the condition to be one of the refIds, and unique uids", () => {
    expect(messages([file([rule({ condition: "Z" })])])).toContain('"condition" (Z)');
    expect(messages([file([rule(), rule({ title: "Other" })])])).toContain("is also used by");
  });

  it("refuses a data source other than the two Fleetscope ones and expressions", () => {
    const bad = rule({ data: [{ ...chQuery(), datasourceUid: "prometheus" }], condition: "A" });
    expect(messages([file([bad])])).toContain('data source "prometheus"');
  });

  it("wants '-- snippet: <name>' on every ClickHouse query, and applies the SQL rules", () => {
    const plain = rule({ data: [chQuery(SQL)], condition: "A" });
    expect(messages([file([plain])])).toContain("-- snippet:");
    const zero = rule({
      data: [chQuery("-- snippet: x\nSELECT ifNull(a, 0) AS value FROM t")],
      condition: "A",
    });
    expect(messages([file([zero])])).toContain("ifNull");
  });

  it("RV-CAP-01: rejects dashboard variables and macros anywhere in a rule (alerting fills in none)", () => {
    const withVariable = rule({
      data: [
        chQuery("-- snippet: x\nSELECT 1 AS value WHERE ts > $__fromTime"),
        {
          refId: "B",
          datasourceUid: "clickhouse-cloud-api",
          relativeTimeRange: { from: 600, to: 0 },
          model: {
            type: "json",
            source: "url",
            parser: "backend",
            root_selector: "a",
            url: "/usageCost?org=${ch_org}",
          },
        },
      ],
      condition: "A",
    });
    const text = messages([file([withVariable])]);
    expect(text).toContain("no dashboard variables or macros");
    expect(text).toContain("$__fromTime");
  });

  it("wants an interval in whole seconds", () => {
    expect(messages([file([rule()], { interval: "1m" })])).toContain('"interval"');
  });
});

describe("README snippets", () => {
  const readme = [
    "```sql name=capacity-alerts-demo",
    "SELECT maxOrNull(x) AS value",
    "FROM t",
    "```",
    "```sql name=capacity-alerts-unused",
    "SELECT 1 AS value",
    "```",
  ].join("\n");

  it("reads the blocks by name and the snippet comment of a query", () => {
    expect([...readNamedSnippets(readme).keys()]).toEqual([
      "capacity-alerts-demo",
      "capacity-alerts-unused",
    ]);
    expect(snippetNameOf("-- snippet: capacity-alerts-demo\nSELECT 1")).toBe(
      "capacity-alerts-demo",
    );
    expect(snippetNameOf("SELECT 1")).toBeUndefined();
  });

  it("ignores whitespace and comments, but not a changed query", () => {
    const snippets = readNamedSnippets(readme);
    const same = file([
      rule({
        data: [
          chQuery("-- snippet: capacity-alerts-demo\nSELECT   maxOrNull( x )  AS value  FROM t"),
        ],
      }),
    ]);
    expect(alertSnippetProblems([same], snippets)).toEqual([]); // an unused block is fine

    const edited = file([
      rule({
        data: [chQuery("-- snippet: capacity-alerts-demo\nSELECT minOrNull(x) AS value FROM t")],
      }),
    ]);
    const problems = alertSnippetProblems([edited], snippets);
    expect(problems[0]?.message).toContain("is not the README block `capacity-alerts-demo`");
    expect(problems[0]?.detail).toBeDefined();
  });

  it("reports a snippet name the README does not have", () => {
    const unknown = file([
      rule({ data: [chQuery("-- snippet: capacity-alerts-nope\nSELECT 1 AS value")] }),
    ]);
    expect(alertSnippetProblems([unknown], readNamedSnippets(readme))[0]?.message).toContain(
      "does not have",
    );
  });
});

describe("infinityQueryProblems (billing queries are never executed)", () => {
  const good: JsonObject = {
    type: "json",
    source: "url",
    parser: "backend",
    root_selector: "result.costs",
    url: "/usageCost?from_date=2026-10-24&to_date=2026-11-23",
    url_options: { method: "GET" },
  };

  it("accepts the documented shape", () => {
    expect(infinityQueryProblems(good, "p")).toEqual([]);
    expect(infinityQueryProblems({ ...good, parser: "jq-backend" }, "p")).toEqual([]);
  });

  it("refuses the browser-side parser, a missing root, a wrong URL and credentials in the query", () => {
    const text = (m: JsonObject): string =>
      infinityQueryProblems(m, "p")
        .map((x) => x.message)
        .join("\n");
    expect(text({ ...good, parser: "simple" })).toContain("parser");
    expect(text({ ...good, parser: undefined })).toContain("parser");
    expect(text({ ...good, root_selector: "" })).toContain("root_selector");
    expect(text({ ...good, url: "https://api.clickhouse.cloud/v1/organizations" })).toContain(
      "url",
    );
    expect(text({ ...good, url: "/v1/organizations/x/usageCost" })).toContain("url"); // the org is in the base URL
    expect(text({ ...good, url: "/usageCost?from_date=${__from}" })).toContain("variable");
    expect(text({ ...good, url: `${String(good.url)}&apikey=abc` })).toContain("credentials");
    expect(text({ ...good, url: `${String(good.url)}&secret=abc` })).toContain("credentials");
    expect(
      text({
        ...good,
        url_options: { method: "GET", headers: [{ key: "Authorization", value: "x" }] },
      }),
    ).toContain("Authorization");
    expect(text({ ...good, url_options: { method: "POST" } })).toContain("GET");
  });
});

describe("groupBody and containsAll", () => {
  it("adds folder, group and org to every rule and drops rules of a skipped data source", () => {
    const billing = rule({
      uid: "fs-bill",
      title: "Bill",
      data: [{ refId: "A", datasourceUid: BILLING_DATASOURCE_UID, model: {} }],
    });
    const body = groupBody(
      file([rule(), billing]).json,
      "fleetscope",
      new Set([BILLING_DATASOURCE_UID]),
    );
    const rules = body.rules as JsonObject[];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ folderUID: "fleetscope", ruleGroup: "Demo group", orgID: 1 });
    expect(body).toMatchObject({ title: "Demo group", folderUid: "fleetscope", interval: 60 });
  });

  it("containsAll tolerates added fields but not changed values or lengths", () => {
    expect(containsAll({ a: 1, b: { c: 2, d: 3 } }, { a: 1, b: { c: 2 } })).toBe(true);
    expect(containsAll({ a: 1 }, { a: 2 })).toBe(false);
    expect(containsAll({ a: [1, 2] }, { a: [1] })).toBe(false);
    expect(containsAll({}, { a: 1 })).toBe(false);
  });
});

describe("pushAlertGroups against the fake Grafana", () => {
  const token = `glsa_${testPassword()}`;
  const setup = () => {
    const grafana = fakeGrafana();
    const lines: string[] = [];
    return {
      grafana,
      lines,
      client: new GrafanaClient("https://stack.grafana.net", token, grafana.fetchImpl),
      log: (l: string) => lines.push(l),
    };
  };

  it("creates the group, then says unchanged even though Grafana adds fields", async () => {
    const t = setup();
    const first = await pushAlertGroups(t.client, [file()], {
      dryRun: false,
      read: true,
      log: t.log,
    });
    expect(first).toEqual([{ group: "Demo group", rules: 1, action: "created", skipped: [] }]);
    const stored = t.grafana.state.ruleGroups.get("fleetscope/Demo group");
    expect(((stored?.rules ?? []) as JsonObject[])[0]).toMatchObject({
      provenance: "api",
      uid: "fs-demo",
    });
    const second = await pushAlertGroups(t.client, [file()], {
      dryRun: false,
      read: true,
      log: t.log,
    });
    expect(second[0]?.action).toBe("unchanged");
    expect(t.grafana.state.calls.filter((c) => c.startsWith("PUT"))).toHaveLength(1);
  });

  it("never sets the header that would make the rules editable in the UI", async () => {
    const t = setup();
    const seen: Record<string, string>[] = [];
    const original = t.grafana.fetchImpl;
    const spy = ((input: URL | string, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return original(input, init);
    }) as typeof fetch;
    const client = new GrafanaClient("https://stack.grafana.net", token, spy);
    await pushAlertGroups(client, [file()], { dryRun: false, read: true, log: t.log });
    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen)
      expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain(
        "x-disable-provenance",
      );
  });

  it("updates when a rule changed, including the threshold inside a query model", async () => {
    const t = setup();
    await pushAlertGroups(t.client, [file()], { dryRun: false, read: true, log: t.log });
    const changed = file([rule({ for: "20m" })]);
    expect(
      (await pushAlertGroups(t.client, [changed], { dryRun: false, read: true, log: t.log }))[0]
        ?.action,
    ).toBe("updated");
    const fewer = file([rule(), rule({ uid: "fs-two", title: "Two" })]);
    expect(
      (await pushAlertGroups(t.client, [fewer], { dryRun: false, read: true, log: t.log }))[0]
        ?.action,
    ).toBe("updated");
    const back = await pushAlertGroups(t.client, [file()], {
      dryRun: false,
      read: true,
      log: t.log,
    });
    expect(back[0]?.action).toBe("updated"); // the second rule is removed again
    expect(t.grafana.state.ruleGroups.get("fleetscope/Demo group")?.rules).toHaveLength(1);
  });

  it("dry run reads and reports, writes nothing", async () => {
    const t = setup();
    const result = await pushAlertGroups(t.client, [file()], {
      dryRun: true,
      read: true,
      log: t.log,
    });
    expect(result[0]?.action).toBe("created");
    expect(t.lines[0]).toContain("would be created");
    expect(t.grafana.state.calls.some((c) => c.startsWith("PUT"))).toBe(false);
    expect(t.grafana.state.ruleGroups.size).toBe(0);
  });

  it("skips rules of the billing data source when it is not set up, with a note", async () => {
    const t = setup();
    const billing = rule({
      uid: "fs-bill",
      title: "Bill",
      data: [{ refId: "A", datasourceUid: BILLING_DATASOURCE_UID, model: {} }],
    });
    const result = await pushAlertGroups(t.client, [file([rule(), billing])], {
      dryRun: false,
      read: true,
      skipDataSources: new Set([BILLING_DATASOURCE_UID]),
      log: t.log,
    });
    expect(result[0]).toMatchObject({ rules: 1, skipped: ["Bill"] });
    expect(t.lines.join("\n")).toContain('alert rule "Bill" skipped');
  });
});

// Alert rules as code: infra/grafana/alerts/*.json, one rule group per file.
//   - `pnpm grafana:push` uploads them (pushAlertGroups) through Grafana's alert provisioning API
//   - `pnpm grafana:check` validates them (alertProblems) and runs their ClickHouse SQL as grafana_ro
//
// Why the group endpoint: PUT /api/v1/provisioning/folder/<folderUid>/rule-groups/<group> creates or
// replaces a whole group in one call. It is idempotent, and a rule that is removed from the file is removed
// from Grafana. Without the header `X-Disable-Provenance`, Grafana marks every rule "api": the alerting UI
// then shows the rule as read-only (no edit, no delete), so the repository is the only place to change it.
// The rules name no contact point, so they use the notification policy tree (its default policy, which sends
// to the default contact point "grafana-default-email").
// Docs checked 2026-10-25: https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/http-api-provisioning/
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BILLING_DATASOURCE_UID } from "./billing";
import {
  type ClickHouseConnection,
  ClickHouseQueryError,
  type Fetch,
  runQuery,
} from "./clickhouse-http";
import { CLICKHOUSE_DATASOURCE_UID, FOLDER_UID, type Problem } from "./dashboards";
import { sqlRuleProblems } from "./design-rules";
import { PushError } from "./errors";
import { infinityQueryProblems } from "./infinity";
import { asArray, asString, isObject, type JsonObject } from "./json";
import type { Action, GrafanaClient } from "./push";
import { readNamedSnippets, snippetCopyProblems, snippetNameOf } from "./snippet-copies";

export const EXPRESSION_DATASOURCE_UID = "__expr__";
const ALLOWED_DATASOURCES: ReadonlySet<string> = new Set([
  CLICKHOUSE_DATASOURCE_UID,
  BILLING_DATASOURCE_UID,
  EXPRESSION_DATASOURCE_UID,
]);
const SEVERITIES: ReadonlySet<string> = new Set(["info", "warning", "critical"]);
const STATES: ReadonlySet<string> = new Set(["Alerting", "NoData", "OK", "KeepLast", "Error"]);
const DURATION = /^\d+(ms|s|m|h|d)$/;
const RULE_UID = /^[A-Za-z0-9_-]{1,40}$/;

export interface AlertFile {
  file: string;
  json: JsonObject;
}

/** Every `*.json` of the folder, parsed. An empty or missing folder gives no files. */
export function loadAlertFiles(dir: string): AlertFile[] {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  return names.map((file) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      throw new PushError(`alerts/${file} is not valid JSON: ${(error as Error).message}`);
    }
    if (!isObject(parsed))
      throw new PushError(`alerts/${file} must be a JSON object (a rule group)`);
    return { file, json: parsed };
  });
}

export function rulesOf(group: JsonObject): JsonObject[] {
  return asArray(group.rules).filter(isObject);
}

export function dataOf(rule: JsonObject): JsonObject[] {
  return asArray(rule.data).filter(isObject);
}

export function isClickHouseQuery(item: JsonObject): boolean {
  return item.datasourceUid === CLICKHOUSE_DATASOURCE_UID;
}

export function isBillingQuery(item: JsonObject): boolean {
  return item.datasourceUid === BILLING_DATASOURCE_UID;
}

// ---------------------------------------------------------------- structure

/** Problems in the alert files themselves (no ClickHouse, no Grafana). Empty when they are sound. */
export function alertStructureProblems(files: AlertFile[]): Problem[] {
  const problems: Problem[] = [];
  const ruleUids = new Map<string, string>();
  const groupTitles = new Set<string>();
  for (const { file, json } of files) {
    const at = (rule?: string): string => `alerts/${file}${rule ? `, rule "${rule}"` : ""}`;
    const title = asString(json.title);
    if (!title) problems.push({ where: at(), message: 'needs a "title" (the rule group name)' });
    else if (groupTitles.has(title)) {
      problems.push({ where: at(), message: `the group title "${title}" is used by another file` });
    } else groupTitles.add(title);
    const interval = json.interval;
    if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 10) {
      problems.push({
        where: at(),
        message:
          '"interval" is the evaluation interval in whole seconds (at least 10), for example 60',
      });
    }
    const rules = rulesOf(json);
    if (rules.length === 0) problems.push({ where: at(), message: 'has no "rules"' });
    const titles = new Set<string>();
    for (const rule of rules) {
      const name = asString(rule.title) ?? "(no title)";
      const where = at(name);
      if (!asString(rule.title)) problems.push({ where, message: 'needs a "title"' });
      else if (titles.has(name))
        problems.push({ where, message: "the rule title is used twice in this group" });
      titles.add(name);
      const uid = asString(rule.uid);
      if (!uid || !RULE_UID.test(uid)) {
        problems.push({
          where,
          message:
            '"uid" must be 1 to 40 letters, digits, "-" or "_" (it is the stable identity of the rule)',
        });
      } else if (ruleUids.has(uid)) {
        problems.push({ where, message: `uid "${uid}" is also used by ${ruleUids.get(uid)}` });
      } else ruleUids.set(uid, `${file}, "${name}"`);
      const wait = asString(rule.for);
      if (wait === undefined || !DURATION.test(wait)) {
        problems.push({
          where,
          message: '"for" must be a duration such as "10m" ("0s" fires at once)',
        });
      }
      for (const key of ["noDataState", "execErrState"] as const) {
        const state = asString(rule[key]);
        if (!state || !STATES.has(state)) {
          problems.push({
            where,
            message: `"${key}" must be one of ${[...STATES].join(", ")}: decide on purpose what a missing answer means`,
          });
        }
      }
      const labels = isObject(rule.labels) ? rule.labels : {};
      if (!SEVERITIES.has(String(labels.severity))) {
        problems.push({
          where,
          message: 'labels.severity must be "info", "warning" or "critical"',
        });
      }
      const annotations = isObject(rule.annotations) ? rule.annotations : {};
      if (!asString(annotations.summary))
        problems.push({
          where,
          message: "annotations.summary is empty: it is the first line of the notification",
        });

      const data = dataOf(rule);
      const refIds = new Set<string>();
      for (const item of data) {
        const refId = asString(item.refId);
        if (!refId) {
          problems.push({ where, message: "a query has no refId" });
          continue;
        }
        if (refIds.has(refId)) problems.push({ where, message: `refId ${refId} is used twice` });
        refIds.add(refId);
        const uidOfSource = asString(item.datasourceUid);
        if (!uidOfSource || !ALLOWED_DATASOURCES.has(uidOfSource)) {
          problems.push({
            where: `${where}, query ${refId}`,
            message: `data source "${String(uidOfSource)}" is not one of ${[...ALLOWED_DATASOURCES].join(", ")}`,
          });
          continue;
        }
        const model = isObject(item.model) ? item.model : undefined;
        if (!model) {
          problems.push({ where: `${where}, query ${refId}`, message: 'has no "model"' });
          continue;
        }
        if (uidOfSource === EXPRESSION_DATASOURCE_UID) {
          if (!asString(model.type))
            problems.push({
              where: `${where}, query ${refId}`,
              message: 'an expression needs "model.type" (reduce, math, threshold ...)',
            });
          continue;
        }
        if (!isObject(item.relativeTimeRange)) {
          problems.push({
            where: `${where}, query ${refId}`,
            message: 'needs "relativeTimeRange" ({"from": seconds, "to": 0})',
          });
        }
        if (uidOfSource === CLICKHOUSE_DATASOURCE_UID)
          problems.push(...clickHouseQueryProblems(model, `${where}, query ${refId}`));
        else problems.push(...infinityQueryProblems(model, `${where}, query ${refId}`));
      }
      const condition = asString(rule.condition);
      if (!condition || !refIds.has(condition)) {
        problems.push({
          where,
          message: `"condition" (${String(condition)}) must be the refId of one of the rule's queries or expressions`,
        });
      }
    }
  }
  return problems;
}

function clickHouseQueryProblems(model: JsonObject, where: string): Problem[] {
  const sql = asString(model.rawSql);
  if (!sql || sql.trim() === "") return [{ where, message: 'a ClickHouse query needs "rawSql"' }];
  const problems = sqlRuleProblems(sql, where);
  if (snippetNameOf(sql) === undefined) {
    problems.push({
      where,
      message:
        "the SQL must start with the comment `-- snippet: <name>` naming the packages/db/README.md block it is copied from (capacity-alerts-...)",
    });
  }
  return problems;
}

// ---------------------------------------------------------------- the README snippets

const ALERT_BLOCK_PREFIX = "capacity-alerts-";

/**
 * Every ClickHouse alert query must be a copy of a README block (snippet-copies.ts), and every
 * `capacity-alerts-*` block must be used by some rule.
 */
export function alertSnippetProblems(files: AlertFile[], snippets: Map<string, string>): Problem[] {
  const problems: Problem[] = [];
  const used = new Set<string>();
  for (const { file, json } of files) {
    for (const rule of rulesOf(json)) {
      for (const item of dataOf(rule).filter(isClickHouseQuery)) {
        const model = isObject(item.model) ? item.model : {};
        const sql = asString(model.rawSql) ?? "";
        if (snippetNameOf(sql) === undefined) continue; // reported by the structure check
        const where = `alerts/${file}, rule "${String(rule.title)}", query ${String(item.refId)}`;
        const found = snippetCopyProblems(sql, snippets, { where, requireCopy: true });
        problems.push(...found.problems);
        if (found.used) used.add(found.used);
      }
    }
  }
  if (files.length > 0) {
    for (const name of snippets.keys()) {
      if (name.startsWith(ALERT_BLOCK_PREFIX) && !used.has(name)) {
        problems.push({
          where: "alerts/",
          message: `the README block \`${name}\` is not used by any alert rule`,
        });
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------- running the SQL

export interface AlertRun {
  where: string;
  /** "NULL" or the number, for the report. */
  value: string;
}

/**
 * Runs every ClickHouse alert query as the connection's user (grafana_ro). The query must return no
 * more than one row with exactly one column, `value`.
 */
export async function runAlertQueries(
  files: AlertFile[],
  connection: ClickHouseConnection,
  fetchImpl?: Fetch,
): Promise<{ problems: Problem[]; ran: AlertRun[] }> {
  const problems: Problem[] = [];
  const ran: AlertRun[] = [];
  for (const { file, json } of files) {
    for (const rule of rulesOf(json)) {
      for (const item of dataOf(rule).filter(isClickHouseQuery)) {
        const model = isObject(item.model) ? item.model : {};
        const sql = asString(model.rawSql);
        if (!sql) continue;
        const where = `alerts/${file}, rule "${String(rule.title)}", query ${String(item.refId)}`;
        try {
          const result = await runQuery(connection, sql, fetchImpl);
          if (
            result.columns.length !== 1 ||
            result.columns[0] !== "value" ||
            result.rows.length > 1
          ) {
            problems.push({
              where,
              message: `must return at most one row with the single column "value"; it returned ${result.rows.length} row(s) with columns (${result.columns.join(", ")})`,
            });
            continue;
          }
          const value = result.rows[0]?.[0];
          if (value !== null && value !== undefined && Number.isNaN(Number(value))) {
            problems.push({
              where,
              message: `"value" must be a number or NULL, got ${JSON.stringify(value)}`,
            });
            continue;
          }
          ran.push({
            where,
            value: value === null || value === undefined ? "NULL" : String(value),
          });
        } catch (error) {
          const message =
            error instanceof ClickHouseQueryError || error instanceof Error
              ? error.message
              : String(error);
          problems.push({
            where,
            message: `ClickHouse error: ${message}`,
            detail: `SQL sent:\n${sql.trim().slice(0, 1500)}`,
          });
        }
      }
    }
  }
  return { problems, ran };
}

// ---------------------------------------------------------------- push

/** The body for PUT .../rule-groups/<title>: the file, plus what the API wants on every rule. */
export function groupBody(
  group: JsonObject,
  folderUid: string,
  skipDataSources: ReadonlySet<string> = new Set(),
): JsonObject {
  const title = String(group.title);
  const rules = rulesOf(group)
    .filter((rule) => !dataOf(rule).some((q) => skipDataSources.has(String(q.datasourceUid))))
    .map((rule) => ({
      orgID: 1,
      isPaused: false,
      ...rule,
      folderUID: folderUid,
      ruleGroup: title,
    }));
  return { title, folderUid, interval: group.interval, rules };
}

/**
 * True when everything in `wanted` is in `actual` with the same value. Grafana adds fields (ids, update
 * time, provenance, defaults inside a query model), so comparing equality would say "updated" forever.
 */
export function containsAll(actual: unknown, wanted: unknown): boolean {
  if (Array.isArray(wanted)) {
    return (
      Array.isArray(actual) &&
      actual.length === wanted.length &&
      wanted.every((item, i) => containsAll(actual[i], item))
    );
  }
  if (isObject(wanted)) {
    return (
      isObject(actual) &&
      Object.entries(wanted).every(([key, value]) => containsAll(actual[key], value))
    );
  }
  return actual === wanted;
}

export interface AlertGroupResult {
  group: string;
  rules: number;
  action: Action;
  /** Rules left out because their data source does not exist on this Grafana (billing without a key). */
  skipped: string[];
}

export async function pushAlertGroups(
  client: GrafanaClient,
  files: AlertFile[],
  options: {
    dryRun: boolean;
    read: boolean;
    folderUid?: string;
    skipDataSources?: ReadonlySet<string>;
    log: (line: string) => void;
  },
): Promise<AlertGroupResult[]> {
  const would = options.dryRun ? "would be " : "";
  const folderUid = options.folderUid ?? FOLDER_UID;
  const results: AlertGroupResult[] = [];
  for (const { json } of files) {
    const body = groupBody(json, folderUid, options.skipDataSources);
    const title = String(body.title);
    const wantedRules = asArray(body.rules).length;
    const skipped = rulesOf(json)
      .filter((rule) =>
        dataOf(rule).some((q) => options.skipDataSources?.has(String(q.datasourceUid))),
      )
      .map((rule) => String(rule.title));
    const path = `/api/v1/provisioning/folder/${encodeURIComponent(folderUid)}/rule-groups/${encodeURIComponent(title)}`;
    const existing = options.read ? await client.get(path) : undefined;
    let action: Action = "created";
    if (isObject(existing)) {
      const sameRules = asArray(existing.rules).length === wantedRules;
      action = sameRules && containsAll(existing, body) ? "unchanged" : "updated";
    }
    if (action !== "unchanged" && !options.dryRun) await client.send("PUT", path, body);
    results.push({ group: title, rules: wantedRules, action, skipped });
    options.log(
      `alerts      ${title}  ${would}${action}  (${wantedRules} rule(s) in folder ${folderUid}; read-only in the UI)`,
    );
    for (const name of skipped) {
      options.log(
        `note        alert rule "${name}" skipped: its data source (${BILLING_DATASOURCE_UID}) is not set up on this push`,
      );
    }
  }
  return results;
}

// ---------------------------------------------------------------- the check

export interface AlertCheckReport {
  files: string[];
  problems: Problem[];
  ran: AlertRun[];
}

/**
 * `pnpm grafana:check` for the alert rules: structure, the README copies, and (with a connection) a real
 * run of every ClickHouse query as the Grafana read-only user. Infinity queries are checked for shape only.
 */
export async function checkAlerts(options: {
  dir: string;
  readme: string;
  connection: ClickHouseConnection | undefined;
  fetchImpl?: Fetch;
}): Promise<AlertCheckReport> {
  const files = loadAlertFiles(options.dir);
  if (files.length === 0) return { files: [], problems: [], ran: [] };
  const snippets = readNamedSnippets(options.readme);
  const problems: Problem[] = [...alertStructureProblems(files)];
  if (![...snippets.keys()].some((name) => name.startsWith(ALERT_BLOCK_PREFIX))) {
    problems.push({
      where: "packages/db/README.md",
      message: "has no ```sql name=capacity-alerts-... blocks, so the alert SQL cannot be compared",
    });
  } else {
    problems.push(...alertSnippetProblems(files, snippets));
  }
  let ran: AlertRun[] = [];
  if (options.connection) {
    const result = await runAlertQueries(files, options.connection, options.fetchImpl);
    problems.push(...result.problems);
    ran = result.ran;
  }
  return { files: files.map((f) => f.file), problems, ran };
}

// Structural check of a query for the Infinity data source (ClickHouse Cloud billing API), shared by the
// dashboards and the alert rules. Needs no key and no network.
import type { Problem } from "./dashboards";
import { asArray, asString, isObject, type JsonObject } from "./json";

/**
 * Infinity (ClickHouse Cloud billing) queries are never executed by the check: that needs the API key.
 * They are checked for shape instead, so a UI export that would not work in an alert is caught.
 */
export function infinityQueryProblems(model: JsonObject, where: string): Problem[] {
  const problems: Problem[] = [];
  const need = (ok: boolean, message: string): void => {
    if (!ok) problems.push({ where, message });
  };
  need(model.type === "json", 'the query "type" must be "json"');
  need(model.source === "url", 'the query "source" must be "url" (the API is called live)');
  need(
    model.parser === "backend" || model.parser === "jq-backend",
    'the "parser" must be "backend" or "jq-backend": the default "simple" parser runs in the browser, and an alert has none',
  );
  need(
    asString(model.root_selector) !== undefined && asString(model.root_selector) !== "",
    'needs a "root_selector" (for example "result.costs")',
  );
  const url = asString(model.url) ?? "";
  need(
    /^\/v1\/organizations\/[^/]+\/usageCost(\?|$)/.test(url),
    'the "url" must be relative to the data source base URL and call /v1/organizations/<org>/usageCost (the org is the dashboard variable ${ch_org})',
  );
  const options = isObject(model.url_options) ? model.url_options : {};
  need((asString(options.method) ?? "GET") === "GET", "the billing API is read with GET");
  const headers = asArray(options.headers).filter(isObject);
  need(
    !headers.some((h) => /^(authorization|x-api-key)$/i.test(String(h.key))),
    "no Authorization header in a query: the key belongs to the data source (secureJsonData) only",
  );
  need(!/(key|secret|token|password)=/i.test(url), "no credentials in the URL");
  return problems;
}

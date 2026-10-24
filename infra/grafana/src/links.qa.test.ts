import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadDashboardFiles } from "./dashboards";
import { asArray, isObject, type JsonObject } from "./json";

/**
 * QA M2: every link in the dashboard JSON goes where DESIGN.md section 4.1 says. `grafana:check`
 * already proves that /d/<uid> exists; this adds the variables and the time range of each link.
 */

const dir = fileURLToPath(new URL("../dashboards", import.meta.url));
const dashboards = new Map<string, JsonObject>();
for (const file of loadDashboardFiles(dir)) {
  if (file.json) dashboards.set(String(file.json.uid), file.json);
}

interface Found {
  from: string;
  url: string;
}
const found: Found[] = [];
function walk(value: unknown, from: string): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, from);
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === "url" && typeof item === "string" && item !== "") found.push({ from, url: item });
      else walk(item, from);
    }
  }
}
for (const [uid, json] of dashboards) walk(json, uid);

const variablesOf = (uid: string): Set<string> =>
  new Set(
    asArray((dashboards.get(uid)?.templating as JsonObject | undefined)?.list)
      .filter(isObject)
      .map((v) => String(v.name)),
  );

const toDashboard = found.filter((l) => l.url.startsWith("/d/"));
const SESSION_LINK =
  /^\/d\/fleetscope-session\?var-session=\$\{__data\.fields\.session_id(:percentencode)?\}&from=\$\{__data\.fields\.from_ms\}&to=\$\{__data\.fields\.to_ms\}$/;

describe("dashboard links", () => {
  it("there are links to check", () => {
    expect(dashboards.size).toBe(3);
    expect(toDashboard.length).toBeGreaterThanOrEqual(10);
  });

  it("every /d/<uid> link points at a dashboard that exists and passes only variables that dashboard has", () => {
    for (const { from, url } of toDashboard) {
      const [path, query = ""] = url.split("?");
      const target = /^\/d\/([\w-]+)/.exec(path as string)?.[1] as string;
      expect(dashboards.has(target), `${from}: ${url}`).toBe(true);
      const known = variablesOf(target);
      for (const match of query.matchAll(/var-(\w+)=/g)) {
        expect(
          known.has(match[1] as string),
          `${from} -> ${target}: var-${match[1]} does not exist there`,
        ).toBe(true);
      }
    }
  });

  it("a link to Sessions keeps the time range (from the picker or a fixed one)", () => {
    const links = toDashboard.filter((l) => l.url.startsWith("/d/fleetscope-sessions"));
    expect(links.length).toBeGreaterThanOrEqual(8);
    for (const { from, url } of links) {
      expect(/\$\{__url_time_range\}|from=now-/.test(url), `${from}: ${url}`).toBe(true);
    }
  });

  it("a link to Session detail carries the session id and its own time range, nothing else", () => {
    const links = toDashboard.filter((l) => l.url.startsWith("/d/fleetscope-session?"));
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const { from, url } of links) expect(url, from).toMatch(SESSION_LINK);
  });

  // QA-M2-17: SAFE_LABEL_PATTERN allows `+`, and in a query string `+` is a space. The Session link
  // puts the raw id into `var-session=`, so the page opens for "plain plus" and says "Session not found"
  // (seen in Grafana 13.2.4 with the ids `plain+plus` and `fleet/run:1@host+a-b_c.d`). Writing the id
  // as ${__data.fields.session_id:percentencode} works (verified in the same Grafana: `%2B`).
  it.fails("the Session link writes the id percent-encoded, because an id may contain a plus", () => {
    const links = toDashboard.filter((l) => l.url.startsWith("/d/fleetscope-session?"));
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const { from, url } of links) {
      expect(url, from).toContain("var-session=${__data.fields.session_id:percentencode}");
    }
  });

  it("the Perfetto link uses the api_url constant and opens a new tab, also in the Timeline text", () => {
    const perfetto = found.filter((l) => l.url.includes("/perfetto"));
    expect(perfetto.map((l) => l.url)).toEqual([
      "${api_url}/v1/sessions/${session:percentencode}/perfetto",
    ]);
    const text = JSON.stringify(dashboards.get("fleetscope-session"));
    expect(text).toContain(
      'href=\\"${api_url}/v1/sessions/${session:percentencode}/perfetto\\" target=\\"_blank\\"',
    );
    expect(variablesOf("fleetscope-session").has("api_url")).toBe(true);
  });

  it("every dashboard links to the others by tag and keeps the time range and the variables", () => {
    for (const [uid, json] of dashboards) {
      const links = asArray(json.links).filter(isObject);
      expect(links, uid).toHaveLength(1);
      expect(links[0]).toMatchObject({
        type: "dashboards",
        tags: ["fleetscope"],
        keepTime: true,
        includeVars: true,
      });
    }
  });
});

// A small in-memory Grafana for the push and pull tests: folders (with permissions), data sources,
// dashboards (with the meta that Grafana reports: who saved it, when, in which folder) and the
// organisation preferences. Not a test itself.
import type { Fetch } from "./clickhouse-http";
import { canonicalJson, type JsonObject } from "./json";

export interface FakeState {
  folders: Map<string, JsonObject>;
  sources: Map<string, JsonObject>;
  dashboards: Map<string, JsonObject>;
  dashboardFolders: Map<string, unknown>;
  prefs: JsonObject;
  /** "METHOD /path" of every request, in order. */
  calls: string[];
  authHeaders: Set<string>;
  allowPreferences: boolean;
  healthy: boolean;
  /** Permission rows per folder uid, in the shape of GET /api/access-control/folders/:uid. */
  permissions: Map<string, JsonObject[]>;
  /** What GET /api/dashboards/uid/:uid reports as meta (updatedBy, updated, folderUid ...). */
  meta: Map<string, JsonObject>;
  /** The account behind the token (GET /api/user). */
  user: JsonObject;
  /** Who the version history says saved each dashboard last (GET .../versions, createdBy). */
  authors: Map<string, string>;
}

/**
 * Somebody else saves a dashboard in the UI: meta.updatedBy and the version history both say so.
 * (A test that only sets `state.meta` leaves the history with the last push, as a stale fake.)
 */
export function editAs(
  state: FakeState,
  uid: string,
  author: string,
  extraMeta: JsonObject = {},
): void {
  state.authors.set(uid, author);
  state.meta.set(uid, {
    folderUid: "fleetscope",
    updated: "2026-10-24T18:30:00Z",
    ...extraMeta,
    updatedBy: author,
  });
}

export function fakeGrafana(): { fetchImpl: Fetch; state: FakeState } {
  const state: FakeState = {
    folders: new Map(),
    sources: new Map(),
    dashboards: new Map(),
    dashboardFolders: new Map(),
    prefs: { theme: "" },
    calls: [],
    authHeaders: new Set(),
    allowPreferences: true,
    healthy: true,
    permissions: new Map(),
    meta: new Map(),
    authors: new Map(),
    // As Grafana reports a service account token (GET /api/user)
    user: { uid: "service-account:2", login: "sa-1-fleetscope-push", name: "fleetscope-push" },
  };
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname;
    state.calls.push(`${method} ${path}`);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (auth) state.authHeaders.add(auth);
    const body = init?.body ? (JSON.parse(String(init.body)) as JsonObject) : undefined;
    const notFound = json(404, { message: "not found" });

    // The first capture group of `pattern`, when the path matches it.
    const at = (pattern: RegExp): string | undefined => pattern.exec(path)?.[1];

    const folderUid = at(/^\/api\/folders\/([^/]+)$/);
    if (folderUid) {
      const folder = state.folders.get(folderUid);
      if (method === "GET") return folder ? json(200, folder) : notFound;
      if (method === "PUT" && folder) {
        state.folders.set(folderUid, { ...folder, title: body?.title });
        return json(200, state.folders.get(folderUid));
      }
    }
    if (path === "/api/folders" && method === "POST" && body) {
      state.folders.set(String(body.uid), { uid: body.uid, title: body.title });
      // What Grafana gives a new folder: Editor may edit, Viewer may view, Admin is built in.
      state.permissions.set(String(body.uid), [
        { builtInRole: "Admin", permission: "Admin", isManaged: false, isInherited: false },
        { builtInRole: "Editor", permission: "Edit", isManaged: true, isInherited: false },
        { builtInRole: "Viewer", permission: "View", isManaged: true, isInherited: false },
      ]);
      return json(200, state.folders.get(String(body.uid)));
    }
    if (path === "/api/user") return json(200, state.user);
    const accessUid = at(/^\/api\/access-control\/folders\/([^/]+)$/);
    if (accessUid && method === "GET") {
      const rows = state.permissions.get(accessUid);
      return rows ? json(200, rows) : notFound;
    }
    const roleMatch = /^\/api\/access-control\/folders\/([^/]+)\/builtInRoles\/([^/]+)$/.exec(path);
    if (roleMatch && method === "POST" && body) {
      const rows = state.permissions.get(roleMatch[1] as string);
      if (!rows) return notFound;
      const role = roleMatch[2];
      const row = rows.find((r) => r.builtInRole === role && r.isManaged === true);
      if (row) row.permission = body.permission;
      else
        rows.push({
          builtInRole: role,
          permission: body.permission,
          isManaged: true,
          isInherited: false,
        });
      return json(200, { message: "Permission updated" });
    }
    if (at(/^\/api\/datasources\/uid\/([^/]+)\/health$/)) {
      return state.healthy
        ? json(200, { status: "OK", message: "Data source is working" })
        : json(400, { status: "ERROR", message: "connection refused" });
    }
    const sourceUid = at(/^\/api\/datasources\/uid\/([^/]+)$/);
    if (sourceUid) {
      const source = state.sources.get(sourceUid);
      if (method === "GET")
        return source ? json(200, { ...source, secureJsonData: undefined }) : notFound;
      if (method === "PUT" && body) {
        state.sources.set(sourceUid, body);
        return json(200, { message: "Datasource updated" });
      }
    }
    if (path === "/api/datasources" && method === "POST" && body) {
      state.sources.set(String(body.uid), body);
      return json(200, { message: "Datasource added" });
    }
    const versionsUid = at(/^\/api\/dashboards\/uid\/([^/]+)\/versions$/);
    if (versionsUid) {
      if (!state.dashboards.has(versionsUid)) return notFound;
      const meta = state.meta.get(versionsUid) ?? {};
      return json(200, {
        versions: [
          {
            version: 2,
            createdBy: state.authors.get(versionsUid) ?? meta.updatedBy,
            created: meta.updated,
          },
        ],
      });
    }
    const dashboardUid = at(/^\/api\/dashboards\/uid\/([^/]+)$/);
    if (dashboardUid) {
      const dashboard = state.dashboards.get(dashboardUid);
      return dashboard
        ? json(200, {
            dashboard: { ...dashboard, id: 5, version: 3 },
            meta: state.meta.get(dashboardUid) ?? {},
          })
        : notFound;
    }
    if (path === "/api/dashboards/db" && method === "POST" && body) {
      const dashboard = body.dashboard as JsonObject;
      const stored = state.dashboards.get(String(dashboard.uid));
      // Real Grafana makes no new version (and records no new author) for an identical save.
      if (stored && canonicalJson(stored) === canonicalJson(dashboard)) {
        return json(200, { status: "success", uid: dashboard.uid, version: 1 });
      }
      const created = stored === undefined;
      state.dashboards.set(String(dashboard.uid), dashboard);
      state.dashboardFolders.set(String(dashboard.uid), body.folderUid);
      const isServiceAccount = String(state.user.uid).startsWith("service-account:");
      const author = String(isServiceAccount ? state.user.name : state.user.login);
      state.authors.set(String(dashboard.uid), author);
      state.meta.set(String(dashboard.uid), {
        // Measured on Grafana 13.2.4: meta.updatedBy is the NAME of a service account, but a dashboard
        // that the service account only created (version 1) reports "Anonymous" (the history is right).
        updatedBy: created && isServiceAccount ? "Anonymous" : author,
        updated: "2026-10-24T20:00:00Z",
        folderUid: body.folderUid,
        folderTitle: String(state.folders.get(String(body.folderUid))?.title ?? ""),
      });

      return json(200, { status: "success", uid: dashboard.uid });
    }
    if (path === "/api/search") {
      const wanted = url.searchParams.get("folderUIDs");
      return json(
        200,
        [...state.dashboards.keys()]
          .filter((uid) => {
            if (!wanted) return true;
            const folder = state.meta.get(uid)?.folderUid ?? state.dashboardFolders.get(uid);
            return folder === wanted;
          })
          .map((uid) => ({ uid })),
      );
    }
    if (path === "/api/org/preferences") {
      if (method === "GET") return json(200, state.prefs);
      if (method === "PATCH") {
        if (!state.allowPreferences)
          return json(403, { message: "Permissions needed: orgs.preferences:write" });
        state.prefs = { ...state.prefs, ...body };
        return json(200, { message: "Preferences updated" });
      }
    }
    return json(500, { message: `fake Grafana has no route for ${method} ${path}` });
  }) as unknown as Fetch;

  return { fetchImpl, state };
}

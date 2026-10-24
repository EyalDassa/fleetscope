// Who may do what in the two Grafana folders that `grafana:push` looks after:
//   "Fleetscope" (uid fleetscope)       the official, repository-managed dashboards: everybody can
//                                       view and copy them, only Admins can edit them
//   "Team dashboards" (uid fleetscope-team)  the team's own dashboards: Editors edit, Viewers view;
//                                       push never reads, writes or deletes anything inside it
//
// API used (Grafana 13.2.4, also what the Grafana UI itself calls for the folder "Permissions" dialog):
//   GET  /api/access-control/folders/:uid                       the permission rows of the folder
//   POST /api/access-control/folders/:uid/builtInRoles/:role    body {"permission": "View" | "Edit" | "Admin"}
// The POST changes one built-in role and leaves every other row (users, teams) alone, unlike the older
// POST /api/folders/:uid/permissions, which replaces the whole list.
import { asArray, asString, isObject } from "./json";
import type { GrafanaClient } from "./push";

export const TEAM_FOLDER_UID = "fleetscope-team";
export const TEAM_FOLDER_TITLE = "Team dashboards";

export type RoleName = "Viewer" | "Editor" | "Admin";
export type PermissionName = "View" | "Edit" | "Admin";

/** Official folder: look but do not touch (Editors can still open, copy panels and "Save as" elsewhere). */
export const OFFICIAL_FOLDER_ACCESS: Record<RoleName, PermissionName> = {
  Viewer: "View",
  Editor: "View",
  Admin: "Admin",
};

/** Team folder: Editors build here. */
export const TEAM_FOLDER_ACCESS: Record<RoleName, PermissionName> = {
  Viewer: "View",
  Editor: "Edit",
  Admin: "Admin",
};

export interface AccessResult {
  /** "unchanged" when every role already had the wanted permission. */
  action: "updated" | "unchanged";
  /** One entry per role that was (or would be) changed, e.g. "Editor: Edit -> View". */
  changes: string[];
  /** Explicit grants to single users or teams. They are kept, but they may defeat the lock. */
  extraGrants: string[];
}

/**
 * Makes the built-in roles of a folder have `wanted`. `read` is false in a dry run without
 * credentials (nothing is read: every role is reported as a change).
 */
export async function ensureFolderAccess(
  client: GrafanaClient,
  folderUid: string,
  wanted: Record<RoleName, PermissionName>,
  options: { read: boolean; dryRun: boolean; ignoreLogins?: ReadonlySet<string> },
): Promise<AccessResult> {
  const rows = options.read
    ? asArray(await client.get(`/api/access-control/folders/${folderUid}`)).filter(isObject)
    : [];
  const changes: string[] = [];
  for (const role of Object.keys(wanted) as RoleName[]) {
    const want = wanted[role];
    const own = rows.filter(
      (row) => asString(row.builtInRole) === role && row.isInherited !== true,
    );
    // Admin is built in and cannot be lowered, so any Admin/Admin row is enough.
    const satisfied =
      role === "Admin"
        ? own.some((row) => asString(row.permission) === "Admin")
        : own.some((row) => row.isManaged === true && asString(row.permission) === want);
    if (satisfied) continue;
    const current = own.find((row) => row.isManaged === true);
    changes.push(`${role}: ${asString(current?.permission) ?? "(none)"} -> ${want}`);
    if (!options.dryRun) {
      await client.send("POST", `/api/access-control/folders/${folderUid}/builtInRoles/${role}`, {
        permission: want,
      });
    }
  }
  const extraGrants = rows
    .filter((row) => row.isInherited !== true)
    .flatMap((row) => {
      const who = asString(row.userLogin) || asString(row.team);
      // Grafana gives the creator of a folder (here: the push's own account) an Admin grant.
      if (who && options.ignoreLogins?.has(who)) return [];
      return who ? [`${who}: ${asString(row.permission) ?? "?"}`] : [];
    });
  return { action: changes.length > 0 ? "updated" : "unchanged", changes, extraGrants };
}

/** Formats a role table, e.g. "Viewer View, Editor View, Admin Admin". */
export function describeAccess(wanted: Record<RoleName, PermissionName>): string {
  return (Object.keys(wanted) as RoleName[]).map((role) => `${role} ${wanted[role]}`).join(", ");
}

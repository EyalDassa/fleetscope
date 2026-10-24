// The drift guard of `grafana:push`: a dashboard that someone changed in Grafana's UI is not
// overwritten by accident. Grafana records who saved a dashboard last (meta.updatedBy) and when
// (meta.updated); `grafana:push` compares that with the account behind its own token (GET /api/user).
//
// What updatedBy holds (measured on Grafana 13.2.4 and on Grafana Cloud): for a person, the LOGIN; for
// a service account, its NAME ("fleetscope-push"), not its login ("sa-1-fleetscope-push"). So a person
// is compared by login only, and a service account by login or name.
import { asString, isObject, type JsonObject } from "./json";

export interface Identity {
  /** Values of `meta.updatedBy` that mean "the push's own account". */
  names: ReadonlySet<string>;
  label: string;
}

/** Who the token is. A failed lookup gives an identity that matches nobody (so nothing is exempt). */
export function identityFrom(user: unknown): Identity {
  const names = new Set<string>();
  let label = "(unknown)";
  if (isObject(user)) {
    const login = asString(user.login);
    if (login) {
      names.add(login);
      label = login;
    }
    // A service account shows up in updatedBy with its name. A person's name or e-mail never counts:
    // somebody whose login equals the service account's name must not be exempt.
    const serviceAccount =
      asString(user.uid)?.startsWith("service-account:") || login?.startsWith("sa-");
    const name = asString(user.name);
    if (serviceAccount && name) names.add(name);
  }
  return { names, label };
}

export interface DriftVerdict {
  refuse: boolean;
  /** "alice" */
  by: string | undefined;
  /** "2026-10-24T19:23:58Z" */
  at: string | undefined;
}

/**
 * Should `push` refuse to overwrite a dashboard that differs from the repository? Yes, when it was
 * last saved by somebody other than the push's own account. Not refused:
 *  - saved by the push's own account (a normal update from the repository);
 *  - saved by Grafana's file provisioning (local development: "Anonymous" plus a provisioned id);
 *  - no author recorded (nothing to protect that we could name).
 */
export function driftVerdict(meta: unknown, me: Identity): DriftVerdict {
  const m: JsonObject = isObject(meta) ? meta : {};
  const by = asString(m.updatedBy);
  const at = asString(m.updated);
  if (!by) return { refuse: false, by, at };
  if (me.names.has(by)) return { refuse: false, by, at };
  const provisioned = Boolean(asString(m.provisionedExternalId)) || m.provisioned === true;
  if (by === "Anonymous" && provisioned) return { refuse: false, by, at };
  return { refuse: true, by, at };
}

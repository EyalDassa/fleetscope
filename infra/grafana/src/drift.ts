// The drift guard of `grafana:push`: a dashboard that someone changed in Grafana's UI is not
// overwritten by accident. Grafana records who saved a dashboard last (meta.updatedBy, the login) and
// when (meta.updated); `grafana:push` compares that with the login of its own token (GET /api/user).
import { asString, isObject, type JsonObject } from "./json";

export interface Identity {
  /** Everything that names the push's own account: login, name, e-mail. */
  names: ReadonlySet<string>;
  label: string;
}

/** Who the token is. A failed lookup gives an identity that matches nobody (so nothing is exempt). */
export function identityFrom(user: unknown): Identity {
  const names = new Set<string>();
  let label = "(unknown)";
  if (isObject(user)) {
    for (const key of ["login", "name", "email"]) {
      const value = asString(user[key]);
      if (value) names.add(value);
    }
    label = asString(user.login) ?? asString(user.name) ?? label;
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

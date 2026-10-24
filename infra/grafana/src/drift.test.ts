import { describe, expect, it } from "vitest";
import { driftVerdict, identityFrom } from "./drift";

// What Grafana Cloud returned for the Fleetscope push token (measured 2026-10-24): GET /api/user
// names the service account by login "sa-1-..." and name "fleetscope-push", but meta.updatedBy on a
// dashboard that token saved holds the NAME.
const CLOUD_TOKEN_USER = {
  uid: "service-account:20",
  login: "sa-1-fleetscope-push",
  name: "fleetscope-push",
};

describe("identityFrom and driftVerdict", () => {
  it("knows a service account by its name as well as its login (Grafana Cloud values)", () => {
    const me = identityFrom(CLOUD_TOKEN_USER);
    expect(driftVerdict({ updatedBy: "fleetscope-push" }, me).refuse).toBe(false);
    expect(driftVerdict({ updatedBy: "sa-1-fleetscope-push" }, me).refuse).toBe(false);
    expect(driftVerdict({ updatedBy: "alice" }, me).refuse).toBe(true);
    expect(me.label).toBe("sa-1-fleetscope-push");
  });

  it("recognises a service account by its login prefix when the uid is missing", () => {
    const me = identityFrom({ login: "sa-1-ci", name: "ci" });
    expect(driftVerdict({ updatedBy: "ci" }, me).refuse).toBe(false);
  });

  it("compares a person by login only: their name or e-mail does not make others exempt", () => {
    const me = identityFrom({
      uid: "abc123",
      login: "carol",
      name: "Carol Admin",
      email: "carol@example.test",
    });
    expect(driftVerdict({ updatedBy: "carol" }, me).refuse).toBe(false);
    expect(driftVerdict({ updatedBy: "Carol Admin" }, me).refuse).toBe(true);
    expect(driftVerdict({ updatedBy: "carol@example.test" }, me).refuse).toBe(true);
  });

  it("does not let a person named like the service account through", () => {
    // a human whose LOGIN is "fleetscope-push" is indistinguishable in updatedBy from the service
    // account (Grafana records the name), which is why the push should use a dedicated account
    const person = identityFrom({ uid: "x1", login: "dave", name: "fleetscope-push" });
    expect(driftVerdict({ updatedBy: "fleetscope-push" }, person).refuse).toBe(true);
  });

  it("refuses everything that names an author when the token's identity is unknown", () => {
    const me = identityFrom(undefined);
    expect(driftVerdict({ updatedBy: "fleetscope-push" }, me).refuse).toBe(true);
    expect(driftVerdict({}, me).refuse).toBe(false); // no author recorded
  });

  it("exempts only Grafana's own file provisioning among the anonymous saves", () => {
    const me = identityFrom(CLOUD_TOKEN_USER);
    expect(
      driftVerdict({ updatedBy: "Anonymous", provisionedExternalId: "x.json" }, me).refuse,
    ).toBe(false);
    expect(driftVerdict({ updatedBy: "Anonymous" }, me).refuse).toBe(true);
  });
});

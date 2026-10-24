// The local development defaults of grafana-tools, in ONE place.
//
// These MIRROR infra/docker-compose.yml and .env.example (the same values, written down three
// times because compose, the apps and this tool cannot import each other). They are public in this
// repository on purpose, so they are only ever tried against this machine (connection.ts refuses to
// guess them for another host) and never against Grafana Cloud. dev-defaults.test.ts reads
// .env.example and fails if the two drift apart.
//
// Not for tests: a test that needs a password makes a random one with testPassword()
// (test-fixtures.ts), so no password-shaped literal sits in the test files.

/** The read-only ClickHouse user that Grafana connects as (`pnpm db:grafana-user` creates it). */
export const LOCAL_GRAFANA_USER = "grafana_ro";
export const LOCAL_GRAFANA_PASSWORD = "grafana_ro_dev_password";

/** The login of the local Grafana container, used by `pnpm grafana:reload`. */
export const LOCAL_GRAFANA_ADMIN_USER = "admin";
export const LOCAL_GRAFANA_ADMIN_PASSWORD = "fleetscope_dev_admin";

/** Local Grafana listens on this port of 127.0.0.1 (3001, because 3000 is often taken). */
export const LOCAL_GRAFANA_PORT = "3001";

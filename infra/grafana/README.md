# Grafana (the Fleetscope UI)

The dashboards are Grafana, not a web app we build (ADR 0003, `design/DESIGN.md`). Locally Grafana
runs in docker-compose. In production it is Grafana Cloud (free tier). Both read ClickHouse directly
through the official ClickHouse data source, with a **read-only** ClickHouse user.

```
infra/grafana/
  provisioning/datasources/clickhouse.yaml   the data source (uid fleetscope-clickhouse)
  provisioning/dashboards/fleetscope.yaml    loads dashboards/ into the folder "Fleetscope" (uid fleetscope)
  dashboards/                                the dashboard JSON (fleetscope-overview, -sessions, -session)
  src/                                       `pnpm grafana:push` and `pnpm grafana:check` (TypeScript)
```

## Run it locally

```bash
pnpm infra:up           # ClickHouse + Grafana
pnpm db:migrate         # the tables
pnpm db:grafana-user    # ONCE: creates the read-only ClickHouse user Grafana connects as
pnpm db:seed            # optional: a few simulated sessions
```

Open <http://127.0.0.1:3001> (port `GRAFANA_PORT`). Anyone can look around as a Viewer. To edit,
log in as `admin` with `GRAFANA_ADMIN_PASSWORD` (default `fleetscope_dev_admin`).

`pnpm infra:up` needs no `.env`: every variable has a development default. `pnpm db:grafana-user`
does read `CLICKHOUSE_GRAFANA_USER` and `CLICKHOUSE_GRAFANA_PASSWORD`, so copy them from
`.env.example` into your `.env` first. The values must match what Grafana gets, which are the same
two variables (compose falls back to `grafana_ro` / `grafana_ro_dev_password`).

Check the wiring (data source health needs the user to exist):

```bash
curl http://127.0.0.1:3001/api/health
curl -u admin:fleetscope_dev_admin http://127.0.0.1:3001/api/datasources/uid/fleetscope-clickhouse/health
```

**First start.** Grafana downloads the ClickHouse plugin from grafana.com before it starts, so it
needs internet once (the plugin then stays in the `grafana_data` volume). The first start takes about
a minute. `GF_DATABASE_WAL=true` matters here: without it Grafana's roughly 800 schema migrations
took 7 minutes on a slow Docker disk, and `pnpm infra:up` gave up waiting.

**Reset Grafana** (forget UI edits, users, tokens): `docker compose --project-directory . -f infra/docker-compose.yml rm -sf grafana`
then `docker volume rm fleetscope_grafana_data`.

### Edit a dashboard

1. Change it in the UI (log in as admin). `allowUiUpdates` is on, so Grafana lets you save.
2. Dashboard settings > JSON Model > copy, and replace the file in `dashboards/` (the classic JSON
   model, not the v2 schema). Set `"id": null`.
3. `pnpm grafana:check`. Fix what it reports.
4. A UI save lives only in Grafana's database. The file is the source of truth: when the file
   changes, Grafana overwrites the UI copy (it re-reads the folder every 10 seconds).

Dashboards must not use "Export for sharing externally" (it turns the data source into a
`${DS_...}` input, which provisioning cannot fill). Use the plain JSON model.

## Versions (checked 2026-10-24)

| What | Version | Where it is pinned | Source |
|---|---|---|---|
| Grafana | `grafana/grafana:13.2.4` | `infra/docker-compose.yml` | GitHub releases of grafana/grafana (13.2.4, 2026-10-13, the latest stable); the image exists in the Docker registry |
| ClickHouse plugin | `grafana-clickhouse-datasource@4.23.2` | `GF_PLUGINS_PREINSTALL_SYNC` in the compose file | GitHub releases of grafana/clickhouse-datasource (4.23.2, 2026-10-22); plugin page: needs Grafana 11.6 or newer |

The image name is `grafana/grafana`, not `grafana/grafana-oss`: the `-oss` repository stopped at
13.0.2 (June 2026). Grafana's Docker docs list `grafana/grafana` as "Grafana Open Source".
Dependabot (docker-compose ecosystem, `/infra`) proposes new Grafana tags. It does **not** see the
plugin version: bump `GF_PLUGINS_PREINSTALL_SYNC` by hand, and run `pnpm grafana:check`.

## The read-only ClickHouse user

Grafana connects as `CLICKHOUSE_GRAFANA_USER`, created by `pnpm db:grafana-user` (`packages/db`).
It can only `SELECT` from the Fleetscope database. Grafana never gets the admin user. Dashboard SQL
therefore cannot write, and cannot use a `SETTINGS` clause beyond what that user may change.
(A user with plain `readonly = 1` cannot be used by the plugin at all: it sets `max_execution_time`
when it connects. The script handles this with `CHANGEABLE_IN_READONLY`.)

## `pnpm grafana:check`: dashboards are code, so they are tested

Runs in CI (job "Integration tests (ClickHouse)", after `db:migrate`, `db:grafana-user` and `db:seed`).
For every `dashboards/*.json` it:

1. checks the JSON parses, has a `uid` and `title`, and that UIDs and titles are unique;
2. checks every panel, query variable and annotation uses data source UID `fleetscope-clickhouse`
   (or Grafana's built-in `-- Grafana --`, and text panels);
3. checks links like `/d/<uid>` point at a dashboard in the folder;
4. applies the dashboard rules of `design/DESIGN.md` section 9: only palette colours, `noValue` on
   every stat and table, `spanNulls: false` plus the three engine overrides on every time series,
   no `ifNull(x, 0)` / `coalesce(x, 0)` in SQL;
5. **executes every SQL query** against ClickHouse, after expanding it the way Grafana does.

On failure it prints the dashboard, the panel title, the ClickHouse error and the SQL that was sent,
and (in GitHub Actions) an annotation on the dashboard file. With an empty `dashboards/` folder it passes.

How the SQL is expanded (`src/interpolate.ts`, `src/macros.ts`), in the plugin's own order:

1. `$__conditionalAll(condition, $var)`: the condition, or `1=1` when `$var` is All.
2. Template variables: `$var`, `${var}`, `[[var]]`, `${var:csv|raw|pipe|singlequote|doublequote|sqlstring|text}`
   and Grafana's `$__from`, `$__to`, `$__interval`, `$__interval_ms`, `$__range`, `$__range_s`,
   `$__range_ms`, `$__dashboard`. Multi-value and All become `'a','b'`, like the plugin does.
3. The ClickHouse macros `$__timeFilter`, `$__timeFilter_ms`, `$__dateFilter`, `$__dateTimeFilter`
   (`$__dt`), `$__fromTime`, `$__toTime`, `$__fromTime_ms`, `$__toTime_ms`, `$__timeFrom`,
   `$__timeTo`, `$__timeInterval`, `$__timeInterval_ms`, `$__timeGroup`, `$__interval_s`,
   `$__interval`, `$__interval_ms`, `$__fromGrafanaInterval`. Macros inside comments are ignored,
   unknown `$__names` are left alone, as in the plugin.

Not supported, reported as an error: `$__table`, `$__column`, `$__columns`, `$__rateColumns`,
`$__perSecondColumns`, `$__increaseColumns`, `$__lttb`, `$__adHocFilters` (write plain SQL), and
variable formats other than the ones listed. A leftover `$name` that is neither a variable nor a
macro is an error too, because ClickHouse would receive it as it is.

Values used: the dashboard's own time range (default `now-6h`), a panel interval worked out from the
range and the panel's `maxDataPoints` / min interval, and for each variable the dashboard's default
(All when `includeAll`, else the current value, else the first option). Query variables run their
own SQL to get their options. Every query runs a second time with each variable set to **one** value
(so the "filter" branch of `$__conditionalAll` is executed too); identical SQL runs once.

The expansion was compared with the real plugin (Grafana 13.2.4 + plugin 4.23.2, the
`executedQueryString` of `/api/ds/query`) for 18 macro calls, and all were identical.

```bash
pnpm grafana:check                          # as the read-only user (CLICKHOUSE_GRAFANA_USER)
pnpm grafana:check --admin                  # as CLICKHOUSE_USER, e.g. before the read-only user exists
pnpm grafana:check --static-only            # no ClickHouse: structure and design rules only
pnpm grafana:check --verbose                # list every query with its row count
pnpm grafana:check --allow-dangling-links   # link targets that are not written yet become warnings
```

## `pnpm grafana:push`: Grafana Cloud

Makes a Grafana match the repository: the folder `fleetscope`, the data source
`fleetscope-clickhouse`, every `dashboards/*.json` (into that folder, `overwrite: true`), and the
organisation default theme `dark` (the dashboards use dark-only colours). It can run again and again:
it prints `created`, `updated` or `unchanged` for each part and leaves unchanged dashboards alone.
It does not delete anything; a dashboard in the Grafana folder that is not in the repo is reported.

```bash
pnpm grafana:push --dry-run     # reads Grafana, prints the plan, changes nothing
pnpm grafana:push               # does it, then checks the data source health
```

| Variable | Used for |
|---|---|
| `GRAFANA_URL`, `GRAFANA_TOKEN` | the Grafana (HTTPS, or localhost) and a service account token with the **Admin** role |
| `CLICKHOUSE_URL` or `GRAFANA_CLICKHOUSE_URL` | where Grafana reaches ClickHouse. `https://...:8443` sets `secure: true`. `GRAFANA_CLICKHOUSE_URL` wins when your machine and Grafana see ClickHouse at different addresses |
| `CLICKHOUSE_GRAFANA_USER`, `CLICKHOUSE_GRAFANA_PASSWORD` | the read-only user, stored as the data source's secure password. There is no fallback to the admin user |
| `CLICKHOUSE_DATABASE` | the data source's default database (`fleetscope`) |
| `FLEETSCOPE_API_URL` | written into the session dashboard's `api_url` variable, which builds the "Open timeline in Perfetto" link. The viewer's **browser** opens that link, not Grafana, so `http://localhost:4000` is right while the API runs on the laptop you open Grafana Cloud on |

Safety rules, each tested: the token never goes over plain HTTP (except to localhost); a push to a
remote Grafana is **refused** when the ClickHouse URL is `localhost`, because Grafana's server calls
ClickHouse and cannot reach your machine; a localhost `FLEETSCOPE_API_URL` only gets a **warning**
(the Perfetto links then work only on the machine running the API); the token and password are
never printed; everything is validated before the first write; the dashboard files must pass the
structure check. If the token may not change the org preferences, the push continues and prints the
manual step (Administration > Default preferences > Interface theme = Dark).

### One-time setup for Grafana Cloud (Eyal)

1. Create a Grafana Cloud free account and a stack. Note its URL, `https://<stack>.grafana.net`.
2. In the stack: Administration > Users and access > Service accounts > Add service account, role
   **Admin**, then add a token. Copy it once.
3. ClickHouse must accept connections from Grafana Cloud. ClickHouse Cloud: your service > Settings >
   Security > IP access list > Add IPs. Either allow access from anywhere (fine for a demo with
   demo data and a read-only user), or add Grafana Cloud's outbound addresses: the
   `egress-from-grafana` entries from `https://allowlists.grafana.net/v1/` (they change, so
   fetch them again from time to time; Grafana's page: "List of Grafana Cloud IP addresses to add
   to your allowlist"). Run `pnpm db:grafana-user` against that ClickHouse too (set `CLICKHOUSE_URL`,
   the admin user and the Grafana user variables).
4. Put `GRAFANA_URL`, `GRAFANA_TOKEN`, `GRAFANA_CLICKHOUSE_URL` and `CLICKHOUSE_GRAFANA_*` in your
   `.env` (or CI secrets). Leave `FLEETSCOPE_API_URL=http://localhost:4000` for the demo where the API
   runs on your laptop (the push warns, which is fine); set the API's public URL if others need the
   Perfetto links. Run `pnpm grafana:push --dry-run`, then `pnpm grafana:push`.

## Tests

`pnpm test` runs this package's unit tests (no Docker, no network; ClickHouse and Grafana are faked).
They cover the macro expansion, variable handling, the dashboard rules and the whole push flow
against an in-memory Grafana. The real ClickHouse and the real Grafana are exercised by
`pnpm grafana:check` in CI and by hand, as described above.

# Grafana (the Fleetscope UI)

The dashboards are Grafana, not a web app we build (ADR 0003, `design/DESIGN.md`). Locally Grafana
runs in docker-compose. In production it is Grafana Cloud (free tier). Both read ClickHouse directly
through the official ClickHouse data source, with a **read-only** ClickHouse user.

```
infra/grafana/
  provisioning/datasources/clickhouse.yaml   the data source (uid fleetscope-clickhouse)
  provisioning/dashboards/fleetscope.yaml    loads dashboards/ into the folder "Fleetscope" (uid fleetscope)
  optional-provisioning/                     the billing data source (clickhouse-cloud-api), local Grafana, only with an API key
  dashboards/                                the dashboard JSON (fleetscope-overview, -sessions, -session, -browsers, -capacity)
  alerts/                                    alert rules as code (capacity.json, billing.json), see "Alerts"
  src/                                       `pnpm grafana:push`, `grafana:pull`, `grafana:check` and `grafana:reload` (TypeScript)
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
curl -u "admin:$GRAFANA_ADMIN_PASSWORD" http://127.0.0.1:3001/api/datasources/uid/fleetscope-clickhouse/health
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
   changes, Grafana overwrites the UI copy.

**After editing a file, Grafana picks it up within 15 seconds** (it polls the folder). To load it
now, run `pnpm grafana:reload`: it calls the admin API (`POST /api/admin/provisioning/dashboards/reload`,
Basic auth with `admin` and `GRAFANA_ADMIN_PASSWORD`), then compares every file with what Grafana
serves and prints `in sync` or `DIFFERENT`. If it still says `DIFFERENT`, `pnpm grafana:reload --restart`
restarts the container. Do this before a manual check or a screenshot, so you are not looking at
old dashboards.

*Why polling:* `updateIntervalSeconds` of 10 or less makes Grafana watch the folder with fsnotify
instead of polling (`pkg/services/provisioning/dashboards/file_reader.go`). A file edited on the
Windows or macOS side of a Docker Desktop bind mount sends no fsnotify event into the container, so
at 10 the local Grafana kept serving the dashboards it had loaded at start (QA-M2-01). At 15 it
polls: an added, edited and deleted file were each picked up within one poll, on the real mount.
`GRAFANA_ADMIN_PASSWORD` only takes effect when Grafana starts on an empty `grafana_data` volume; after
that, change the password in Grafana, or reset the volume (below).

Dashboards must not use "Export for sharing externally" (it turns the data source into a
`${DS_...}` input, which provisioning cannot fill). Use the plain JSON model.

## Versions (checked 2026-10-24)

| What | Version | Where it is pinned | Source |
|---|---|---|---|
| Grafana | `grafana/grafana:13.2.4` | `infra/docker-compose.yml` | GitHub releases of grafana/grafana (13.2.4, 2026-10-13, the latest stable); the image exists in the Docker registry |
| ClickHouse plugin | `grafana-clickhouse-datasource@4.23.2` | `GF_PLUGINS_PREINSTALL_SYNC` in the compose file | GitHub releases of grafana/clickhouse-datasource (4.23.2, 2026-10-22); plugin page: needs Grafana 11.6 or newer |
| Infinity plugin | `yesoreyeram-infinity-datasource@4.1.3` | `GF_PLUGINS_PREINSTALL_SYNC` in the compose file, `INFINITY_PLUGIN_VERSION` in `src/billing.ts` (a test keeps them equal) | grafana.com plugin API (4.1.3, 2026-10-21, signed by Grafana Labs, needs Grafana >= 12.2.5; its `plugin.json` has `"alerting": true`). Run against Grafana 13.2.4 |

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
   (or Grafana's built-in `-- Grafana --`, and text panels), and that panel ids are unique;
3. **panels that read another panel's query** (Grafana's `-- Dashboard --` data source, used by the
   Overview's single-number panels and two Session panels, so one summary query feeds many panels):
   the `panelId` must exist in the same dashboard, must not be the panel itself, and must be a panel
   that holds ClickHouse SQL of its own (not another reader). That source query is run like any other.
   Then every field the reading panel names (`options.reduceOptions.fields`, `byName` / `byRegexp`
   overrides, `${__data.fields.x}` in data links) must exist in the columns the source query returned,
   counting `displayName` overrides (a panel can select `✓ Healthy` for the column `healthy`); a list
   such as `/^(a|b|c)$/` must find every name. A panel with transformations is skipped with a warning,
   because transformations can rename or drop fields;
4. **every copy of `session-facts` is the README's.** The block ```` ```sql name=session-facts ```` in
   `packages/db/README.md` defines a session's display status, cause and cost. Panels paste it as
   `WITH facts AS ( ... )`; each pasted copy must equal the README block (comments, indentation and
   the spacing around `( ) ,` are ignored). The one allowed difference: on the Session dashboard
   `picked` selects one session, so its `WHERE` may be a `session_id = ...${session...}...` condition,
   and, because that dashboard has no engine or source variable, the two lines `AND engine IN (...)` /
   `AND source IN (...)` may be left out of `issue_facts` and `action_facts` (and from nowhere else).
   A mismatch names the panel and shows the first difference, README side and panel side. The check
   stops if the README block cannot be found, so the rule cannot be skipped by accident;
5. checks links like `/d/<uid>` point at a dashboard in the folder;
6. applies the dashboard rules of `design/DESIGN.md` section 9: only palette colours, `noValue` on
   every stat and table, `spanNulls: false` plus the three engine overrides on every time series,
   no `ifNull(x, 0)` / `coalesce(x, 0)` in SQL, and no `SETTINGS` clause the read-only user may not use;
7. **text box variables go into SQL only as `decodeURLComponent('${name:percentencode}')`.** A text
   box (`session`, `cause`) takes any text, and `singlequote` does not escape a backslash, so a value
   ending in `\'` can leave the SQL string (QA-M2-05). `${name:singlequote}`, `'${name}'`, a bare
   `$name` and `[[name]]` fail, with the dashboard, the panel and the offending snippet. The variable
   argument of `$__conditionalAll(condition, $cause)` is not a use. The multi-select query variables
   (`engine`, `source`, `agent`, `scenario`) may keep `singlequote`: their values come from the
   database and ingest restricts those fields to `SAFE_LABEL_PATTERN` (no quote or backslash);
8. **executes every SQL query** against ClickHouse, after expanding it the way Grafana does;
9. **every query copied whole from the README is the README's** (`src/snippet-copies.ts`). A comment line
   `-- snippet: <name>` in a panel's SQL names the block ```` ```sql name=<name> ```` of `packages/db/README.md`
   it copies, and the SQL must equal that block (comments and spacing ignored, like `session-facts`). On the
   **Capacity dashboard every panel query must be a copy**: it names a block, or equals one exactly; anything
   else is an edited copy (or new SQL that belongs in the README first). On the other dashboards the marker is
   optional. `session-facts` keeps its own rule (4 above);
10. **billing panels** (data source `clickhouse-cloud-api`, Infinity) are **not executed**, because that needs the
    API key and CI has none. They are checked for shape: `type` json, `source` url, `parser` `backend` or
    `jq-backend` (the default `simple` parser runs in the browser, which an alert has not), a `root_selector`, a URL
    that is exactly `/usageCost?...` (the organisation is in the data source), GET, and no `Authorization` header or credential in the query;
11. the **alert rules** (`alerts/*.json`, see "Alerts"): structure, SQL equal to the README, and **every ClickHouse
    alert query is executed** as the read-only user (each must return at most one row with the single column `value`), and no
    `${...}` or `$__...` appears in a rule, because alerting fills in no variable.

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
pnpm grafana:check                          # as the read-only user (CLICKHOUSE_GRAFANA_USER; for a local ClickHouse
                                            #   the dev defaults of docker-compose, never the admin)
pnpm grafana:check --admin                  # on purpose as CLICKHOUSE_USER, e.g. before the read-only user exists
pnpm grafana:check --static-only            # no ClickHouse: structure and design rules only
pnpm grafana:check --verbose                # list every query with its row count
pnpm grafana:check --allow-dangling-links   # link targets that are not written yet become warnings
```

## For the team: official dashboards, and where to build your own

Two folders in Grafana Cloud:

| Folder | What is in it | Who can do what |
|---|---|---|
| **Fleetscope** (uid `fleetscope`) | the 4 official dashboards: Overview, Sessions, Session, Browsers. They come from this repository | everybody can **view** and copy from them; only **Admins** can edit. Editors and Viewers cannot save here |
| **Team dashboards** (uid `fleetscope-team`) | your own dashboards | **Editors** create and edit, Viewers view. `grafana:push` never reads, changes or deletes anything in it |

**Build your own.** Open Team dashboards > New > New dashboard, pick the data source
**Fleetscope ClickHouse**, and write SQL against the live data (it connects as a read-only user, so
you cannot damage the data). Explore (compass icon) is the quickest place to try a query first, and
**Grafana Assistant** can write the SQL and the panels for you; check what it produced, the data is
real. The tables and the rules for honest queries (NULL is not 0, `source` filter) are in
`packages/db/README.md`.

**Copy from an official dashboard.**
- One panel: panel menu > More... > **Copy**, then in your dashboard Add > Paste panel.
- A whole dashboard: open it, Save dashboard > **Save as copy**, and choose the folder **Team dashboards**.
- Or just copy the SQL from a panel (Edit > Query) into yours.

**Make a team dashboard official.** Only when the team agrees that it belongs in the product:
1. `pnpm grafana:pull <uid> --as fleetscope-<name>` writes it as repository JSON into
   `infra/grafana/dashboards/fleetscope-<name>.json` (ids, versions and the Perfetto URL are cleaned
   up; the new uid keeps the team copy and the official copy apart).
2. `pnpm grafana:check` must pass (design rules, query rules, links). Fix what it names.
3. Commit it in a pull request. After the merge, `pnpm grafana:push` puts it in the official folder.

**Where your dashboards live.** Team dashboards exist **only in Grafana Cloud**; they are not in git.
Grafana keeps a version history for each one (dashboard settings > Versions), so you can compare and
restore an older save. They only disappear if somebody deletes the dashboard or folder, or if the
Grafana Cloud stack itself is deleted. For a dashboard you cannot lose, run
`pnpm grafana:pull <uid> --out my-backup.json` now and then.

## `pnpm grafana:push`: Grafana Cloud

Makes a Grafana match the repository: the folder `fleetscope` (locked, see below), the folder
`fleetscope-team` (created, then left alone), the data source `fleetscope-clickhouse`, the billing data source
`clickhouse-cloud-api` (with the Infinity plugin, only with an API key, see "Billing"), every
`dashboards/*.json` (into the official folder, `overwrite: true`), the alert rule groups of `alerts/` (see "Alerts"), and the
organisation default theme `dark` (the dashboards use dark-only colours). It can run again and again:
it prints `created`, `updated` or `unchanged` for each part and leaves unchanged dashboards alone.
The data source always says `updated`: Grafana never returns the password, so it cannot be compared
and is sent again (the output says so). It does not delete anything; a dashboard in the official
folder that is not in the repo is reported (the team folder is never listed).

```bash
pnpm grafana:push --dry-run     # reads Grafana, prints the plan, changes nothing
pnpm grafana:push               # does it, then checks the data source health
pnpm grafana:push --force       # also overwrites every dashboard that somebody else saved in Grafana (see below)
pnpm grafana:push --force fleetscope-overview   # ... or only that one (repeat --force <uid> for more)
pnpm grafana:pull <uid>         # keeps such a dashboard, or turns a team dashboard into a repository file
```

**The folder lock.** Every push sets the permissions of the official folder: role Viewer = View, role
Editor = View, role Admin = Admin. It uses
`POST /api/access-control/folders/fleetscope/builtInRoles/<role>` with `{"permission": "View"}` (and
reads `GET /api/access-control/folders/fleetscope` first, so a run that finds nothing to change says
`unchanged`). That is the endpoint Grafana's own "Permissions" dialog uses; it changes one role and keeps
grants to single users or teams, which the push lists in a note (anyone with Edit there can still change
the official dashboards). Checked against Grafana 13.2.4 (`200 "Permission updated"`, rows read
back, an Editor refused with "not allowed to update resource" when saving into the folder). The team
folder gets Viewer = View, Editor = Edit, Admin = Admin the same way.

**The drift guard.** Before overwriting an official dashboard that differs from the repository, the push
checks who saved it last (`meta.updatedBy`) against the account behind the token (`GET /api/user`). If it
was somebody else, that dashboard is **refused**: the push prints its uid, who and when, finishes the
other dashboards, and exits with code 1. `pnpm grafana:pull <uid>` keeps the Grafana version in the
repository file (then review, `grafana:check`, pull request); `--force <uid>` discards just that one
(`--force` alone discards every refused one, including edits you have not looked at). Not refused: what the
push's own account saved, and (local development) what Grafana's file provisioning saved. A repository uid
that exists in the team folder is always refused, even with `--force`.

**Adopted.** When the repository already equals the dashboard in Grafana but somebody else saved it last
(typically after their change was pulled and merged), the push saves it again under its own account and prints
`adopted` (two saves: Grafana makes no new version for a save that changes nothing, so the second one
carries the real content). Without that, the next ordinary repository change would still look like their edit and be
refused. Dry run: `would be adopted`.

**Who is "the push".** `meta.updatedBy` holds the *login* of a person but the *name* of a service account
(Grafana 13.2.4 and Grafana Cloud: login `sa-1-fleetscope-push`, saved dashboards show `fleetscope-push`). The push
therefore accepts the token's login, and for a service account its name too; a person is compared by login
only. `meta` can say `Anonymous` for a dashboard the service account only created (version 1), so when `meta`
names somebody else the push confirms with the newest entry of the version history. Use a dedicated service
account for the token, and do not give a person a login equal to its name.
Evidence in `ACCESS-VERIFICATION.md`.

**The push owns the role rows of both folders.** Every run sets Viewer/Editor/Admin on `fleetscope` and on
`fleetscope-team` back to the values above, so narrowing them by hand (say, hiding drafts from Viewers) is
undone at the next push. Use grants to single users or teams for exceptions: the push keeps those and lists them.

**`pnpm grafana:pull <uid> [--out <file>] [--as <new-uid>]`** reads a dashboard from any folder and
writes repository JSON, by default to `infra/grafana/dashboards/<uid>.json`: no `id`/`version`/`meta`,
the `api_url` variable as committed (the existing file's, else `http://localhost:4000`), every ClickHouse
data source reference set to `fleetscope-clickhouse`, two-space JSON, and the keys in the order of the
existing file so `git diff` shows the real change. It changes nothing in Grafana. A token with the
Viewer role is enough.

| Variable | Used for |
|---|---|
| `GRAFANA_URL`, `GRAFANA_TOKEN` | the Grafana (HTTPS, or localhost) and a service account token with the **Admin** role |
| `CLICKHOUSE_URL` or `GRAFANA_CLICKHOUSE_URL` | where Grafana reaches ClickHouse. `https://...:8443` sets `secure: true`. `GRAFANA_CLICKHOUSE_URL` wins when your machine and Grafana see ClickHouse at different addresses |
| `CLICKHOUSE_GRAFANA_USER`, `CLICKHOUSE_GRAFANA_PASSWORD` | the read-only user, stored as the data source's secure password. There is no fallback to the admin user |
| `CLICKHOUSE_DATABASE` | the data source's default database (`fleetscope`) |
| `CLICKHOUSE_CLOUD_KEY_ID`, `CLICKHOUSE_CLOUD_KEY_SECRET`, `CLICKHOUSE_CLOUD_ORG_ID` | optional, all three or none: a ClickHouse Cloud API key (role Organization API Reader) and the organisation id, for the billing data source (its base URL holds the org). Without them the data source is skipped with a note; what the target Grafana already has is left as it is |
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
   Security > IP access list > Add IPs. **Add Grafana Cloud's outbound addresses and your own IP**:
   the `egress-from-grafana` entries from `https://allowlists.grafana.net/v1/` (they change, so
   fetch them again from time to time; Grafana's page: "List of Grafana Cloud IP addresses to add
   to your allowlist"), and the address you run `db:migrate`, `db:grafana-user`, the API and the
   fleet runner from. "Allow access from anywhere" is for a short demo only: it puts the whole
   ClickHouse Cloud service, including its admin user, on the internet. If you use it, the admin
   password must be the long generated one, kept only in `.env`, and the list should be narrowed
   again afterwards. Run `pnpm db:grafana-user` against that ClickHouse too (set `CLICKHOUSE_URL`,
   the admin user and the Grafana user variables).
4. Put `GRAFANA_URL`, `GRAFANA_TOKEN`, `GRAFANA_CLICKHOUSE_URL` and `CLICKHOUSE_GRAFANA_*` in your
   `.env` (or CI secrets). Leave `FLEETSCOPE_API_URL=http://localhost:4000` for the demo where the API
   runs on your laptop (the push warns, which is fine); set the API's public URL if others need the
   Perfetto links. If the variable is unset, the push also warns and the dashboards keep their
   committed `http://localhost:4000`. Run `pnpm grafana:push --dry-run`, then `pnpm grafana:push`.

## Capacity: system logs, billing and alerts

The Capacity dashboard (`fleetscope-capacity`) compares the load the fleet sends with what ClickHouse wrote,
shows ClickHouse's memory and CPU against its limits and autoscaling, and the ClickHouse Cloud bill.

### System tables, locally and in CI

`system.part_log` and `system.asynchronous_metric_log` are what the dashboard reads. ClickHouse Cloud has both.
The official image has them on by default (checked on 26.8.34.13); `infra/clickhouse/config.d/system-logs.xml`
(mounted read-only by compose) writes them down anyway and keeps **14 days** (the default keeps them forever; the
metric log alone was 56 million rows after a day). Changing the retention renames the old table to `part_log_0`
once; drop it (`DROP TABLE system.part_log_0`). The compose ClickHouse also has `mem_limit: 4g` and `cpus: 2`, so
`CGroupMemoryTotal` and `CGroupMaxCPU` exist and the utilisation percentages are real numbers instead of NULL.
CI's service container cannot mount the file and runs the image defaults;
`.github/scripts/check-clickhouse-system-logs.sh` (step in the integration job) fails the build if either table is
unreadable or `part_log` has no `NewPart` row.

### Billing: ClickHouse Cloud usage in Grafana

Data source `clickhouse-cloud-api` ("ClickHouse Cloud API"): the **Infinity** plugin with basic auth (Key ID : Key
secret) and the **organisation in its base URL**, `https://api.clickhouse.cloud/v1/organizations/<org>` (from
`CLICKHOUSE_CLOUD_ORG_ID`). Panels and alert rules therefore use the relative URL `/usageCost?from_date=...&to_date=...`
and need **no variable**: an alert rule has no dashboard variables, and Grafana would send `${ch_org}` as it is.
`allowedHosts` is pinned to the one endpoint, `https://api.clickhouse.cloud/v1/organizations/<org>/usageCost`. Infinity
matches `allowedHosts` **by prefix** (measured on 4.1.3 with the real API: a bare `https://api.clickhouse.cloud` let a request to
`https://api.clickhouse.cloud.evil.example/...` leave Grafana, while the pinned entry and `https://api.clickhouse.cloud/`
refused it, and the pinned entry refused `/services` too), so the pin is what limits where the key can be sent.

`grafana:push` builds the data source from the environment (`src/billing.ts`) and, if the plugin is missing, installs the
pinned version with `POST /api/plugins/yesoreyeram-infinity-datasource/install` (an installed plugin of another version is
left alone and noted; if Grafana refuses the install, the data source is skipped and the note says to install it by hand:
Administration > Plugins and data > Plugins > Infinity). **Without all three variables (key id, key secret, org id) the
data source is skipped with a note, not an error.** What the target Grafana already has is left as it is: the alert rules
that read the data source are pushed when the data source exists there, whatever this machine's environment says, and a
billing group whose rules would all be skipped is not sent at all (a `PUT` with no rules would empty it). The key is stored
in `secureJsonData`, never printed, never in a dashboard. Local Grafana preinstalls the plugin and provisions the same
data source only if all three variables are set in the compose environment (the Grafana container copies
`optional-provisioning/clickhouse-cloud-api.yaml` next to the other data sources at start).

**The key and its role.** ClickHouse Cloud > Organization > API keys. `GET /v1/organizations/{id}/usageCost` needs the
permission `control-plane:organization:view`. **The key must have the role "Organization API Reader"** (read-only on the
organisation; ClickHouse Cloud has no "Developer" role), never Admin: everybody who may query the data source can make
Grafana send requests under the pinned URL signed with this key, so the role is the last barrier. Rotate it from the same
page. Verify the role of a key (never echo the values):

```bash
set -a; . <(tr -d '\r' < .env.cloud); set +a
auth="$CLICKHOUSE_CLOUD_KEY_ID:$CLICKHOUSE_CLOUD_KEY_SECRET"; org="https://api.clickhouse.cloud/v1/organizations/$CLICKHOUSE_CLOUD_ORG_ID"
curl -s -o /dev/null -w "read  %{http_code}\n" -u "$auth" "$org/usageCost?from_date=2026-10-24&to_date=2026-10-25"   # must be 200
curl -s -o /dev/null -w "write %{http_code}\n" -u "$auth" -X PATCH -H "Content-Type: application/json" -d '{}' "$org"  # must be 403
```

A read of 200 and a write probe of 403 is the proof (an Admin key answers the `PATCH` with something other than 403). Eyal checked
it on 2026-10-25 for the key in use (role Organization API Reader): 200 and 403.

**The API** (OpenAPI spec `https://clickhouse.com/docs/_specs/cloud-openapi.json`, checked 2026-10-25, and called with a
real key): `GET /v1/organizations/{organizationId}/usageCost?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD`, UTC days,
`to_date` inclusive and at most 30 days after `from_date` (31 days). Answer: `{"status":200,"requestId":...,"result":{"grandTotalCHC":17.326,"costs":[...]}}`
with one record per **day and entity** (a service, a ClickPipe): `date`, `entityType`, `entityId`, `entityName`,
`totalCHC`, `metrics{computeCHC,storageCHC,...}`, `locked` (false = the day is not final). Several entities per day, so sum
`totalCHC` per `date`. **Today has no row yet** (billing lags), a future `to_date` is accepted, and the figures are
ClickHouse credits (CHC); the alerts count 1 CHC as 1 USD, like the $300 trial credit.

**An Infinity query for a panel** (verified on Grafana 13.2.4 with plugin 4.1.3 against the real API; the URL is relative
to the data source's base URL, which already holds the organisation):

```json
{
  "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "clickhouse-cloud-api" },
  "refId": "A", "type": "json", "source": "url", "format": "table", "parser": "backend",
  "url": "/usageCost?from_date=2026-10-24&to_date=2026-11-23",
  "url_options": { "method": "GET" },
  "root_selector": "result.costs",
  "columns": [
    { "selector": "date", "text": "date", "type": "timestamp" },
    { "selector": "totalCHC", "text": "chc", "type": "number" }
  ],
  "summarizeExpression": "sum(chc)", "summarizeBy": "date", "summarizeAlias": "chc"
}
```

That returns one row per day (`date` as time, `chc` as number). `parser` must be `backend` (or `jq-backend`): the
default `simple` parser runs in the browser and cannot be used in an alert. For the trial credit, `grandTotalCHC`
is `result.grandTotalCHC` (use `jq-backend` or a JSONata `root_selector`, as the Capacity panels do).

### Alerts

`alerts/*.json`: one **rule group per file**, in the official folder `fleetscope`:

| File | Group | Evaluated | Rules |
|---|---|---|---|
| `capacity.json` | Fleetscope capacity | every minute | memory (average of the last whole minute, busiest replica) above 75% for 10 min (warning) and above 85% for 5 min (critical); CPU above 80% (10-minute average) for 10 min; limits changed in the last 30 min (info: autoscaling, fires and resolves); written vs sent differ by more than 5% over the last hour (for 15 min); no part written for 15 min |
| `billing.json` | Fleetscope billing | every 15 min | trial credit left below $50 (300 minus usage since 2026-10-24); projected run-out before the trial ends on 2026-11-23, at the average of the last 3 full days |

(Billing is its own group because a group has one interval and the billing API should not be called every minute.)

**The SQL is the README's.** Each ClickHouse query starts with `-- snippet: capacity-alerts-...` and is a copy of
that block of `packages/db/README.md`; `grafana:check` fails on any difference. The memory rules use
`capacity-alerts-mem-pct-1m` (the last whole minute), so `for: 10m` means ten checks in a row; the 10-minute peak block
`capacity-alerts-mem-pct` feeds the dashboard stat only. The queries return one nullable `value` (NULL = no data), so each
rule sets `noDataState` on purpose: `OK` for the percentages (no limit means nothing to alert on), `Alerting` for "no rows
written" (nothing for 24 h is an outage). The chain in every rule is query A, Reduce (last, drop NULLs) B, Threshold C.
**No variables in a rule:** `grafana:check` rejects `${...}` and `$__...` anywhere in an alert, because alerting
fills in none. The billing rules use `execErrState: Error`, so a revoked key or a changed API sends one email instead of
going quiet.

The run-out rule is the Capacity panel's projection: per-date sums of `totalCHC`; a day is full when its date is before
today (UTC); the burn is the average of the last three full days; credit left is 300 minus `grandTotalCHC` (today has no
row yet); the value is `floor(left / burn) - days from the start of today to 2026-11-23`, so below 0 means the credit
ends before the trial does (-1: already used up; no full day or no spend: no answer, which is `OK`). It uses the
`jq-backend` parser because jq has `now`.

**Change an alert:** edit the JSON, `pnpm grafana:check`, pull request, then `pnpm grafana:push` (`--dry-run` first).
Push uses `PUT /api/v1/provisioning/folder/fleetscope/rule-groups/<group>`: idempotent (it compares and says
`created`, `updated` or `unchanged`), and a rule removed from the file is removed from Grafana. **Rules are read-only
in the UI**: the push does not send `X-Disable-Provenance`, so Grafana marks them `provenance: api` and refuses UI edits
(checked: `failed to update rule group: request affects resources created via provisioning API`). The repository is the only place to change them.

**Pause an alert on purpose** (for example "no rows written" while `tools/live-traffic.ps1` is stopped): use a **silence**
(Alerting > Silences, match `alertname`), which expires by itself. Do not edit the rule. Otherwise it repeats every repeat
interval while nothing is written.

**Where the emails go.** The rules name no contact point, so they use the notification policy tree: its default policy and
the default contact point (`grafana-default-email`). Change who gets them in Grafana (Alerting > Contact points). The
push does not touch contact points or policies. Check the address once after the first push; it is a manual step because
it is account data, not code.

**Cost note.** The capacity group queries ClickHouse every minute, around the clock. A ClickHouse Cloud service with
idling switched on is kept awake by that, which costs credit when the fleet is stopped. Check the service's idle setting
(Settings > Scaling); with idling on, lengthen the group `interval` in `capacity.json` or pause the group with a silence.

**Verified** (2026-10-25) on a throwaway Grafana 13.2.4 with the ClickHouse and Infinity plugins, the local ClickHouse and the
real billing API:
- `pnpm grafana:push` created the data source and both groups; a second push said `unchanged`; a push without the key left
  the billing group (2 rules) and the data source as they were;
- the credit rule evaluated through Grafana against the real API (HTTP 200, credit left 281.975 of 300, below-$50 false);
- the run-out rule had no answer yet (no full day: today is the first billing day), and its arithmetic was checked on inline
  data with the same query: 5 full days at 15.5 a day gives -16 (14 days of credit, 30 left), 5 a day gives +25, no spend
  and only today's row give no answer, an used-up credit gives -1;
- UI edits of the provisioned rules are refused.

The scratch Grafana held the real key in its database, encrypted with Grafana's default `secret_key`, so the container
and its volume were removed afterwards (`docker rm -f <name>`; `docker volume rm` for a named volume). Do the same after any
test with a real key.

## Secret scanners and the development passwords

`grafana_ro_dev_password`, `fleetscope_dev_admin` and the example passwords in `src/*.test.ts` are
development placeholders that are public on purpose: they only work against the local docker-compose.
gitleaks (CI) reports one of them, accepted in `.gitleaksignore` with the reason. GitGuardian, an
external GitHub app, flags them as "Generic Password" on pull requests (QA-M2-14).

A `.gitguardian.yaml` in the repository does **not** help. That file is the configuration of the
`ggshield` command line tool, and GitGuardian's documentation says ggshield's ignores are not shared
with its dashboard or its GitHub integration (docs.gitguardian.com, "ggshield secret ignore"); nothing
in the GitHub integration's pages mentions reading it. The exclusion lives in the GitGuardian
workspace instead: Settings > Secrets detection > Filepath exclusions, linked to this repository only,
for `.env.example` and `infra/grafana/*`. gitleaks keeps scanning those paths.

## Tests

`pnpm test` runs this package's unit tests (no Docker, no network; ClickHouse and Grafana are faked).
They cover the macro expansion, variable handling, the dashboard rules and the whole push flow
against an in-memory Grafana (folder lock, team folder, drift guard, pull, the Infinity plugin and billing data source, a keyless push that must not empty the billing group, alert group create/update/unchanged). The real ClickHouse and the real Grafana are exercised by
`pnpm grafana:check` in CI and by hand, as described above.

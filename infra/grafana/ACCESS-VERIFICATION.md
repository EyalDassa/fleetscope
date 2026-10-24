# Access model, verified against a real Grafana

What this shows: the folder lock, the team folder, the drift guard (with `adopted` and `--force <uid>`)
and `grafana:pull` work against a real **Grafana OSS 13.2.4** (RV-RT-02). The unit tests use an in-memory
fake (`src/fake-grafana.ts`); this run is what that fake is modelled on.

Setup: a throwaway container, never the provisioned instance on :3001 (its data source is `editable: false`,
so a push cannot run there):

```bash
docker run -d --name fs-scratch-grafana --network fleetscope_default -p 127.0.0.1:3002:3000 \
  -e GF_PLUGINS_PREINSTALL_SYNC=grafana-clickhouse-datasource@4.23.2 \
  -e GF_SECURITY_ADMIN_PASSWORD=<throwaway> grafana/grafana:13.2.4
curl -s localhost:3002/api/health                      # "version": "13.2.4"
```

A service account `fleetscope-push` (role Admin) with a token, a user `alice` (Admin) and a user `bob`
(Editor) were created through the API. The token is passed as `GRAFANA_TOKEN` and is not shown here.
Run on 2026-10-24. Outputs are trimmed; `pnpm grafana:push` was started with
`GRAFANA_URL=http://localhost:3002 GRAFANA_CLICKHOUSE_URL=http://clickhouse:8123`.

## 1. Two pushes: the second is all `unchanged`

```text
$ pnpm grafana:push            # first run
folder      fleetscope ("Fleetscope")  created
lock        fleetscope: Viewer View, Editor View, Admin Admin  updated (Editor: Edit -> View)
folder      fleetscope-team ("Team dashboards")  created
access      fleetscope-team: Viewer View, Editor Edit, Admin Admin  unchanged  (its dashboards are never touched)
data source fleetscope-clickhouse  created  (...)
dashboard   fleetscope-browsers  created  ... (4 dashboards created)
exit 0

$ pnpm grafana:push            # second run
folder      fleetscope ("Fleetscope")  unchanged
lock        fleetscope: Viewer View, Editor View, Admin Admin  unchanged
folder      fleetscope-team ("Team dashboards")  unchanged
access      fleetscope-team: Viewer View, Editor Edit, Admin Admin  unchanged  (its dashboards are never touched)
data source fleetscope-clickhouse  updated (the password cannot be compared, so it is always sent again)
dashboard   fleetscope-browsers / -overview / -session / -sessions  unchanged
theme       organisation default dark  unchanged
exit 0
```

(The data source always says `updated`: Grafana never returns the password. Everything else is `unchanged`.)

## 2. The permission rows (`GET /api/access-control/folders/<uid>`)

```text
GET /api/access-control/folders/fleetscope            (builtInRole / permission / isManaged)
sa-1-fleetscope-push  Admin   managed=true      <- Grafana gives the creator an Admin grant
Editor                View    managed=true
Viewer                View    managed=true
Admin                 Admin   managed=false     <- built in, listed twice by Grafana

GET /api/access-control/folders/fleetscope-team
sa-1-fleetscope-push  Admin   managed=true
Editor                Edit    managed=true
Viewer                View    managed=true
Admin                 Admin   managed=false
```

The push sets a role with `POST /api/access-control/folders/<uid>/builtInRoles/<role>` and
`{"permission": "View"}`; that call changes one role and leaves user and team grants alone. The creator's
own Admin grant is not reported as an "extra grant".

## 3. The Admin built-in role

Grafana accepts the POST for Admin and lists the Admin row without it:

```text
$ curl -X POST -d '{"permission":"Admin"}' .../api/access-control/folders/fleetscope/builtInRoles/Admin
{"message":"Permission updated"} (HTTP 200)
GET .../folders/fleetscope  ->  Admin  Admin  managed=true   (a managed row appears next to the built-in one)
$ pnpm grafana:push  ->  lock  fleetscope: ...  unchanged
```

The push never sends it: any Admin/Admin row (built in or managed) counts as satisfied, so a run on a
fresh folder does not need the call and a Grafana that refused it would not matter.

## 4. An Editor: denied in the official folder, allowed in "Team dashboards"

```text
bob (Editor), save a changed official dashboard into folder fleetscope:
  {} (HTTP 403)
bob, "Save as" a copy of Sessions into folder fleetscope-team:
  {"folderUid":"fleetscope-team", ..., "status":"success","uid":"bob-copy"}  (HTTP 200)
bob reads the official dashboard:  HTTP 200
```

No basic-role grant bypasses the lock: Editors can open and copy, not save.

## 5. Identity: `GET /api/user` versus `meta.updatedBy`

```text
GET /api/user  (Bearer token of the service account)
{"uid":"service-account:2","login":"sa-1-fleetscope-push","name":"fleetscope-push"}

push of a changed dashboard (fleetscope-sessions)  ->  updated
meta of that dashboard:  {"updatedBy":"fleetscope-push","createdBy":"fleetscope-push"}
```

**`updatedBy` is the service account's NAME, not its login** (`sa-1-...`). A person is recorded by login.
Grafana Cloud was measured the same way by the lead: login `sa-1-fleetscope-push`, name `fleetscope-push`,
uid `service-account:20`, `meta.updatedBy` and the version history's `createdBy` both `fleetscope-push`.
So `src/drift.ts` accepts the token's login, and for a service account (uid `service-account:...` or login
`sa-...`) also its name; for a person it compares the login only (`src/drift.test.ts` has the Cloud values).

**A second finding** (only on a dashboard that the service account created and never updated, version 1):

```text
GET /api/dashboards/uid/fleetscope-session  meta ->  {"version":1,"updatedBy":"Anonymous","createdBy":"Anonymous"}
GET /api/dashboards/uid/fleetscope-session/versions
{"version":1,"createdBy":"fleetscope-push","message":"Initial save"}
```

`meta` says `Anonymous`, the version history is right. The first version of this work compared `meta` only
and therefore reported all four dashboards as "saved by someone else" on the second push. The push now
confirms with the newest version of the history (`GET /api/dashboards/uid/<uid>/versions?limit=1`) whenever
`meta` names somebody else. The run above (section 1, second push) is the result: all `unchanged`.

## 6. Drift, `adopted`, `--force <uid>`

alice (Admin) edits `fleetscope-overview` in the UI; then:

```text
$ pnpm grafana:push                                    (exit 1)
REFUSED     dashboard fleetscope-overview  not overwritten: last saved in Grafana by alice at 2026-10-24T20:31:34Z
            and it differs from the repository. Run pnpm grafana:pull fleetscope-overview to keep it, or
            pnpm grafana:push --force fleetscope-overview to discard it
1 dashboard(s) were NOT overwritten (everything else was pushed): fleetscope-overview. ...

$ pnpm grafana:pull fleetscope-overview --out dash/fleetscope-overview.json     # then reviewed and merged
$ pnpm grafana:push                                    (exit 0)
dashboard   fleetscope-overview  adopted  (equals the repository; last saved by alice, now saved by sa-1-fleetscope-push)
meta.updatedBy = fleetscope-push

$ pnpm grafana:push                                    -> every dashboard unchanged
$ (edit the repository copy of fleetscope-overview)
$ pnpm grafana:push                                    (exit 0, no --force)
dashboard   fleetscope-overview  updated
```

Version history of that dashboard (`GET .../versions`):

```text
7 fleetscope-push  grafana:push            <- the ordinary change after the adoption
6 alice            (UI save)
5 fleetscope-push  grafana:push
4 fleetscope-push  grafana:push adopted    <- the real content
3 fleetscope-push  grafana:push adopting   <- same content, title "... (adopting)"
2 alice            (UI save)
1 fleetscope-push  Initial save
```

**Why `adopted` takes two saves.** A first attempt re-saved the identical body once (what the review asked
for). Grafana makes **no new version** for a save that changes nothing, so the author stayed `alice` and
the dashboard would have been "adopted" on every push. Now the push saves a copy with `(adopting)` in the
title and then the real body; the last version is the push's. Version 3 and 4 are the price, once per adoption.

Two drifted dashboards, discard only one:

```text
$ pnpm grafana:push --force fleetscope-overview        (exit 1)
REFUSED     dashboard fleetscope-browsers  not overwritten: last saved in Grafana by alice ...
dashboard   fleetscope-overview  updated
1 dashboard(s) were NOT overwritten (everything else was pushed): fleetscope-browsers. ...
```

`pnpm grafana:pull fleetscope-overview` against the edited dashboard produced a diff of one line (alice's
title) against the committed file: keys come back in the committed order and `api_url` is restored.

## Not covered

- Grafana Cloud: only read-only measurements (`/api/user`, `meta.updatedBy`, `createdBy`); the lead runs
  `grafana:push --dry-run` there. Cloud uses unified storage; `GET /api/access-control/...` was not called
  there from this work.
- Teams as grants, SSO users, and a person whose login equals the service account's name (a
  dedicated service account for the push avoids it; documented in the README).

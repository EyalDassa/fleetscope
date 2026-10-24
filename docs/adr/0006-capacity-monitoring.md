# ADR 0006: Capacity monitoring from per-replica system tables and the billing API

- Status: accepted (2026-10-25)

## Context

Eyal raised the live load and wants five things:
- proof that ClickHouse Cloud writes what the fleet sends;
- utilization against the service's limits;
- autoscaling events;
- the trial credit;
- email alerts for all of it.

ClickHouse exposes this in two places: its own system tables (`system.part_log`, `system.asynchronous_metric_log`), and the ClickHouse Cloud control-plane API (`/v1/organizations/{id}/usageCost`). Grafana must keep reading through the read-only `grafana_ro` user, and billing needs an organisation API key.

## Options

1. **System tables through `clusterAllReplicas(default, ...)`.** This sees every replica, but it needs `GRANT READ ON REMOTE ON *.*`, which lets the user read from any server the cluster functions can reach.
2. **The plain system tables, per replica** (whatever replica Grafana reaches). The grant is narrow: `SELECT` on two system tables, by column. It is exact while the service runs one replica, and wrong once inserts spread across replicas.
3. **ClickHouse Cloud's built-in monitoring or its Prometheus endpoint.** That means one more data source and a credential with wider scope, and it does not compare the result with the fleet's own rows.
4. **For billing:** the Infinity plugin with basic auth in `secureJsonData` and `allowedHosts`, or a small proxy in our API that holds the key.

## Decision

- **Load and utilization: option 2.** `grafana_ro` gets `SELECT` only on the columns the queries read:
  - `system.asynchronous_metric_log(event_time, hostname, metric, value)`;
  - `system.part_log(database, error, event_time, event_type, rows, table)`.

  Not `exception`, `query_id` or paths.
- **What "sent" and "written" mean.**
  - "Sent" counts the four append-only event tables.
  - "Written" counts `part_log` `NewPart` rows with `error = 0` (this drops deduplicated retries) for the same tables.
  - `sessions` is excluded, because it is a ReplacingMergeTree.
  - The capacity queries have no `source` filter, because the system tables know nothing about it.
- **Memory** is `CGroupMemoryUsedWithoutPageCache` against `CGroupMemoryTotal`.
  - Alert thresholds are 75% and 85%; ClickHouse starts refusing queries at about 90%.
  - The alerts use a whole-minute average, so one 1-second peak does not page.
- **Billing: the Infinity data source.**
  - The organisation id is part of the data source's base URL.
  - The key is read-only: ClickHouse Cloud role "Organization API Reader". It was verified: `usageCost` returns 200, while a write such as `PATCH organization` returns 403.
  - The key is stored only in Grafana's `secureJsonData`, and `allowedHosts` limits it to `api.clickhouse.cloud`.
  - 1 CHC is treated as $1.
- **Alerts are code** (`infra/grafana/alerts`), in two groups: capacity every minute, billing every 15 minutes.
  - They are uploaded with API provenance, so only the repository changes them.
  - Their SQL is copied from `packages/db/README.md` and executed in CI.

## Consequences

- **More than one replica.** The panels and the mismatch alert see one replica only, and can be wrong. The README says so, and the replica count and the limits-changed alert make a scale-out visible. Moving to option 1 is one grant and a table wrapper, and needs a new ADR, because it widens `grafana_ro`.
- **Replica replacement.** A replaced replica takes its log with it, so there is no history across replacements.
- **The newest ~10 s are incomplete,** because of the log flush.
- **Backfills show up as a mismatch.** That covers seeding, and simulator runs with their own clock.
- **The key is shared.** Every Grafana user who can query the billing data source can use the key within its role, so the role must stay read-only.
- **Billing lags about a day.**
- **The per-minute alert queries keep the Cloud service from idling.** It never idles anyway while live traffic runs.
- **The trial dates and the $300 are constants** that must change when the plan changes.

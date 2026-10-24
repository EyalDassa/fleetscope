#!/usr/bin/env bash
# Fails unless system.part_log and system.asynchronous_metric_log exist and can be read on the
# ClickHouse at CLICKHOUSE_URL. The Capacity dashboard and its alerts read both tables.
# ClickHouse Cloud has them. Locally they come from infra/clickhouse/config.d/system-logs.xml; the CI
# service container cannot mount that file and relies on the image defaults, so this check is what
# notices if a new image stops writing either table.
# Usage: check-clickhouse-system-logs.sh   (CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD)
set -euo pipefail

url="${CLICKHOUSE_URL:-http://localhost:8123}"
user="${CLICKHOUSE_USER:-fleetscope}"
password="${CLICKHOUSE_PASSWORD:-fleetscope_dev_password}"

query() {
  curl --silent --show-error --fail --max-time 30 --user "$user:$password" \
    --data-binary "$1" "$url/"
}

# The tables are created by the server's first flush; make it happen now.
query "SYSTEM FLUSH LOGS" > /dev/null

for table in part_log asynchronous_metric_log; do
  count=$(query "SELECT count() FROM system.$table" | tr -d '[:space:]')
  echo "system.$table: $count row(s)"
  if ! [[ "$count" =~ ^[0-9]+$ ]]; then
    echo "ERROR: could not read system.$table (got: $count)" >&2
    exit 1
  fi
done

# part_log only has rows once some part was written, so ask the dashboard's question on top of the
# table existing: has the schema migration (which creates parts) been recorded?
parts=$(query "SELECT count() FROM system.part_log WHERE event_type = 'NewPart'" | tr -d '[:space:]')
if [ "${parts:-0}" -lt 1 ]; then
  echo "ERROR: system.part_log has no NewPart rows. Run pnpm db:migrate first, or part_log is switched off." >&2
  exit 1
fi
echo "OK: part_log has $parts NewPart row(s), asynchronous_metric_log is readable"

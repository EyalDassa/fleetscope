#!/usr/bin/env bash
# Asserts that a fleet smoke run (`pnpm fleet run --engines chromium --sessions 3 ...`) left the
# right data in ClickHouse and no browser containers behind. Used by the "Fleet smoke (Chromium)"
# CI job; it also works against a local stack (pnpm infra:up).
#
# Fails unless:
#   - there are exactly SMOKE_EXPECTED_SESSIONS (3) `real` sessions of SMOKE_ENGINE (chromium),
#     all with an end status (success | failed | blocked | timeout | crashed, not `running`);
#   - every one of them has >= SMOKE_MIN_ACTIONS (3) actions and
#     >= SMOKE_MIN_CONTAINER_SAMPLES (1) resource sample with origin = 'container';
#   - no container with a fleetscope label is left (running or stopped).
#
# The API flushes its buffer once per second, so the data checks are retried for up to
# SMOKE_WAIT_SECONDS before they count as failures. Sessions are only looked at if they started in
# the last SMOKE_WINDOW_MINUTES, so a local database with older runs does not disturb the count.
#
# Environment (defaults match .env.example):
#   CLICKHOUSE_URL=http://localhost:8123  CLICKHOUSE_USER=fleetscope  CLICKHOUSE_PASSWORD=...
#   CLICKHOUSE_DATABASE=fleetscope
#   SMOKE_ENGINE=chromium  SMOKE_EXPECTED_SESSIONS=3  SMOKE_MIN_ACTIONS=3
#   SMOKE_MIN_CONTAINER_SAMPLES=1  SMOKE_WINDOW_MINUTES=60  SMOKE_WAIT_SECONDS=20
#   FLEET_CONTAINER_LABELS="fleetscope.session fleetscope.engine"   (space separated label keys)
set -euo pipefail

url="${CLICKHOUSE_URL:-http://localhost:8123}"
user="${CLICKHOUSE_USER:-fleetscope}"
password="${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD is not set (see .env.example)}"
database="${CLICKHOUSE_DATABASE:-fleetscope}"
engine="${SMOKE_ENGINE:-chromium}"
expected_sessions="${SMOKE_EXPECTED_SESSIONS:-3}"
min_actions="${SMOKE_MIN_ACTIONS:-3}"
min_samples="${SMOKE_MIN_CONTAINER_SAMPLES:-1}"
window_minutes="${SMOKE_WINDOW_MINUTES:-60}"
wait_seconds="${SMOKE_WAIT_SECONDS:-20}"
labels="${FLEET_CONTAINER_LABELS:-fleetscope.session fleetscope.engine}"

# One row per session: its latest status, its action count and its container sample count.
# `sessions` keeps a running row and an ended row per session (ReplacingMergeTree on `version`),
# so we take the status of the highest version. uniqExact(event_id) ignores duplicated deliveries.
read -r -d '' sql <<'SQL' || true
SELECT
    s.session_id AS session_id,
    s.status AS status,
    a.n AS actions,
    r.n AS container_samples
FROM
(
    SELECT session_id, argMax(status, version) AS status
    FROM sessions
    WHERE source = 'real'
      AND engine = {engine:String}
      AND started_at >= now() - INTERVAL {window:UInt32} MINUTE
    GROUP BY session_id
) AS s
LEFT JOIN
(
    SELECT session_id, uniqExact(event_id) AS n
    FROM actions
    WHERE source = 'real' AND engine = {engine:String}
    GROUP BY session_id
) AS a ON a.session_id = s.session_id
LEFT JOIN
(
    SELECT session_id, uniqExact(event_id) AS n
    FROM resource_samples
    WHERE source = 'real' AND engine = {engine:String} AND origin = 'container'
    GROUP BY session_id
) AS r ON r.session_id = s.session_id
ORDER BY s.session_id
FORMAT TSVWithNames
SQL

query() {
  curl --silent --show-error --fail-with-body --max-time 20 \
    --user "${user}:${password}" \
    --data-binary "$sql" \
    "${url}/?database=${database}&param_engine=${engine}&param_window=${window_minutes}"
}

problems=()
report=""

# Runs the data checks once. Fills `problems` (empty = all good) and `report`.
check_data() {
  problems=()
  local out
  if ! out=$(query 2>&1); then
    problems+=("ClickHouse query failed: ${out}")
    report=""
    return
  fi
  report="$out"

  local rows
  rows=$(printf '%s\n' "$out" | tail -n +2 | grep -c . || true)
  if [ "$rows" -ne "$expected_sessions" ]; then
    problems+=("expected ${expected_sessions} real ${engine} sessions, found ${rows}")
  fi

  # Columns: session_id, status, actions, container_samples
  local line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    problems+=("$line")
  done < <(printf '%s\n' "$out" | tail -n +2 | awk -F'\t' \
    -v min_actions="$min_actions" -v min_samples="$min_samples" '
      NF == 0 { next }
      {
        if ($2 !~ /^(success|failed|blocked|timeout|crashed)$/)
          printf "session %s has status \"%s\", expected an end status\n", $1, $2
        if ($3 + 0 < min_actions)
          printf "session %s has %s actions, expected at least %d\n", $1, $3, min_actions
        if ($4 + 0 < min_samples)
          printf "session %s has %s container resource samples, expected at least %d\n", $1, $4, min_samples
      }')
}

deadline=$((SECONDS + wait_seconds))
while true; do
  check_data
  if [ "${#problems[@]}" -eq 0 ] || [ "$SECONDS" -ge "$deadline" ]; then
    break
  fi
  sleep 2
done

echo "Real ${engine} sessions started in the last ${window_minutes} min:"
if [ -n "$report" ]; then
  printf '%s\n' "$report" | column -t -s "$(printf '\t')" 2>/dev/null || printf '%s\n' "$report"
fi

failed=0
if [ "${#problems[@]}" -ne 0 ]; then
  failed=1
  for p in "${problems[@]}"; do
    echo "FAIL: $p" >&2
  done
else
  echo "OK: ${expected_sessions} sessions, each with >= ${min_actions} actions and >= ${min_samples} container sample(s)"
fi

# --- no containers left behind ----------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "FAIL: docker not found, cannot check for leaked containers" >&2
  failed=1
else
  leaked=""
  for label in $labels; do
    found=$(docker ps --all --filter "label=${label}" --format '{{.ID}}  {{.Names}}  {{.Status}}  {{.Image}}')
    [ -z "$found" ] || leaked+="${found}"$'\n'
  done
  leaked=$(printf '%s' "$leaked" | sort -u) # a container usually carries several of the labels
  if [ -n "$leaked" ]; then
    echo "FAIL: containers with a fleetscope label are still there (running or stopped):" >&2
    printf '%s\n' "$leaked" >&2
    failed=1
  else
    echo "OK: no containers with label(s) [${labels}] left"
  fi
fi

exit "$failed"

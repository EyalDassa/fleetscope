#!/usr/bin/env bash
# Asserts that a fleet smoke run (`pnpm fleet run --engines chromium,chrome-headless-shell,lightpanda
# --sessions 6 ...`) left the right data in ClickHouse and no browser containers behind. Used by the
# "Fleet smoke (all engines)" CI job; it also works against a local stack (pnpm infra:up).
#
# The checks below run once PER ENGINE in SMOKE_ENGINES (space separated). Fails unless:
#   - there are exactly SMOKE_EXPECTED_SESSIONS (2 per engine) `real` sessions of the engine,
#     all with an end status (success | failed | blocked | timeout | crashed, not `running`);
#   - a `success` session has >= SMOKE_MIN_ACTIONS (3) actions; any other end status needs only
#     >= 1, because a `blocked` session stops at the bot wall, which can be its first page;
#   - every session has >= SMOKE_MIN_CONTAINER_SAMPLES (1) resource sample with origin = 'container',
#     >= SMOKE_MIN_CDP_SAMPLES (1) with origin = 'cdp' and >= SMOKE_MIN_NETWORK_REQUESTS (1) row in
#     network_requests;
#   - engines NOT listed in SMOKE_NULLABLE_ENGINES (default "lightpanda") also need a cdp sample with a
#     JS heap value and a network request with a size. Lightpanda has no Performance.getMetrics and no
#     Network.*ExtraInfo, so their heap / byte columns may be NULL (that is the honest value, see
#     CLAUDE.md "Data honesty") and a session that ends at the bot wall may have no network_requests
#     row at all. The cdp sample row itself is still required;

#   - there are NO duplicate rows: for actions, resource_samples and network_requests, count() must
#     equal uniqExact(event_id). Counts are shown with count(), so a duplicate is never hidden by
#     uniqExact (dedupe is the central M1 decision);
#   - no container with a fleetscope label is left (running or stopped).
#
# None of this depends on the scenario dice (which seed produced a bot wall), so a change in how
# the runner uses its random numbers cannot turn CI red.
#
# The API flushes its buffer once per second, so the data checks are retried for up to
# SMOKE_WAIT_SECONDS before they count as failures. Sessions are only looked at if they started in
# the last SMOKE_WINDOW_MINUTES, so a local database with older runs does not disturb the count.
#
# Environment (defaults match .env.example):
#   CLICKHOUSE_URL=http://localhost:8123  CLICKHOUSE_USER=fleetscope  CLICKHOUSE_PASSWORD=...
#   CLICKHOUSE_DATABASE=fleetscope
#   SMOKE_ENGINES="chromium chrome-headless-shell lightpanda"  (default: SMOKE_ENGINE, else chromium)
#   SMOKE_NULLABLE_ENGINES="lightpanda"  SMOKE_EXPECTED_SESSIONS=2 (per engine)  SMOKE_MIN_ACTIONS=3
#   SMOKE_MIN_CONTAINER_SAMPLES=1  SMOKE_MIN_CDP_SAMPLES=1  SMOKE_MIN_NETWORK_REQUESTS=1
#   SMOKE_WINDOW_MINUTES=60  SMOKE_WAIT_SECONDS=20
#   FLEET_CONTAINER_LABELS="fleetscope.session fleetscope.engine"   (space separated label keys)
set -euo pipefail

url="${CLICKHOUSE_URL:-http://localhost:8123}"
user="${CLICKHOUSE_USER:-fleetscope}"
password="${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD is not set (see .env.example)}"
database="${CLICKHOUSE_DATABASE:-fleetscope}"
engines="${SMOKE_ENGINES:-${SMOKE_ENGINE:-chromium}}"
nullable_engines="${SMOKE_NULLABLE_ENGINES-lightpanda}"
engine="" # set per engine in the loop below
need_values=1 # 0 for the engines in nullable_engines
expected_sessions="${SMOKE_EXPECTED_SESSIONS:-2}"
min_actions="${SMOKE_MIN_ACTIONS:-3}"
min_samples="${SMOKE_MIN_CONTAINER_SAMPLES:-1}"
min_cdp="${SMOKE_MIN_CDP_SAMPLES:-1}"
min_network="${SMOKE_MIN_NETWORK_REQUESTS:-1}"
window_minutes="${SMOKE_WINDOW_MINUTES:-60}"
wait_seconds="${SMOKE_WAIT_SECONDS:-20}"
labels="${FLEET_CONTAINER_LABELS:-fleetscope.session fleetscope.engine}"

# One row per session: its latest status, row counts per table and duplicate counts per table.
# `sessions` keeps a running row and an ended row per session (ReplacingMergeTree on `version`),
# so we take the status of the highest version (duplicates there are by design, not checked).
# The other tables are plain MergeTree with one row per event: the counts use count(), and
# dup_* = count() - uniqExact(event_id) must be 0, so a duplicated delivery is reported, not hidden.
# A session with no rows in a table gets 0 from the LEFT JOIN (join_use_nulls is off by default).
read -r -d '' sql <<'SQL' || true
SELECT
    s.session_id AS session_id,
    s.status AS status,
    a.n AS actions,
    r.container_n AS container_samples,
    r.cdp_n AS cdp_samples,
    q.n AS network_requests,
    a.dups AS dup_actions,
    r.dups AS dup_samples,
    q.dups AS dup_network,
    r.heap_n AS cdp_heap_samples,
    q.sized_n AS sized_requests
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
    SELECT session_id, count() AS n, count() - uniqExact(event_id) AS dups
    FROM actions
    WHERE source = 'real' AND engine = {engine:String}
    GROUP BY session_id
) AS a ON a.session_id = s.session_id
LEFT JOIN
(
    SELECT
        session_id,
        countIf(origin = 'container') AS container_n,
        countIf(origin = 'cdp') AS cdp_n,
        countIf(origin = 'cdp' AND js_heap_mb IS NOT NULL) AS heap_n,
        count() - uniqExact(event_id) AS dups
    FROM resource_samples
    WHERE source = 'real' AND engine = {engine:String}
    GROUP BY session_id
) AS r ON r.session_id = s.session_id
LEFT JOIN
(
    SELECT session_id, count() AS n, count() - uniqExact(event_id) AS dups, countIf(bytes IS NOT NULL) AS sized_n
    FROM network_requests
    WHERE source = 'real' AND engine = {engine:String}
    GROUP BY session_id
) AS q ON q.session_id = s.session_id
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
  need_values=1
  eff_min_network="$min_network"
  case " $nullable_engines " in
    # Lightpanda reports no network events for a page that ends at the bot wall (a 403 on the first
    # page, which the seeded smoke run does hit), so it may have no network_requests row at all.
    *" $engine "*) need_values=0; eff_min_network=0 ;;
  esac

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

  # Columns: 1 session_id, 2 status, 3 actions, 4 container_samples, 5 cdp_samples,
  #          6 network_requests, 7 dup_actions, 8 dup_samples, 9 dup_network,
  #          10 cdp_heap_samples, 11 sized_requests
  local line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    problems+=("$line")
  done < <(printf '%s\n' "$out" | tail -n +2 | awk -F'\t' \
    -v min_actions="$min_actions" -v min_samples="$min_samples" \
    -v min_cdp="$min_cdp" -v min_network="$eff_min_network" -v need_values="$need_values" '
      NF == 0 { next }
      {
        if ($2 !~ /^(success|failed|blocked|timeout|crashed)$/)
          printf "session %s has status \"%s\", expected an end status\n", $1, $2
        # Only a session that ran its whole scenario must have the full number of actions.
        need = ($2 == "success") ? min_actions : 1
        if ($3 + 0 < need)
          printf "session %s (%s) has %s actions, expected at least %d\n", $1, $2, $3, need
        if ($4 + 0 < min_samples)
          printf "session %s has %s container resource samples, expected at least %d\n", $1, $4, min_samples
        if ($5 + 0 < min_cdp)
          printf "session %s has %s cdp resource samples, expected at least %d\n", $1, $5, min_cdp
        if ($6 + 0 < min_network)
          printf "session %s has %s network_requests rows, expected at least %d\n", $1, $6, min_network
        if ($7 + 0 != 0)
          printf "session %s has %s duplicate action rows (same event_id more than once)\n", $1, $7
        if ($8 + 0 != 0)
          printf "session %s has %s duplicate resource_samples rows (same event_id more than once)\n", $1, $8
        if ($9 + 0 != 0)
          printf "session %s has %s duplicate network_requests rows (same event_id more than once)\n", $1, $9
        if (need_values == 1 && $10 + 0 < 1)
          printf "session %s has no cdp sample with a JS heap value\n", $1
        if (need_values == 1 && $11 + 0 < 1)
          printf "session %s has no network request with a size (bytes)\n", $1
      }')
}

failed=0
for engine in $engines; do
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

  if [ "${#problems[@]}" -ne 0 ]; then
    failed=1
    for p in "${problems[@]}"; do
      echo "FAIL [${engine}]: $p" >&2
    done
  else
    extra="JS heap and byte sizes present"
    [ "$need_values" -eq 1 ] || extra="JS heap / byte sizes may be NULL for this engine"
    echo "OK [${engine}]: ${expected_sessions} sessions; actions (>= ${min_actions} if success, else >= 1), container samples >= ${min_samples}, cdp samples >= ${min_cdp}, network requests >= ${eff_min_network}, no duplicate rows, ${extra}"
  fi
done

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

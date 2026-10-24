#!/usr/bin/env bash
# Tests the decision logic of assert-fleet-smoke.sh without ClickHouse or Docker: it feeds the script
# a prepared report (SMOKE_TSV_FILE) and checks whether it passes or fails. Run by the "check" CI job.
#
# Report columns (see assert-fleet-smoke.sh): session_id status actions container_samples cdp_samples
# network_requests dup_actions dup_samples dup_network cdp_heap_samples sized_requests ok_actions
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0

header=$'session_id\tstatus\tactions\tcontainer_samples\tcdp_samples\tnetwork_requests\tdup_actions\tdup_samples\tdup_network\tcdp_heap_samples\tsized_requests\tok_actions'

# expect <pass|fail> <name> <engine> <report rows, tab separated, one per line>
expect() {
  local want="$1" name="$2" engine="$3" rows="$4" got=pass
  { printf '%s\n' "$header"; printf '%s\n' "$rows"; } > "$tmp/report.tsv"
  if ! CLICKHOUSE_PASSWORD=x SMOKE_TSV_FILE="$tmp/report.tsv" SMOKE_SKIP_DOCKER=1 SMOKE_WAIT_SECONDS=0 \
      SMOKE_ENGINES="$engine" SMOKE_EXPECTED_SESSIONS=2 \
      bash "$here/assert-fleet-smoke.sh" > "$tmp/out.txt" 2>&1; then
    got=fail
  fi
  if [ "$got" = "$want" ]; then
    echo "ok   - $name"
  else
    echo "FAIL - $name (wanted $want, got $got)"
    sed 's/^/       /' "$tmp/out.txt"
    failures=$((failures + 1))
  fi
}

t=$'\t'
row() { local IFS=$'\t'; echo "$*"; }

good_chromium="$(row s1 success 8 2 2 5 0 0 0 2 5 8)
$(row s2 success 8 2 2 5 0 0 0 2 5 8)"
expect pass "healthy chromium" chromium "$good_chromium"

# Lightpanda: no heap, no byte sizes, and a blocked session without network rows are fine.
expect pass "lightpanda with null heap, null bytes and a blocked session without network rows" lightpanda \
  "$(row s1 success 10 1 1 2 0 0 0 0 0 10)
$(row s2 blocked 1 1 1 0 0 0 0 0 0 0)"

# R-M3-07: a successful Lightpanda session without network rows means its network capture is broken.
expect fail "lightpanda success session with no network rows" lightpanda \
  "$(row s1 success 10 1 1 0 0 0 0 0 0 10)
$(row s2 blocked 1 1 1 0 0 0 0 0 0 0)"

# ... and so does a failed one (only `blocked` is excused).
expect fail "lightpanda failed session with no network rows" lightpanda \
  "$(row s1 success 10 1 1 2 0 0 0 0 0 10)
$(row s2 failed 3 1 1 0 0 0 0 0 0 1)"

# Two sessions that fail on their very first action must not pass.
expect fail "lightpanda sessions without any ok action" lightpanda \
  "$(row s1 failed 1 1 1 1 0 0 0 0 0 0)
$(row s2 failed 1 1 1 1 0 0 0 0 0 0)"
expect fail "chromium sessions without any ok action" chromium \
  "$(row s1 failed 1 2 2 1 0 0 0 2 1 0)
$(row s2 failed 1 2 2 1 0 0 0 2 1 0)"

# An engine whose only sessions are blocked has done nothing either.
expect fail "an engine whose sessions are all blocked" lightpanda \
  "$(row s1 blocked 1 1 1 0 0 0 0 0 0 0)
$(row s2 blocked 1 1 1 0 0 0 0 0 0 0)"

# Non-nullable engines keep the strict rules.
expect fail "chromium without a heap value" chromium \
  "$(row s1 success 8 2 2 5 0 0 0 0 5 8)
$(row s2 success 8 2 2 5 0 0 0 2 5 8)"
expect fail "chromium blocked session without network rows" chromium \
  "$(row s1 success 8 2 2 5 0 0 0 2 5 8)
$(row s2 blocked 1 2 2 0 0 0 0 2 0 0)"
expect fail "wrong number of sessions" chromium "$(row s1 success 8 2 2 5 0 0 0 2 5 8)"
expect fail "duplicate rows" chromium \
  "$(row s1 success 8 2 2 5 1 0 0 2 5 8)
$(row s2 success 8 2 2 5 0 0 0 2 5 8)"

if [ "$failures" -ne 0 ]; then
  echo "$failures assertion test(s) failed" >&2
  exit 1
fi
echo "OK: assert-fleet-smoke.sh decisions are as expected"

#!/usr/bin/env bash
# Tests the decisions of public-canary-report.sh without ClickHouse or GitHub: the report comes from
# a file (CANARY_TSV_FILE) and `gh` is a fake that keeps a list of open issues and logs its calls.
# Run by the "check" CI job.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0

# The fake gh. State: $tmp/open.tsv ("number<TAB>title"), calls: $tmp/calls.log (one line per call).
cat > "$tmp/gh" <<'FAKE'
#!/usr/bin/env bash
dir="$(dirname "${BASH_SOURCE[0]}")"
case "$1 $2" in
  "issue list") cat "$dir/open.tsv" ;;   # what --jq would print
  "issue create") printf 'create|%s|%s\n' "$4" "$6" >> "$dir/calls.log" ;;
  "issue comment") printf 'comment|%s|%s\n' "$3" "$5" >> "$dir/calls.log" ;;
  "issue close") printf 'close|%s|%s\n' "$3" "$5" >> "$dir/calls.log" ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
FAKE
chmod +x "$tmp/gh"

row() { local IFS=$'\t'; echo "$*"; }
all_ok="$(row govuk success - -)
$(row hackernews success - -)
$(row mdn success - -)
$(row python-docs success - -)
$(row wikipedia success - -)"

# run <name> <want: pass|fail> <report> <open issues> <fleet outcome> <issues on> <grep pattern, one per
# remaining arg, that must appear in calls.log; a pattern starting with ! must NOT appear>
run() {
  local name="$1" want="$2" report="$3" open="$4" outcome="$5" on="$6" got=pass
  shift 6
  printf '%s\n' "$report" > "$tmp/report.tsv"
  printf '%s' "$open" > "$tmp/open.tsv"
  : > "$tmp/calls.log"
  if ! CANARY_TSV_FILE="$tmp/report.tsv" CANARY_GH="$tmp/gh" CANARY_ISSUES="$on" \
      CANARY_FLEET_OUTCOME="$outcome" CANARY_RUN_URL="https://example.test/runs/42" \
      bash "$here/public-canary-report.sh" > "$tmp/out.txt" 2>&1; then
    got=fail
  fi
  local problem=""
  [ "$got" = "$want" ] || problem="wanted exit $want, got $got"
  local pat
  for pat in "$@"; do
    if [ "${pat:0:1}" = "!" ]; then
      ! grep -q -- "${pat:1}" "$tmp/calls.log" || problem="${problem:+$problem; }calls.log has '${pat:1}'"
    else
      grep -q -- "$pat" "$tmp/calls.log" || problem="${problem:+$problem; }calls.log lacks '$pat'"
    fi
  done
  if [ -z "$problem" ]; then
    echo "ok   - $name"
  else
    echo "FAIL - $name ($problem)"
    sed 's/^/       out: /' "$tmp/out.txt"
    sed 's/^/       gh:  /' "$tmp/calls.log"
    failures=$((failures + 1))
  fi
}

run "all sites pass: nothing to do" pass "$all_ok" "" success 1 "!^create|" "!^comment|" "!^close|"

bad_layout="$(row govuk success - -)
$(row hackernews failed site_layout 'selector .itemlist not found')
$(row mdn success - -)
$(row python-docs success - -)
$(row wikipedia success - -)"
run "failing site, no open issue: opens one with code, reason and run link" fail "$bad_layout" "" success 1 \
  "create|public-site canary: hackernews failing|" "site_layout" "selector .itemlist not found" "https://example.test/runs/42" \
  "!^comment|" "!^close|"

run "failing site, issue already open: comments, does not open a second" fail "$bad_layout" \
  $'7\tpublic-site canary: hackernews failing\n' success 1 \
  "comment|7|" "!^create|" "!^close|"

# Exact title match only: other sites' issues and a longer title must not count.
run "issues of other sites or with a longer title are not matched" fail "$bad_layout" \
  $'3\tpublic-site canary: wikipedia failing\n4\tpublic-site canary: hackernews failing again\n' success 1 \
  "create|public-site canary: hackernews failing|" "!^comment|4" "!^close|4"

run "site passes again: comments and closes its issue" pass "$all_ok" \
  $'9\tpublic-site canary: wikipedia failing\n11\tunrelated bug\n' success 1 \
  "close|9|Passing again" "!^close|11" "!^create|"

run "a site with no session opens an issue" fail "$(row govuk success - -)
$(row hackernews success - -)
$(row mdn success - -)
$(row python-docs success - -)" "" success 1 \
  "create|public-site canary: wikipedia failing|" "no public session recorded"

run "no session and the fleet runner failed: infrastructure, no issue, job red" fail "" "" failure 1 \
  "!^create|" "!^comment|"

run "all sites pass but the runner step failed: job red, issues untouched" fail "$all_ok" \
  $'9\tpublic-site canary: wikipedia failing\n' failure 1 "!^close|" "!^create|"

run "blocked site is reported with its status" fail "$(row govuk blocked - 'HTTP 403 on /')
$(row hackernews success - -)
$(row mdn success - -)
$(row python-docs success - -)
$(row wikipedia success - -)" "" success 1 \
  "create|public-site canary: govuk failing|" "blocked" "HTTP 403"

run "issues off: decides, calls nothing" fail "$bad_layout" "" success 0 "!^create|" "!^comment|" "!^close|"

if [ "$failures" -ne 0 ]; then
  echo "$failures canary test(s) failed" >&2
  exit 1
fi
echo "OK: public-canary-report.sh decisions are as expected"

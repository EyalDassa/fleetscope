#!/usr/bin/env bash
# Reads the result of the daily public-sites canary from ClickHouse, prints one line per site, opens
# or updates a GitHub issue for every failing site, closes the issue of a site that passes again, and
# exits non-zero if any site did not succeed. Used by .github/workflows/public-sites-canary.yml
# (ADR 0007). Tested without ClickHouse or GitHub by test-public-canary-report.sh.
#
# A site "passes" when its latest `public` session in the window ended with status `success`.
# A site is the session's `site` column (wikipedia, mdn, govuk, hackernews, python-docs; its scenarios are
# wiki-read, mdn-read, govuk-read, hn-read, pydocs-read).
# The error code comes from the session's first failed action (actions.error_code), the reason from
# sessions.reason.
#
# Issues (only when CANARY_ISSUES=1, otherwise the script just says what it would do):
#   failing site, no open issue "public-site canary: <site> failing"  -> open one
#   failing site, open issue exists                                   -> comment on it
#   passing site, open issue exists                                   -> comment and close it
# A site with NO session in the window gets an issue too (it never ran, or was paused), unless the
# fleet runner itself failed (CANARY_FLEET_OUTCOME != success): then it is an infrastructure problem,
# not a site problem, and the job fails without blaming the sites.
#
# Environment:
#   CLICKHOUSE_URL=http://localhost:8123  CLICKHOUSE_USER  CLICKHOUSE_PASSWORD  CLICKHOUSE_DATABASE
#   CANARY_SITES="wikipedia mdn govuk hackernews python-docs"   the sites that must have run
#   CANARY_WINDOW_MINUTES=120      only sessions that started this recently count
#   CANARY_FLEET_OUTCOME=success   outcome of the `fleet run` step (success | failure | cancelled | ...)
#   CANARY_ISSUES=0                1 = really call gh (needs GH_TOKEN, and GH_REPO outside a checkout)
#   CANARY_RUN_URL                 link to the workflow run, put into every issue
#   CANARY_GH=gh                   the gh command (the test replaces it)
#   CANARY_TSV_FILE                test hook: read the report from this file instead of ClickHouse
# Report columns (TSV, no header): site status error_code reason. An empty error code or reason is "-"
# (bash `read` collapses empty tab-separated fields, so the query never returns an empty one).
set -euo pipefail

url="${CLICKHOUSE_URL:-http://localhost:8123}"
user="${CLICKHOUSE_USER:-fleetscope}"
database="${CLICKHOUSE_DATABASE:-fleetscope}"
sites="${CANARY_SITES:-wikipedia mdn govuk hackernews python-docs}"
window_minutes="${CANARY_WINDOW_MINUTES:-120}"
fleet_outcome="${CANARY_FLEET_OUTCOME:-success}"
issues_on="${CANARY_ISSUES:-0}"
run_url="${CANARY_RUN_URL:-(no run link)}"
gh_cmd="${CANARY_GH:-gh}"

# Latest public session per site in the window (`sessions FINAL`: one row per session, the ended
# one). The error code is the first failed action's. Real sessions only: `sim` data never has target
# `public`, but filtering keeps the canary honest if that ever changes.
read -r -d '' sql <<'SQL' || true
SELECT
    s.site AS site,
    s.status AS status,
    if(ifNull(e.error_code, '') = '', '-', e.error_code) AS error_code,
    if(ifNull(s.reason, '') = '', '-', replaceRegexpAll(s.reason, '[\t\r\n]+', ' ')) AS reason
FROM
(
    SELECT site, session_id, status, reason
    FROM sessions FINAL
    WHERE target = 'public'
      AND source = 'real'
      AND started_at >= now() - INTERVAL {window:UInt32} MINUTE
    ORDER BY started_at DESC
    LIMIT 1 BY site
) AS s
LEFT JOIN
(
    SELECT session_id, argMinIf(error_code, seq, error_code IS NOT NULL) AS error_code
    FROM actions
    WHERE source = 'real'
      AND ts >= now() - INTERVAL {window:UInt32} MINUTE
    GROUP BY session_id
) AS e ON e.session_id = s.session_id
ORDER BY site
FORMAT TSV
SQL

if [ -n "${CANARY_TSV_FILE:-}" ]; then
  report="$(cat "$CANARY_TSV_FILE")"
else
  password="${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD is not set (see .env.example)}"
  if ! report="$(curl --silent --show-error --fail-with-body --max-time 30 \
      --user "${user}:${password}" --data-binary "$sql" \
      "${url}/?database=${database}&param_window=${window_minutes}" 2>&1)"; then
    echo "ERROR: ClickHouse query failed (an infrastructure problem, no issues are opened): ${report}" >&2
    exit 1
  fi
fi

title_of() { printf 'public-site canary: %s failing' "$1"; }

# Open issues, as "number<TAB>title" lines. One call; the title is compared exactly below.
open_issues=""
if [ "$issues_on" = "1" ]; then
  if ! open_issues="$("$gh_cmd" issue list --state open --limit 200 --json number,title \
      --jq '.[] | [.number, .title] | @tsv')"; then
    echo "ERROR: could not list the open issues, so none are opened or closed" >&2
    issues_on=0
  fi
fi

issue_number_for() { # exact title match, first number or nothing
  printf '%s\n' "$open_issues" | awk -F'\t' -v t="$1" '$2 == t { print $1; exit }'
}

# gh problems are warnings: the job is red anyway when a site fails, and a closed-issue hiccup on a
# green day must not hide the green result.
gh_or_warn() {
  "$gh_cmd" "$@" || echo "::warning::gh $1 $2 failed" >&2
}

hint_for() { # what the status / error code means and what to do about it
  case "$1" in
    site_layout) echo "The page loaded but its landmark selector is missing: the site changed its markup. Update the site's descriptor in apps/fleet-runner (landmark selector and fallback) and its saved HTML fixture." ;;
    blocked) echo "The site pushed back (403, 429 or a CAPTCHA). The site is paused for an hour on a real fleet. Do not work around it: decide whether to drop the site (ADR 0007)." ;;
    timeout) echo "The session hit its time limit. Check whether the site is slow or the crawl delay changed in its robots.txt." ;;
    missing) echo "No session was recorded in the canary window. The site may have been skipped (paused after push-back or robots.txt) or the runner never reached it. Read the run log." ;;
    *) echo "See the run log for the details. If the page changed, update the site's descriptor in apps/fleet-runner." ;;
  esac
}

summary="${GITHUB_STEP_SUMMARY:-}"
[ -z "$summary" ] || {
  echo "### Public sites canary"
  echo
  echo "| site | status | error code | reason |"
  echo "|---|---|---|---|"
} >> "$summary"

failed=0
for site in $sites; do
  row="$(printf '%s\n' "$report" | awk -F'\t' -v s="$site" '$1 == s { print; exit }')"
  if [ -z "$row" ]; then
    status=missing code=- reason="no public session recorded in the last ${window_minutes} min"
  else
    IFS=$'\t' read -r _ status code reason <<< "$row"
  fi
  [ "$code" != "-" ] || code=""
  [ "$reason" != "-" ] || reason=""
  title="$(title_of "$site")"
  number="$(issue_number_for "$title")"

  [ -z "$summary" ] || echo "| ${site} | ${status} | ${code:--} | $(printf '%s' "${reason:--}" | cut -c1-200 | tr '|' '/') |" >> "$summary"

  if [ "$status" = "success" ]; then
    echo "OK   ${site}: success"
    if [ -n "$number" ]; then
      echo "     issue #${number} is open for this site: closing it"
      # A red run (runner failure) never closes anything.
      if [ "$issues_on" = "1" ] && [ "$fleet_outcome" = "success" ]; then
        gh_or_warn issue close "$number" --comment "Passing again in ${run_url}. Closing."
      fi
    fi
    continue
  fi

  failed=1
  echo "FAIL ${site}: status=${status} error_code=${code:-none} reason=${reason:-none}" >&2

  if [ "$status" = "missing" ] && [ "$fleet_outcome" != "success" ]; then
    echo "     the fleet runner step ended with '${fleet_outcome}': no issue for ${site}, that is not the site's fault" >&2
    continue
  fi

  # Reason text comes from the site's pages and the browser: keep it short and in a code block.
  short_reason="$(printf '%s' "${reason:-none}" | cut -c1-500)"
  hint="$(hint_for "${code:-$status}")"
  body="$(cat <<EOF
The daily public-sites canary could not complete the journey of \`${site}\` with Chromium.

- **Status:** \`${status}\`
- **Error code:** \`${code:-none}\`
- **Run:** ${run_url}

Reason recorded by the runner:

\`\`\`
${short_reason}
\`\`\`

${hint}

This issue closes by itself when the site passes again. See "Public sites canary" in infra/browsers/README.md.
EOF
)"

  if [ -n "$number" ]; then
    echo "     issue #${number} is already open: commenting"
    [ "$issues_on" != "1" ] || gh_or_warn issue comment "$number" --body "Still failing in ${run_url}"$'\n\n'"${body}"
  else
    echo "     opening an issue: ${title}"
    [ "$issues_on" != "1" ] || gh_or_warn issue create --title "$title" --body "$body"
  fi
done

if [ "$fleet_outcome" != "success" ]; then
  echo "FAIL: the fleet runner step ended with '${fleet_outcome}'" >&2
  failed=1
fi
[ "$issues_on" = "1" ] || echo "(CANARY_ISSUES is not 1: no issue was opened, commented or closed)"
exit "$failed"

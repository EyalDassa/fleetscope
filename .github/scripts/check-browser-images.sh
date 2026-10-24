#!/usr/bin/env bash
# Fails unless the pinned upstream browser images and the forwarder sidecar image carry the same tag
# everywhere they are written down:
#   chromedp/headless-shell:<tag>   lightpanda/browser:<tag>   fleetscope/forwarder:<tag>
# Reference: the uncommented FLEET_BROWSER_IMAGE_CHROME_HEADLESS_SHELL, FLEET_BROWSER_IMAGE_LIGHTPANDA
# and FLEET_FORWARDER_IMAGE lines in .env.example. Checked: package.json (browsers:pull / browsers:build),
# .github/workflows/ci.yml, apps/fleet-runner/src/engines.ts (the runner's defaults), the forwarder
# Dockerfile (comments) and infra/browsers/README.md. Every tag must be exact (no "latest", no range).
# The Chromium image has its own check: check-playwright-version.sh.
#
# Usage: check-browser-images.sh [--strict]
#   A file that does not exist yet (engines.ts is written by another change) is skipped with a warning;
#   with --strict it is an error. CI uses --strict.
# Run it from anywhere; paths are relative to the repo root. BROWSER_CHECK_ROOT overrides the root (tests).
set -euo pipefail

strict=0
case "${1:-}" in
  --strict) strict=1 ;;
  "") ;;
  *) echo "usage: $0 [--strict]" >&2; exit 2 ;;
esac

root="${BROWSER_CHECK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$root"

errors=0
fail() { echo "ERROR: $*" >&2; errors=$((errors + 1)); }

# <env var in .env.example> <image repository>
images=(
  "FLEET_BROWSER_IMAGE_CHROME_HEADLESS_SHELL chromedp/headless-shell"
  "FLEET_BROWSER_IMAGE_LIGHTPANDA lightpanda/browser"
  "FLEET_FORWARDER_IMAGE fleetscope/forwarder"
)
# <file> <repositories it must mention, comma separated>
files=(
  ".env.example chromedp/headless-shell,lightpanda/browser,fleetscope/forwarder"
  "package.json chromedp/headless-shell,lightpanda/browser,fleetscope/forwarder"
  ".github/workflows/ci.yml chromedp/headless-shell,lightpanda/browser,fleetscope/forwarder"
  "apps/fleet-runner/src/engines.ts chromedp/headless-shell,lightpanda/browser,fleetscope/forwarder"
  "infra/browsers/forwarder/Dockerfile fleetscope/forwarder"
  "infra/browsers/README.md chromedp/headless-shell,lightpanda/browser,fleetscope/forwarder"
)

[ -f .env.example ] || { echo "ERROR: .env.example not found" >&2; exit 1; }

declare -A expected
for entry in "${images[@]}"; do
  read -r var repo <<< "$entry"
  value=$(grep -E "^${var}=" .env.example | head -n 1 | cut -d= -f2- | tr -d '[:space:]' || true)
  if [ -z "$value" ]; then
    fail ".env.example has no uncommented ${var}="
    continue
  fi
  case "$value" in
    "${repo}:"*) ;;
    *) fail ".env.example: ${var}=${value} is not an image of ${repo}"; continue ;;
  esac
  tag="${value#"${repo}:"}"
  if ! printf '%s' "$tag" | grep -Eq '^[0-9][A-Za-z0-9._-]*$' || [ "$tag" = "latest" ]; then
    fail ".env.example: ${var}=${value} must be an exact version tag, not '${tag}'"
    continue
  fi
  expected[$repo]="$value"
  echo "pinned:      ${value} (.env.example, ${var})"
done

for entry in "${files[@]}"; do
  read -r file repos <<< "$entry"
  if [ ! -f "$file" ]; then
    if [ "$strict" -eq 1 ]; then
      fail "$file not found (--strict)"
    else
      echo "WARN: $file does not exist yet, skipped (CI runs with --strict)"
    fi
    continue
  fi
  IFS=',' read -ra repo_list <<< "$repos"
  for repo in "${repo_list[@]}"; do
    want="${expected[$repo]:-}"
    [ -n "$want" ] || continue # already reported above
    # A trailing "." or "-" is sentence punctuation, not part of the tag.
    found=$(grep -oE "${repo}:[A-Za-z0-9][A-Za-z0-9._-]*" "$file" | sed -E 's/[.-]+$//' | sort -u || true)
    if [ -z "$found" ]; then
      fail "$file does not mention ${want}"
      continue
    fi
    while IFS= read -r ref; do
      if [ "$ref" = "$want" ]; then
        echo "tag:         $ref ($file)"
      else
        fail "$file has $ref, expected $want"
      fi
    done <<< "$found"
  done
done

if [ "$errors" -ne 0 ]; then
  echo "FAILED: $errors problem(s). The browser image tags must agree everywhere." >&2
  echo "Change them together: .env.example, package.json, .github/workflows/ci.yml, apps/fleet-runner/src/engines.ts, infra/browsers/README.md." >&2
  exit 1
fi
echo "OK: browser image tags are consistent"

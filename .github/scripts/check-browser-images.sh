#!/usr/bin/env bash
# Fails unless the pinned upstream browser images and the forwarder sidecar image are written the
# same way everywhere:
#   chromedp/headless-shell:<tag>@sha256:<digest>   lightpanda/browser:<tag>@sha256:<digest>
#     (tags on Docker Hub are mutable, so the digest of the image index is pinned too; the tag stays
#      for humans. Get a digest with: docker buildx imagetools inspect <image>:<tag>)
#   fleetscope/forwarder:1-<revision>   (revision = ARG IMAGE_REVISION of infra/browsers/forwarder/Dockerfile,
#      bumped whenever that Dockerfile or forward-port.mjs changes)
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

# <env var in .env.example> <image repository> <needs a digest: 1|0>
images=(
  "FLEET_BROWSER_IMAGE_CHROME_HEADLESS_SHELL chromedp/headless-shell 1"
  "FLEET_BROWSER_IMAGE_LIGHTPANDA lightpanda/browser 1"
  "FLEET_FORWARDER_IMAGE fleetscope/forwarder 0"
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
  read -r var repo needs_digest <<< "$entry"
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
  digest=""
  case "$tag" in *@*) digest="${tag#*@}"; tag="${tag%%@*}" ;; esac
  if ! printf '%s' "$tag" | grep -Eq '^[0-9][A-Za-z0-9._-]*$' || [ "$tag" = "latest" ]; then
    fail ".env.example: ${var}=${value} must be an exact version tag, not '${tag}'"
    continue
  fi
  if [ "$needs_digest" -eq 1 ] && ! printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
    fail ".env.example: ${var}=${value} must be pinned by digest too (<tag>@sha256:<64 hex digits>)"
    continue
  fi
  if [ "$needs_digest" -eq 0 ] && [ -n "$digest" ]; then
    fail ".env.example: ${var}=${value} is built by us and must not have a digest"
    continue
  fi
  if [ "$repo" = "fleetscope/forwarder" ]; then
    # tag = 1-<revision>; the revision is the ARG IMAGE_REVISION of the forwarder Dockerfile.
    revision=$(sed -nE 's/^ARG IMAGE_REVISION=([0-9]+)[[:space:]]*$/\1/p' infra/browsers/forwarder/Dockerfile | head -n 1)
    if [ -z "$revision" ]; then
      fail "infra/browsers/forwarder/Dockerfile has no 'ARG IMAGE_REVISION=<n>' line"
      continue
    fi
    if [ "$tag" != "1-${revision}" ]; then
      fail ".env.example: ${var}=${value}: the tag must be 1-${revision} (ARG IMAGE_REVISION=${revision} in infra/browsers/forwarder/Dockerfile)"
      continue
    fi
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
    found=$(grep -oE "${repo}:[A-Za-z0-9][A-Za-z0-9._-]*(@sha256:[0-9a-f]+)?" "$file" | sed -E 's/[.-]+$//' | sort -u || true)

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

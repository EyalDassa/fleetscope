#!/usr/bin/env bash
# Fails unless every place that names the Playwright version agrees:
#   1. the browser image Dockerfile (ARG PLAYWRIGHT_VERSION, and the FROM line that uses it),
#      and `ARG IMAGE_REVISION=<n>`: our image's own revision, so the tag is <version>-<n>,
#   2. the image tag `fleetscope/playwright-chromium:<version>-<n>` in package.json (browsers:build),
#      .env.example (FLEET_BROWSER_IMAGE_CHROMIUM), .github/workflows/ci.yml (fleet smoke job),
#      infra/browsers/README.md, and the runner's built-in default (apps/fleet-runner/src/engines.ts,
#      or config.ts before M3: it is what runs when nobody sets the env var, so a stale one breaks
#      connect() mid-run). The runner files are optional here (warning); with --strict at least one
#      of them must carry the tag.
#   3. the `playwright` / `playwright-core` version pinned in the client packages
#      (apps/fleet-runner and packages/collector).
#
# Why: `chromium.connect()` needs the client and the server on the same Playwright version.
#
# Usage: check-playwright-version.sh [--strict]
#   Without --strict a client package.json that does not exist yet is skipped with a warning
#   (M1 builds the image before the runner and collector exist). With --strict a missing client
#   package, or no client pinning Playwright at all, is an error. CI uses --strict.
# Run it from anywhere; paths are relative to the repo root. PW_CHECK_ROOT overrides the root (tests).
set -euo pipefail

strict=0
case "${1:-}" in
  --strict) strict=1 ;;
  "") ;;
  *) echo "usage: $0 [--strict]" >&2; exit 2 ;;
esac

root="${PW_CHECK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$root"

dockerfile="infra/browsers/chromium/Dockerfile"
image_repo="fleetscope/playwright-chromium"
tag_files=(package.json .env.example .github/workflows/ci.yml infra/browsers/README.md)
runner_files=(apps/fleet-runner/src/engines.ts apps/fleet-runner/src/config.ts)
client_manifests=(apps/fleet-runner/package.json packages/collector/package.json)

errors=0
fail() { echo "ERROR: $*" >&2; errors=$((errors + 1)); }

# --- 1. Dockerfile: the single source of truth ------------------------------------------------
if [ ! -f "$dockerfile" ]; then
  echo "ERROR: $dockerfile not found" >&2
  exit 1
fi

arg_lines=$(grep -E '^ARG PLAYWRIGHT_VERSION=' "$dockerfile" || true)
arg_count=$(printf '%s' "$arg_lines" | grep -c . || true)
if [ "$arg_count" -ne 1 ]; then
  echo "ERROR: expected exactly 1 'ARG PLAYWRIGHT_VERSION=<x.y.z>' line in $dockerfile, found $arg_count" >&2
  exit 1
fi
version="${arg_lines#ARG PLAYWRIGHT_VERSION=}"
version="${version%"${version##*[![:space:]]}"}" # trim trailing whitespace
if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "ERROR: PLAYWRIGHT_VERSION in $dockerfile must be an exact x.y.z version, got '$version'" >&2
  exit 1
fi
echo "Dockerfile:  $version ($dockerfile)"

rev_lines=$(grep -E '^ARG IMAGE_REVISION=' "$dockerfile" || true)
rev_count=$(printf '%s' "$rev_lines" | grep -c . || true)
if [ "$rev_count" -ne 1 ]; then
  echo "ERROR: expected exactly 1 'ARG IMAGE_REVISION=<n>' line in $dockerfile, found $rev_count" >&2
  exit 1
fi
revision="${rev_lines#ARG IMAGE_REVISION=}"
revision="${revision%"${revision##*[![:space:]]}"}"
if ! printf '%s' "$revision" | grep -Eq '^[0-9]+$'; then
  echo "ERROR: IMAGE_REVISION in $dockerfile must be a whole number, got '$revision'" >&2
  exit 1
fi
image_tag="${version}-${revision}"
echo "Image tag:   ${image_repo}:${image_tag}"

# The base image must be built from the same version (otherwise the browsers would not match).
from_count=$(grep -cE '^FROM mcr\.microsoft\.com/playwright:v\$\{PLAYWRIGHT_VERSION\}-[a-z]+' "$dockerfile" || true)
if [ "$from_count" -ne 1 ]; then
  fail "$dockerfile: the FROM line must be 'mcr.microsoft.com/playwright:v\${PLAYWRIGHT_VERSION}-<distro>'"
fi

# --- 2. Image tag everywhere it is written down -----------------------------------------------
# Prints the image tags a file names; fails the check on any tag that is not the expected one.
check_tags() {
  local file="$1" tags tag
  tags=$(grep -oE "${image_repo}:[A-Za-z0-9._-]+" "$file" | sort -u || true)
  if [ -z "$tags" ]; then
    return 1
  fi
  while IFS= read -r tag; do
    if [ "$tag" = "${image_repo}:${image_tag}" ]; then
      echo "image tag:   $tag ($file)"
    else
      fail "$file has image tag $tag, expected ${image_repo}:${image_tag}"
    fi
  done <<< "$tags"
}

for file in "${tag_files[@]}"; do
  if [ ! -f "$file" ]; then
    fail "$file not found"
  elif ! check_tags "$file"; then
    fail "$file does not mention the image tag ${image_repo}:${image_tag}"
  fi
done

# The runner's defaults: engines.ts arrives with M3 (config.ts held DEFAULT_BROWSER_IMAGE before).
runner_tagged=0
for file in "${runner_files[@]}"; do
  [ -f "$file" ] || continue
  if check_tags "$file"; then runner_tagged=1; fi
done
if [ "$runner_tagged" -eq 0 ]; then
  if [ "$strict" -eq 1 ]; then
    fail "none of ${runner_files[*]} names the image tag ${image_repo}:${image_tag} (--strict)"
  else
    echo "WARN: no runner file with the image tag yet (${runner_files[*]}), skipped (CI runs with --strict)"
  fi
fi

# --- 3. Client packages -----------------------------------------------------------------------
# Prints "<dependency section> <name> <spec>" for playwright and playwright-core in a package.json.
pinned_specs() {
  node -e '
    const fs = require("node:fs");
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of ["playwright", "playwright-core"]) {
        const spec = (pkg[section] || {})[name];
        if (spec !== undefined) process.stdout.write(section + " " + name + " " + spec + "\n");
      }
    }
  ' "$1"
}

pinned_somewhere=0
for manifest in "${client_manifests[@]}"; do
  if [ ! -f "$manifest" ]; then
    if [ "$strict" -eq 1 ]; then
      fail "$manifest not found (--strict)"
    else
      echo "WARN: $manifest does not exist yet, skipped (CI runs with --strict)"
    fi
    continue
  fi
  specs=$(pinned_specs "$manifest")
  if [ -z "$specs" ]; then
    echo "note: $manifest has no playwright / playwright-core dependency"
    continue
  fi
  while read -r section name spec; do
    if [ "$spec" = "$version" ]; then
      echo "client:      $name@$spec ($manifest, $section)"
      pinned_somewhere=1
    else
      fail "$manifest: $section.$name is '$spec', expected the exact version '$version' (no ^ or ~: client and server must match)"
    fi
  done <<< "$specs"
done

if [ "$strict" -eq 1 ] && [ "$pinned_somewhere" -eq 0 ]; then
  fail "no client package pins playwright / playwright-core to $version (--strict)"
fi

if [ "$errors" -ne 0 ]; then
  echo "FAILED: $errors problem(s). The Playwright client and the browser image must use the same version." >&2
  echo "Change them together: $dockerfile, package.json, .env.example, .github/workflows/ci.yml, infra/browsers/README.md, the runner defaults and the client package.json files." >&2
  exit 1
fi
echo "OK: Playwright version $version, image tag ${image_repo}:${image_tag} are consistent"

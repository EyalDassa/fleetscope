#!/usr/bin/env bash
# Fails unless the ClickHouse image tag in the compose file and in the CI workflow are identical.
# The CI workflow has one service container per job that needs ClickHouse, so it may name the image
# several times; all of those lines must carry the same tag.
# Usage: check-clickhouse-tag.sh [compose-file] [ci-file]
set -euo pipefail

compose_file="${1:-infra/docker-compose.yml}"
ci_file="${2:-.github/workflows/ci.yml}"
pattern='^[[:space:]]+image:[[:space:]]+clickhouse/clickhouse-server:'

# Prints the one image reference used in a file. Fails if there is none or the lines disagree.
find_image() {
  local file="$1" images count
  images=$(grep -E "$pattern" "$file" | awk '{print $2}' | sort -u || true)
  count=$(printf '%s' "$images" | grep -c . || true)
  if [ "$count" -ne 1 ]; then
    echo "ERROR: expected one distinct clickhouse-server image in $file, found $count:" >&2
    printf '%s\n' "$images" >&2
    return 1
  fi
  printf '%s\n' "$images"
}

compose=$(find_image "$compose_file")
ci=$(find_image "$ci_file")
echo "compose: $compose"
echo "ci:      $ci"

if [ "$compose" != "$ci" ]; then
  echo "ERROR: ClickHouse image tags differ. Edit $compose_file and $ci_file together." >&2
  exit 1
fi
echo "OK: tags match"

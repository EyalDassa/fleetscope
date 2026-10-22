#!/usr/bin/env bash
# Fails unless the ClickHouse image tag in the compose file and in the CI workflow are identical.
# Usage: check-clickhouse-tag.sh [compose-file] [ci-file]
set -euo pipefail

compose_file="${1:-infra/docker-compose.yml}"
ci_file="${2:-.github/workflows/ci.yml}"
pattern='^[[:space:]]+image:[[:space:]]+clickhouse/clickhouse-server:'

# Prints the image reference found in a file, or nothing. Exactly one match is required.
find_image() {
  local file="$1" matches count
  matches=$(grep -E "$pattern" "$file" || true)
  count=$(printf '%s' "$matches" | grep -c . || true)
  if [ "$count" -ne 1 ]; then
    echo "ERROR: expected exactly 1 clickhouse-server image line in $file, found $count" >&2
    return 1
  fi
  printf '%s\n' "$matches" | awk '{print $2}'
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

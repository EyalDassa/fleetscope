#!/usr/bin/env bash
# Waits until a URL answers with a 2xx status, or fails after a timeout.
# Usage: wait-for-url.sh <url> [timeout-seconds=60] [log-file-to-print-on-failure]
set -euo pipefail

url="${1:?usage: $0 <url> [timeout-seconds] [log-file]}"
timeout_s="${2:-60}"
log_file="${3:-}"

deadline=$((SECONDS + timeout_s))
until curl --silent --fail --max-time 2 --output /dev/null "$url"; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "ERROR: $url did not answer with 2xx within ${timeout_s}s" >&2
    if [ -n "$log_file" ] && [ -f "$log_file" ]; then
      echo "--- last 50 lines of $log_file" >&2
      tail -n 50 "$log_file" >&2
    fi
    exit 1
  fi
  sleep 1
done
echo "OK: $url is up (${SECONDS}s since the script started)"

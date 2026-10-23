#!/usr/bin/env bash
# Fails if a shell script under .github/ or infra/ is stored in git without the executable bit.
#
# Why: the owner commits from Windows, where git records new files as 100644. A script that the
# image or a CI step runs directly (not as `bash script.sh`) then fails on Linux with
# "Permission denied". Fix a file with:
#   git update-index --chmod=+x path/to/script.sh      (an existing, tracked file)
#   git add --chmod=+x path/to/script.sh               (a new file)
# Usage: check-executable-bits.sh        (run it from the repository root)
set -euo pipefail

# `*` in a git pathspec also matches `/`, so these cover every depth.
bad=$(git ls-files --stage -- '.github/*.sh' 'infra/*.sh' | awk '$1 != "100755" { print $1 "  " $4 }')

if [ -n "$bad" ]; then
  echo "ERROR: these shell scripts are not executable in git (mode shown first, expected 100755):" >&2
  printf '%s\n' "$bad" >&2
  echo "Fix: git update-index --chmod=+x <file>   (then commit)" >&2
  exit 1
fi

count=$(git ls-files -- '.github/*.sh' 'infra/*.sh' | grep -c . || true)
echo "OK: all ${count} shell scripts under .github/ and infra/ are executable in git"

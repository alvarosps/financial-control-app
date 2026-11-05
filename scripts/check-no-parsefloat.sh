#!/usr/bin/env bash
# Guard against re-introducing parseFloat in money-sensitive code paths.
# Runs in CI and as a pre-commit hook. Exit 1 on any hit.
set -euo pipefail

HITS=$(grep -rn "parseFloat" packages/api/src/services/ packages/domain/src/ 2>/dev/null \
  | grep -v "\.test\.ts:" || true)

if [ -n "$HITS" ]; then
  echo "ERROR: parseFloat is forbidden in services/domain (use Money)."
  echo "$HITS"
  exit 1
fi

echo "No parseFloat found in services/domain. OK."

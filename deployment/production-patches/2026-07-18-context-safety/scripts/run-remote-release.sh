#!/usr/bin/env bash
set -Eeuo pipefail

release_commit="${1:?release commit is required}"
release_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

test -n "$release_commit"
test -f "$release_dir/scripts/deploy.sh"
test -f "$release_dir/scripts/test-release.py"

python3 "$release_dir/scripts/test-release.py"
PREFLIGHT_ONLY=true RELEASE_COMMIT="$release_commit" \
  bash "$release_dir/scripts/deploy.sh" "$release_dir"
RELEASE_COMMIT="$release_commit" bash "$release_dir/scripts/deploy.sh" "$release_dir"

printf 'release_commit=%s\n' "$release_commit"
cat "$release_dir/DEPLOY_RESULT.txt"

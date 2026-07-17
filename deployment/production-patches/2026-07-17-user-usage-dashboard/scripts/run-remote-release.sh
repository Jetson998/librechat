#!/usr/bin/env bash
set -Eeuo pipefail
stage_dir="${1:-/tmp/librechat-user-usage-dashboard}"
release_commit="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
test -d "$stage_dir/api" && test -d "$stage_dir/client" && test -d "$stage_dir/scripts"
RELEASE_COMMIT="$release_commit" bash "$stage_dir/scripts/deploy.sh" "$stage_dir"

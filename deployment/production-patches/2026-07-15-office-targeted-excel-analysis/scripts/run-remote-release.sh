#!/usr/bin/env bash
set -Eeuo pipefail

release_commit="${1:?release commit is required}"
repository="https://github.com/Jetson998/librechat.git"
stage_parent="$(mktemp -d /tmp/librechat-office-targeted-analysis.XXXXXX)"
checkout="$stage_parent/repository"
release_dir="$checkout/deployment/production-patches/2026-07-15-office-targeted-excel-analysis"

git clone --filter=blob:none --no-checkout "$repository" "$checkout"
git -C "$checkout" checkout --detach "$release_commit"
test "$(git -C "$checkout" rev-parse HEAD)" = "$release_commit"

node "$release_dir/scripts/test-release.js"
PREFLIGHT_ONLY=true "$release_dir/scripts/deploy.sh" "$release_dir"
"$release_dir/scripts/deploy.sh" "$release_dir"

cat "$release_dir/DEPLOY_RESULT.txt"

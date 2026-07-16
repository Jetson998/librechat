#!/usr/bin/env bash
set -Eeuo pipefail

release_commit="${1:?usage: scripts/run-remote-release.sh <commit-sha>}"
repository="https://github.com/Jetson998/librechat.git"
stage_parent="/tmp/librechat-odysseia-login-$release_commit"
checkout="$stage_parent/repository"
release_dir="$checkout/deployment/production-patches/2026-07-17-odysseia-login-page"

rm -rf "$stage_parent"
mkdir -p "$stage_parent"
git clone --filter=blob:none --no-checkout "$repository" "$checkout"
git -C "$checkout" checkout --detach "$release_commit"
test "$(git -C "$checkout" rev-parse HEAD)" = "$release_commit"

python3 "$release_dir/scripts/test-odysseia-login-release.py"
PREFLIGHT_ONLY=true "$release_dir/scripts/deploy-odysseia-login.sh" "$release_dir"
"$release_dir/scripts/deploy-odysseia-login.sh" "$release_dir"

cat "$release_dir/DEPLOY_RESULT.txt"

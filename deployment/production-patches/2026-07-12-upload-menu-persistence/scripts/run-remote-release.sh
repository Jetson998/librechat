#!/usr/bin/env bash
set -Eeuo pipefail

repository="https://github.com/Jetson998/librechat.git"
release_commit="dfbe7a431c2635729858ff62decbadc0deb95b14"
stage_parent="/tmp/librechat-upload-menu-$release_commit"
checkout="$stage_parent/repository"
release_dir="$checkout/deployment/production-patches/2026-07-12-upload-menu-persistence"

rm -rf "$stage_parent"
mkdir -p "$stage_parent"
git clone --filter=blob:none --no-checkout "$repository" "$checkout"
git -C "$checkout" checkout --detach "$release_commit"
test "$(git -C "$checkout" rev-parse HEAD)" = "$release_commit"

python3 "$release_dir/scripts/test-upload-menu-release.py"
python3 "$checkout/deployment/production-patches/2026-07-11-admin-panel/scripts/test-admin-panel-release.py"
PREFLIGHT_ONLY=true "$release_dir/scripts/deploy-upload-menu.sh" "$release_dir"
"$release_dir/scripts/deploy-upload-menu.sh" "$release_dir"

cat "$release_dir/DEPLOY_RESULT.txt"

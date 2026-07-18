#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(git rev-parse --show-toplevel)"
revision="${RELEASE_COMMIT:-$(git rev-parse HEAD)}"
short_revision="${revision:0:12}"
output_dir="${OUTPUT_DIR:-/private/tmp}"
archive="$output_dir/librechat-model-market-layout-$short_revision.tar.gz"

git -C "$repo_root" diff --quiet "$revision" -- \
  deployment/production-patches/2026-07-17-user-usage-dashboard/client \
  deployment/production-patches/2026-07-17-user-usage-dashboard/scripts/test-client-release.py \
  deployment/production-patches/2026-07-17-user-usage-dashboard/scripts/deploy.sh \
  deployment/production-patches/2026-07-19-model-market-layout

git -C "$repo_root" archive --format=tar.gz --output="$archive" "$revision" -- \
  deployment/production-patches/2026-07-17-user-usage-dashboard/client \
  deployment/production-patches/2026-07-17-user-usage-dashboard/scripts/test-client-release.py \
  deployment/production-patches/2026-07-17-user-usage-dashboard/scripts/deploy.sh \
  deployment/production-patches/2026-07-19-model-market-layout

printf 'release_commit=%s\narchive=%s\nsha256=%s\n' \
  "$revision" "$archive" "$(shasum -a 256 "$archive" | awk '{print $1}')"

#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
release_dir="$repo_root/deployment/production-patches/2026-07-11-admin-panel-zh-cn"
source_dir="$release_dir/source"

command -v bun >/dev/null
test "$(bun --version)" = "1.3.11"
"$release_dir/scripts/verify-source.sh"
cd "$source_dir"
bun install --frozen-lockfile
"$repo_root/.github/scripts/admin-panel-quality-gate.sh"

printf 'admin_panel_ci_preflight=ok\nsource_hash=%s\n' "$(cat "$release_dir/SOURCE_TREE_SHA256")"

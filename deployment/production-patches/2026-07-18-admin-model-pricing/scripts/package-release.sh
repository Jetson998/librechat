#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
release_dir="$repo_root/deployment/production-patches/2026-07-18-admin-model-pricing"
admin_source="$repo_root/deployment/production-patches/2026-07-11-admin-panel-zh-cn/source"
output="${1:-/tmp/librechat-admin-model-pricing-release.tgz}"
pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/admin-model-pricing-pack.XXXXXX")"
trap 'rm -rf "$pack_dir"' EXIT

mkdir -p "$pack_dir/release/scripts"
cp -a "$admin_source" "$pack_dir/release/admin-panel-source"
cp -a "$release_dir/README.md" "$pack_dir/release/README.md"
cp -a "$release_dir/scripts/build-and-deploy.sh" "$pack_dir/release/scripts/build-and-deploy.sh"
cp -a "$release_dir/scripts/test-release.py" "$pack_dir/release/scripts/test-release.py"
tar -czf "$output" -C "$pack_dir/release" .
shasum -a 256 "$output"

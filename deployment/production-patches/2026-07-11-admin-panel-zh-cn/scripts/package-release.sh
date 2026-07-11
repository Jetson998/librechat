#!/usr/bin/env bash
set -Eeuo pipefail

release_dir="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
release_name="$(basename "$release_dir")"
release_root_name="librechat-admin-panel-zh-cn-release"
release_parent="$(dirname "$release_dir")"
output_dir="${OUTPUT_DIR:-/tmp}"
default_suffix="$(git -C "$release_dir" rev-parse --short HEAD 2>/dev/null || printf '%s' "$(date +%Y%m%d%H%M%S)")"
archive_path="${ARCHIVE_PATH:-$output_dir/${release_root_name}-${default_suffix}.tar.gz}"
verify_dir="${VERIFY_DIR:-$output_dir/${release_root_name}-${default_suffix}-verify}"

test -d "$release_dir"
mkdir -p "$output_dir"
rm -f "$archive_path"
rm -rf "$verify_dir"
pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/admin-panel-release-pack.XXXXXX")"
trap 'rm -rf "$pack_dir"' EXIT

cp -R "$release_dir" "$pack_dir/$release_root_name"

(
  cd "$pack_dir"
  tar -czf "$archive_path" "$release_root_name"
)

mkdir -p "$verify_dir"
tar -xzf "$archive_path" -C "$verify_dir"

stage_dir="$verify_dir/$release_root_name"
test -d "$stage_dir"
REQUIRE_CI_ATTESTATION=true "$stage_dir/scripts/verify-source.sh"
"$stage_dir/scripts/verify-ci-attestation.sh" "$stage_dir" >/dev/null

printf 'archive_path=%s\narchive_sha256=%s\nverify_dir=%s\n' \
  "$archive_path" \
  "$(shasum -a 256 "$archive_path" | awk '{print $1}')" \
  "$verify_dir"

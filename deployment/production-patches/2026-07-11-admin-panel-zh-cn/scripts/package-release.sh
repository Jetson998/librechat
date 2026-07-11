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
metadata_path="${METADATA_PATH:-$output_dir/${release_root_name}-${default_suffix}.env}"

test -d "$release_dir"
command -v rsync >/dev/null
mkdir -p "$output_dir"
rm -f "$archive_path"
rm -rf "$verify_dir"
rm -f "$metadata_path"
pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/admin-panel-release-pack.XXXXXX")"
trap 'rm -rf "$pack_dir"' EXIT

COPYFILE_DISABLE=1 rsync -a \
  --exclude '.DS_Store' \
  --exclude '._*' \
  "$release_dir/" "$pack_dir/$release_root_name/"

(
  cd "$pack_dir"
  COPYFILE_DISABLE=1 tar -czf "$archive_path" "$release_root_name"
)

mkdir -p "$verify_dir"
tar -xzf "$archive_path" -C "$verify_dir"

stage_dir="$verify_dir/$release_root_name"
test -d "$stage_dir"
REQUIRE_CI_ATTESTATION=true "$stage_dir/scripts/verify-source.sh"
"$stage_dir/scripts/verify-ci-attestation.sh" "$stage_dir" >/dev/null

archive_sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
cat >"$metadata_path" <<EOF
LOCAL_TARBALL=$archive_path
TARBALL_SHA256=$archive_sha256
VERIFY_DIR=$verify_dir
EOF

printf 'archive_path=%s\narchive_sha256=%s\nverify_dir=%s\n' \
  "$archive_path" \
  "$archive_sha256" \
  "$verify_dir"
printf 'metadata_path=%s\n' "$metadata_path"

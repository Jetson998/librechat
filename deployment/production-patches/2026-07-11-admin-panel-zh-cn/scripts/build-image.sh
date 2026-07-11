#!/usr/bin/env bash
set -Eeuo pipefail

release_dir="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
source_dir="$release_dir/source"
image_ref="$(cat "$release_dir/IMAGE_REF")"
expected_source_hash="$(cat "$release_dir/SOURCE_TREE_SHA256")"
actual_source_hash="$(python3 "$release_dir/scripts/source-tree-hash.py" "$source_dir")"

test "$(uname -m)" = "x86_64"
test "$actual_source_hash" = "$expected_source_hash"
"$release_dir/scripts/verify-source.sh"

docker build \
  --build-arg "MODIFIED_SOURCE_REVISION=$expected_source_hash" \
  --tag "$image_ref" \
  "$source_dir"

image_id="$(docker image inspect "$image_ref" --format '{{.Id}}')"
architecture="$(docker image inspect "$image_ref" --format '{{.Architecture}}')"
label_revision="$(docker image inspect "$image_ref" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
test "$architecture" = "amd64"
test "$label_revision" = "$expected_source_hash"

printf '%s\n' "$image_id" >"$release_dir/BUILT_IMAGE_ID"
cat >"$release_dir/BUILD_RESULT.txt" <<EOF
image_ref=$image_ref
image_id=$image_id
architecture=$architecture
source_tree_sha256=$expected_source_hash
upstream_revision=$(cat "$release_dir/UPSTREAM_REVISION")
EOF

printf 'image_ref=%s\nimage_id=%s\nsource_tree_sha256=%s\n' \
  "$image_ref" "$image_id" "$expected_source_hash"

#!/usr/bin/env bash
set -Eeuo pipefail

release_dir="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
source_dir="$release_dir/source"
image_ref="$(cat "$release_dir/IMAGE_REF")"
expected_source_hash="$(cat "$release_dir/SOURCE_TREE_SHA256")"
actual_source_hash="$(python3 "$release_dir/scripts/source-tree-hash.py" "$source_dir")"
build_memory="${BUILD_MEMORY:-1280m}"
build_cpu_quota="${BUILD_CPU_QUOTA:-75000}"
build_timeout="${BUILD_TIMEOUT:-45m}"
builder_name="librechat-admin-zh-cn-$$"

test "$(uname -m)" = "x86_64"
test "$actual_source_hash" = "$expected_source_hash"
command -v timeout >/dev/null
docker buildx version >/dev/null
REQUIRE_CI_ATTESTATION=true "$release_dir/scripts/verify-source.sh"

ci_verified_commit="$(cat "$release_dir/CI_VERIFIED_COMMIT")"
ci_verified_tag="$(cat "$release_dir/CI_VERIFIED_TAG")"
ci_verified_run="$(cat "$release_dir/CI_VERIFIED_RUN")"

cleanup_builder() {
  docker buildx rm --force "$builder_name" >/dev/null 2>&1 || true
}
trap cleanup_builder EXIT

# Isolate the exact CI-attested application build from production workloads.
docker buildx create \
  --name "$builder_name" \
  --driver docker-container \
  --driver-opt "memory=$build_memory" \
  --driver-opt "memory-swap=$build_memory" \
  --driver-opt "cpu-period=100000" \
  --driver-opt "cpu-quota=$build_cpu_quota" >/dev/null
docker buildx inspect --bootstrap "$builder_name" >/dev/null

timeout --foreground "$build_timeout" docker buildx build \
  --builder "$builder_name" \
  --load \
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
ci_verified_commit=$ci_verified_commit
ci_verified_tag=$ci_verified_tag
ci_verified_run=$ci_verified_run
build_memory=$build_memory
build_cpu_quota=$build_cpu_quota
build_timeout=$build_timeout
EOF

printf 'image_ref=%s\nimage_id=%s\nsource_tree_sha256=%s\n' \
  "$image_ref" "$image_id" "$expected_source_hash"

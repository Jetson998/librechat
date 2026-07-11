#!/bin/sh
set -eu

release_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_dir="$release_dir/source"
expected_revision="64bc4b6151894b080694f5953f7b31aa99bc2cc4"
expected_archive_sha256="70701ece1f255d18829282f8620006954c878907a7f5f22f92bc44410eb62900"
expected_source_hash="$(cat "$release_dir/SOURCE_TREE_SHA256")"

test "$(cat "$release_dir/UPSTREAM_REVISION")" = "$expected_revision"
test "$(cat "$release_dir/UPSTREAM_ARCHIVE_SHA256")" = "$expected_archive_sha256"
test -f "$source_dir/LICENSE"
test -f "$source_dir/bun.lock"
test -f "$source_dir/src/locales/zh-Hans/translation.json"
test -f "$source_dir/scripts/sort-imports.ts"
grep -Fqx '!scripts/sort-imports.ts' "$source_dir/.dockerignore"
grep -Fq '"lint:strict": "eslint src/ --max-warnings 0"' "$source_dir/package.json"
test "$(python3 "$release_dir/scripts/source-tree-hash.py" "$source_dir")" = "$expected_source_hash"

node "$source_dir/scripts/check-locales.mjs"
python3 "$release_dir/scripts/scan-release-secrets.py" "$release_dir"

echo "Verified pinned Admin Panel source and localization release."

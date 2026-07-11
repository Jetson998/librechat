#!/bin/sh
set -eu

release_dir="${1:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
source_hash="$(cat "$release_dir/SOURCE_TREE_SHA256")"
verified_source_hash="$(cat "$release_dir/CI_VERIFIED_SOURCE_SHA256")"
verified_commit="$(cat "$release_dir/CI_VERIFIED_COMMIT")"
verified_tag="$(cat "$release_dir/CI_VERIFIED_TAG")"
verified_run="$(cat "$release_dir/CI_VERIFIED_RUN")"
expected_tag="admin-ci-$(printf '%.12s' "$source_hash")"

test "$verified_source_hash" = "$source_hash"
test "$verified_tag" = "$expected_tag"
test "${#verified_commit}" -eq 40
case "$verified_commit" in
  *[!0-9a-f]*) exit 1 ;;
esac
case "$verified_run" in
  ''|*[!0-9]*) exit 1 ;;
esac

printf 'ci_verified_source_sha256=%s\nci_verified_commit=%s\nci_verified_tag=%s\nci_verified_run=%s\n' \
  "$verified_source_hash" "$verified_commit" "$verified_tag" "$verified_run"

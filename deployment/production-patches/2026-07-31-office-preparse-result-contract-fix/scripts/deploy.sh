#!/usr/bin/env bash
# release-governance:scoped-deployment
# release-governance:targets=LibreChat-API
# release-governance:target-lock
set -Eeuo pipefail

source_revision="${1:?source revision is required}"
host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
patch_root="deployment/production-patches/2026-07-31-office-preparse-result-contract-fix"
remote_stage="/tmp/librechat-office-preparse-result-contract-fix-${source_revision:0:12}-$$"
repo_root="$(git rev-parse --show-toplevel)"

if [[ ! "$source_revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "source revision must be a full 40-character commit SHA" >&2
  exit 2
fi

resolved_revision="$(git -C "$repo_root" rev-parse --verify "${source_revision}^{commit}")"
if [[ "$resolved_revision" != "$source_revision" ]]; then
  echo "source revision does not resolve to the requested commit" >&2
  exit 2
fi

artifact_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$artifact_dir"
}
trap cleanup EXIT

git -C "$repo_root" archive "$source_revision" \
  "$patch_root/office-context-patch/InitializationFailure.js" \
  "$patch_root/office-context-patch/OfficePreparse.js" \
  "$patch_root/office-context-patch/request.js" \
  "$patch_root/scripts/remote-apply.sh" |
  tar -x -C "$artifact_dir"

artifact_root="$artifact_dir/$patch_root"
for file in \
  "$artifact_root/office-context-patch/InitializationFailure.js" \
  "$artifact_root/office-context-patch/OfficePreparse.js" \
  "$artifact_root/office-context-patch/request.js" \
  "$artifact_root/scripts/remote-apply.sh"; do
  test -f "$file"
done

ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 \
  "$user@$host" "mkdir -p '$remote_stage' && chmod 700 '$remote_stage'"

scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -- \
  "$artifact_root/office-context-patch/InitializationFailure.js" \
  "$artifact_root/office-context-patch/OfficePreparse.js" \
  "$artifact_root/office-context-patch/request.js" \
  "$artifact_root/scripts/remote-apply.sh" \
  "$user@$host:$remote_stage/"

ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 \
  "$user@$host" \
  "chmod 700 '$remote_stage/remote-apply.sh' && '$remote_stage/remote-apply.sh' '$remote_stage' '$source_revision'"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DIR="${1:-/private/tmp/librechat-upstream}"
PIN="60eba76375213dafc1874d943e41371201c300ab"
SOURCE_PATH="api/server/controllers/agents/request.js"
SOURCE_BLOB="49d9329f0ce7778cb108cdc70ca18aed4c8ec0eb"
PATCH_PATH="$ROOT_DIR/integrations/librechat-upstream/$PIN/controller-runtime-bridge.patch"
VERIFY_DIR="$(mktemp -d /private/tmp/librechat-file-agent-overlay.XXXXXX)"

cleanup() {
  git -C "$UPSTREAM_DIR" worktree remove --force "$VERIFY_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

test "$(git -C "$UPSTREAM_DIR" rev-parse "$PIN")" = "$PIN"
test "$(git -C "$UPSTREAM_DIR" rev-parse "$PIN:$SOURCE_PATH")" = "$SOURCE_BLOB"
test -f "$PATCH_PATH"

git -C "$UPSTREAM_DIR" worktree add --detach "$VERIFY_DIR" "$PIN" >/dev/null
git -C "$VERIFY_DIR" apply --unidiff-zero --check "$PATCH_PATH"
git -C "$VERIFY_DIR" apply --unidiff-zero "$PATCH_PATH"
git -C "$VERIFY_DIR" diff --check
node --check "$VERIFY_DIR/$SOURCE_PATH"

test "$(rg -c 'const sendPromise = client\.sendMessage' "$VERIFY_DIR/$SOURCE_PATH")" = "1"
test "$(rg -c 'fileAgentRuntime = null' "$VERIFY_DIR/$SOURCE_PATH")" = "2"
test "$(rg -c 'Runtime owns file task completion' "$VERIFY_DIR/$SOURCE_PATH")" = "1"
test "$(git -C "$VERIFY_DIR" diff --name-only | wc -l | tr -d ' ')" = "1"
test "$(git -C "$VERIFY_DIR" diff --name-only)" = "$SOURCE_PATH"

printf 'upstream_pin=%s\n' "$PIN"
printf 'source_blob=%s\n' "$SOURCE_BLOB"
printf 'overlay_check=passed\n'

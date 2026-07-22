#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
source_dir="$repo_root/deployment/production-patches/2026-07-11-admin-panel-zh-cn/source"

cd "$source_dir"
bun run locales:check
bun run format:check:baseline
bun run sort-imports:check:baseline
bun run lint:strict
bun run typecheck
NODE_ENV=test SESSION_SECRET=ci-test-secret-do-not-use-in-production bun run test
bun run build

#!/usr/bin/env bash
set -Eeuo pipefail

release_dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

test -f "$release_dir/README.md"
test -f "$release_dir/scripts/deploy.sh"
test -f "$release_dir/scripts/test-release.py"

python3 "$release_dir/scripts/test-release.py"
exec bash "$release_dir/scripts/deploy.sh" "$release_dir"

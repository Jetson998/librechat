#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$#" -ne 1 ]]; then
  echo "Usage: scripts/release-status.sh <release-id>" >&2
  exit 2
fi
exec python3 \
  "$root_dir/skills/lightweight-release-governance/scripts/release_gate.py" \
  checkpoint-status \
  --config "$root_dir/release-governance.json" \
  --release-id "$1"

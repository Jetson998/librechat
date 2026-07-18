#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

export PYTHONPYCACHEPREFIX="${PYTHONPYCACHEPREFIX:-/tmp/librechat-release-gate-pycache}"

python3 -m py_compile \
  skills/lightweight-release-governance/scripts/release_gate.py \
  scripts/librechat-release-adapter.py

bash -n \
  scripts/release-prepare.sh \
  scripts/release-verify.sh \
  scripts/release-package.sh \
  scripts/release-attest.sh \
  scripts/release-preflight.sh \
  scripts/release-deploy.sh \
  scripts/release-acceptance.sh \
  scripts/release-finalize.sh \
  scripts/release-status.sh \
  scripts/validate-release-governance.sh

python3 skills/lightweight-release-governance/scripts/release_gate.py \
  validate-config --config release-governance.json

python3 -m unittest discover \
  -s tests/release-governance \
  -p 'test_*.py' \
  -v

validator="${CODEX_SKILL_VALIDATOR:-/Users/jets2026/.codex/skills/.system/skill-creator/scripts/quick_validate.py}"
if [[ -f "$validator" ]]; then
  python3 "$validator" skills/lightweight-release-governance
  python3 "$validator" skills/librechat-release-governance
else
  echo "skill_validator=skipped reason=not_available"
fi

git diff --check
echo "release_governance_validation=passed"

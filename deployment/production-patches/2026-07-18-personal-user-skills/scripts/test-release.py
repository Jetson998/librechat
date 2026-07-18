#!/usr/bin/env python3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[2]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


deploy = (ROOT / "scripts" / "deploy.sh").read_text(encoding="utf-8")
runner = (ROOT / "scripts" / "run-remote-release.sh").read_text(encoding="utf-8")
readme = (ROOT / "README.md").read_text(encoding="utf-8")
plan = (REPO / "docs" / "PERSONAL_USER_SKILLS_RESTORE_PLAN.md").read_text(
    encoding="utf-8"
)

for marker in (
    'expected_endpoints="anthropic"',
    'target_endpoints="anthropic,agents"',
    'docker compose up -d --no-deps --force-recreate api',
    'ENDPOINTS=<normalized>',
    'office-document-parser/SKILL.md',
    'role_documents_sha',
    'PREFLIGHT_ONLY',
    'rollback()',
    'DEPLOY_RESULT.txt',
):
    require(marker in deploy, f"deployment marker missing: {marker}")

for forbidden in (
    "docker compose down",
    "docker compose restart",
    "MANAGE_SKILLS",
    "READ_SKILLS",
    "db.roles.update",
    "db.roles.replace",
    "librechat.yaml.next",
):
    require(forbidden not in deploy, f"forbidden deployment content: {forbidden}")

require(deploy.count('target_endpoints="anthropic,agents"') == 1,
        "target ENDPOINTS value must have one source of truth")
require('expected_env_sha="42ae4dc3f69618ff4a4304aeac268f3adc93d648148cbf0716e00ae141439b2a"' in deploy,
        "production .env baseline missing")
require('expected_office_skill_sha="29bfde2a0442b0c4013ecea4d58858e6d779b562e47057eb4237d2f22b93285a"' in deploy,
        "Office deployment Skill baseline missing")
require('expected_compose_override_sha="__EXPECTED_COMPOSE_OVERRIDE_SHA__"' not in deploy,
        "Compose override baseline placeholder was not resolved")

for marker in (
    "personal Skills discovery path",
    "ENDPOINTS=anthropic,agents",
    "normal `USER`",
    "second normal user",
):
    require(marker in readme, f"README marker missing: {marker}")

for marker in (
    "SKILLS.USE: true",
    "SKILLS.CREATE: true",
    "SKILL_OWNER",
    "Other users' private Skills must not appear",
    "ENDPOINTS=anthropic,agents",
):
    require(marker in plan, f"plan marker missing: {marker}")

require("deploy.sh" in runner and "test-release.py" in runner,
        "remote runner must execute tests and deployment")

print("personal user Skills release tests passed")

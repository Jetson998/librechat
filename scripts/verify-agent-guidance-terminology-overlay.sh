#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${1:?usage: verify-agent-guidance-terminology-overlay.sh SOURCE_DIR [SOURCE_ARCHIVE]}"
SOURCE_ARCHIVE="${2:-}"
PIN="8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9"
INTEGRATION_DIR="$ROOT_DIR/integrations/librechat-upstream/$PIN"
MANIFEST="$INTEGRATION_DIR/agent-guidance-terminology.sources.json"
PATCH_PATH="$INTEGRATION_DIR/agent-guidance-terminology.patch"
VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/librechat-agent-guidance-terminology.XXXXXX")"

cleanup() {
  rm -rf "$VERIFY_DIR"
}
trap cleanup EXIT

if [[ -n "$SOURCE_ARCHIVE" ]]; then
  "$ROOT_DIR/scripts/verify-preset-agent-contact-visibility-overlay.sh" \
    "$SOURCE_DIR" "$SOURCE_ARCHIVE"
else
  "$ROOT_DIR/scripts/verify-preset-agent-contact-visibility-overlay.sh" "$SOURCE_DIR"
fi

python3 - "$ROOT_DIR" "$MANIFEST" "$PATCH_PATH" <<'PY'
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys


root, manifest_path, patch_path = map(Path, sys.argv[1:])
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))


def fail(message: str) -> None:
    raise SystemExit(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


for overlay in manifest["base_overlays"]:
    base_manifest = root / overlay["manifest"]
    base_patch = root / overlay["patch"]
    if sha256(base_manifest) != overlay["manifest_sha256"]:
        fail(f"base overlay manifest hash mismatch: {overlay['integration_id']}")
    if sha256(base_patch) != overlay["patch_sha256"]:
        fail(f"base overlay patch hash mismatch: {overlay['integration_id']}")

if sha256(patch_path) != manifest["patch"]["sha256"]:
    fail("Agent guidance terminology patch hash mismatch")

paths = subprocess.run(
    ["git", "apply", "--numstat", str(patch_path)],
    cwd=root,
    check=True,
    text=True,
    capture_output=True,
).stdout.splitlines()
patch_paths = sorted(line.split("\t", 2)[2] for line in paths if line.strip())
manifest_paths = sorted(entry["path"] for entry in manifest["files"])
if patch_paths != manifest_paths:
    fail("Agent guidance patch changed-file list differs from source manifest")

for entry in manifest["runtime_overlay_guard"]["files"]:
    path = root / entry["path"]
    if not path.is_file() or sha256(path) != entry["sha256"]:
        fail(f"Runtime Connector overlay guard failed: {entry['path']}")

print(f"agent_guidance_patch_sha256={manifest['patch']['sha256']}")
print(f"agent_guidance_changed_files={len(manifest_paths)}")
PY

tar -C "$SOURCE_DIR" \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=client/dist \
  -cf - . | tar -C "$VERIFY_DIR" -xf -

git -C "$VERIFY_DIR" init -q
git -C "$VERIFY_DIR" config user.name "LibreChat Overlay Verifier"
git -C "$VERIFY_DIR" config user.email "overlay-verifier@invalid.local"
git -C "$VERIFY_DIR" add -f -A
git -C "$VERIFY_DIR" commit -q -m "pinned upstream baseline"

BASE_PATCH="$INTEGRATION_DIR/agent-platform-p0-ui.patch"
SIDEBAR_PATCH="$INTEGRATION_DIR/agent-sidebar-menu-state.patch"
CONTACT_PATCH="$INTEGRATION_DIR/preset-agent-contact-visibility.patch"

git -C "$VERIFY_DIR" apply --check --whitespace=error-all "$BASE_PATCH"
git -C "$VERIFY_DIR" apply --index --whitespace=error-all "$BASE_PATCH"
git -C "$VERIFY_DIR" commit -q -m "base Agent platform overlay"
git -C "$VERIFY_DIR" apply --check --whitespace=error-all "$SIDEBAR_PATCH"
git -C "$VERIFY_DIR" apply --index --whitespace=error-all "$SIDEBAR_PATCH"
git -C "$VERIFY_DIR" commit -q -m "Agent sidebar overlay"
git -C "$VERIFY_DIR" apply --check --whitespace=error-all "$CONTACT_PATCH"
git -C "$VERIFY_DIR" apply --index --whitespace=error-all "$CONTACT_PATCH"
git -C "$VERIFY_DIR" commit -q -m "preset Agent contact visibility overlay"

python3 - "$VERIFY_DIR" "$MANIFEST" <<'PY'
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys


verify_dir, manifest_path = map(Path, sys.argv[1:])
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))


def fail(message: str) -> None:
    raise SystemExit(message)


for entry in manifest["files"]:
    path = verify_dir / entry["path"]
    if entry["status"] == "added":
        if path.exists():
            fail(f"Agent guidance file already exists in base overlays: {entry['path']}")
        continue
    if not path.is_file():
        fail(f"Agent guidance base file is missing: {entry['path']}")
    actual = subprocess.run(
        ["git", "-C", str(verify_dir), "hash-object", str(path)],
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    if actual != entry["base_blob"]:
        fail(
            f"Agent guidance base blob mismatch for {entry['path']}: "
            f"expected={entry['base_blob']} actual={actual}"
        )
PY

git -C "$VERIFY_DIR" apply --check --whitespace=error-all "$PATCH_PATH"
git -C "$VERIFY_DIR" apply --index --whitespace=error-all "$PATCH_PATH"
git -C "$VERIFY_DIR" diff --cached --check

python3 - "$VERIFY_DIR" "$MANIFEST" "$ROOT_DIR" <<'PY'
from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys


verify_dir, manifest_path, root = map(Path, sys.argv[1:])
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))


def fail(message: str) -> None:
    raise SystemExit(message)


changed = subprocess.run(
    ["git", "-C", str(verify_dir), "diff", "--cached", "--name-only"],
    check=True,
    text=True,
    capture_output=True,
).stdout.splitlines()
expected_paths = sorted(entry["path"] for entry in manifest["files"])
if sorted(changed) != expected_paths:
    fail(f"Agent guidance applied file list mismatch: {changed}")

for entry in manifest["files"]:
    path = verify_dir / entry["path"]
    if not path.is_file():
        fail(f"Agent guidance patched source file is missing: {entry['path']}")
    actual = subprocess.run(
        ["git", "-C", str(verify_dir), "hash-object", str(path)],
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    if actual != entry["result_blob"]:
        fail(
            f"Agent guidance result blob mismatch for {entry['path']}: "
            f"expected={entry['result_blob']} actual={actual}"
        )

starter_source = (
    verify_dir / "client/src/components/Chat/Input/ConversationStarters.tsx"
).read_text(encoding="utf-8")
constant_match = re.search(
    r"const PRESET_AGENT_CONVERSATION_STARTERS:[^=]+ = \{(.*?)\n\};",
    starter_source,
    re.DOTALL,
)
if constant_match is None:
    fail("preset Agent conversation starter fallback is missing")
constant_body = constant_match.group(1)

compiled = json.loads(
    (root / "workflow-templates/preset-agents/compiled-agents.json").read_text(encoding="utf-8")
)
agents = compiled.get("agents", [])
if len(agents) != 7:
    fail("compiled preset Agent contract no longer contains exactly seven Agents")

expected_ids = {agent["id"] for agent in agents}
actual_ids = set(re.findall(r"^\s*'([^']+)': \[", constant_body, re.MULTILINE))
if actual_ids != expected_ids:
    fail(f"preset conversation starter ID mismatch: {sorted(actual_ids)}")

for agent in agents:
    agent_id = agent["id"]
    block = re.search(
        rf"'{re.escape(agent_id)}': \[(.*?)\n\s*\],",
        constant_body,
        re.DOTALL,
    )
    if block is None:
        fail(f"missing conversation starter block for {agent_id}")
    actual_starters = re.findall(r"'([^']*)'", block.group(1))
    if actual_starters != agent.get("conversation_starters", []):
        fail(f"conversation starters differ from compiled Agent source: {agent_id}")

if starter_source.index("if (entity?.conversation_starters?.length)") > starter_source.index(
    "if (isAgent)"
):
    fail("configured Agent starters no longer take priority over the preset fallback")

for marker in (
    "role={isAgent ? 'group' : undefined}",
    "com_agents_conversation_starters_heading",
    "PRESET_AGENT_CONVERSATION_STARTERS[entity?.id ?? ''] ?? []",
):
    if marker not in starter_source:
        fail(f"conversation starter contract marker is missing: {marker}")

category_files = (
    "client/src/components/Agents/AgentCard.tsx",
    "client/src/components/Agents/AgentGrid.tsx",
    "client/src/components/Agents/CategoryTabs.tsx",
    "client/src/components/Agents/Marketplace.tsx",
)
for relative in category_files:
    text = (verify_dir / relative).read_text(encoding="utf-8")
    if "automation-workflow" not in text or "com_agents_category_agent" not in text:
        fail(f"preset workflow category is not mapped to Agent in {relative}")

en = json.loads((verify_dir / "client/src/locales/en/translation.json").read_text(encoding="utf-8"))
zh = json.loads(
    (verify_dir / "client/src/locales/zh-Hans/translation.json").read_text(encoding="utf-8")
)
expected_zh = {
    "com_agents_category_agent": "Agent",
    "com_agents_top_picks": "精选 Agent",
    "com_agents_recommended": "按常见任务场景精选的 Agent",
    "com_agents_conversation_starters_heading": "可以这样开始",
    "com_nav_tool_dialog_agents_description": "必须保存 Agent 才能保留工具选择。",
}
for key, expected in expected_zh.items():
    if zh.get(key) != expected:
        fail(f"Simplified Chinese Agent terminology mismatch: {key}")
if en.get("com_nav_tool_dialog_agents_description") != (
    "Agent must be saved to persist tool selections."
):
    fail("English Agent tool description is not Agent-specific")

legacy_entries = {
    key: value
    for key, value in zh.items()
    if "agent" in key.lower()
    and isinstance(value, str)
    and re.search(r"助手|智能体|自动化工作流", value)
}
if legacy_entries:
    fail(f"legacy terminology remains in Agent-specific locale keys: {sorted(legacy_entries)}")

tool_dialog = (
    verify_dir / "client/src/components/Tools/AssistantToolsDialog.tsx"
).read_text(encoding="utf-8")
if "com_nav_tool_dialog_agents_description" not in tool_dialog:
    fail("Agent tool dialog does not select the Agent-specific description")

starter_test = (
    verify_dir
    / "client/src/components/Chat/Input/__tests__/ConversationStarters.spec.tsx"
).read_text(encoding="utf-8")
for marker in (
    "does not invent guidance for a non-preset Agent",
    "preserves model-spec starters outside the Agent endpoint",
    "keeps an Agent own configured starters ahead of the preset fallback",
):
    if marker not in starter_test:
        fail(f"conversation starter regression marker is missing: {marker}")

if list(verify_dir.rglob("*.rej")):
    fail("Agent guidance patch application produced reject files")

print("agent_guidance_patch_check=passed")
print("preset_conversation_starters_contract=passed")
print("agent_terminology_contract=passed")
print("runtime_overlay_guard=passed")
PY

printf 'agent_guidance_terminology_overlay_check=passed\n'

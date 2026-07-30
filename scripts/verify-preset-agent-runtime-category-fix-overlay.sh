#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${1:?usage: verify-preset-agent-runtime-category-fix-overlay.sh SOURCE_DIR [SOURCE_ARCHIVE]}"
SOURCE_ARCHIVE="${2:-}"
PIN="8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9"
INTEGRATION_DIR="$ROOT_DIR/integrations/librechat-upstream/$PIN"
MANIFEST="$INTEGRATION_DIR/preset-agent-runtime-category-fix.sources.json"
PATCH_PATH="$INTEGRATION_DIR/preset-agent-runtime-category-fix.patch"
VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/librechat-preset-agent-runtime-category.XXXXXX")"

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
    fail("preset Agent runtime/category patch hash mismatch")

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
    fail("runtime/category patch changed-file list differs from source manifest")

for entry in manifest["runtime_overlay_guard"]["files"]:
    path = root / entry["path"]
    if not path.is_file() or sha256(path) != entry["sha256"]:
        fail(f"Runtime Connector overlay guard failed: {entry['path']}")

print(f"preset_agent_runtime_category_patch_sha256={manifest['patch']['sha256']}")
print(f"preset_agent_runtime_category_changed_files={len(manifest_paths)}")
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

for patch_name in \
  agent-platform-p0-ui \
  agent-sidebar-menu-state \
  preset-agent-contact-visibility \
  agent-guidance-terminology; do
  base_patch="$INTEGRATION_DIR/$patch_name.patch"
  git -C "$VERIFY_DIR" apply --check --whitespace=error-all "$base_patch"
  git -C "$VERIFY_DIR" apply --index --whitespace=error-all "$base_patch"
  git -C "$VERIFY_DIR" commit -q -m "$patch_name overlay"
done

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
    if not path.is_file():
        fail(f"runtime/category base file is missing: {entry['path']}")
    actual = subprocess.run(
        ["git", "-C", str(verify_dir), "hash-object", str(path)],
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    if actual != entry["base_blob"]:
        fail(
            f"runtime/category base blob mismatch for {entry['path']}: "
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
    fail(f"runtime/category applied file list mismatch: {changed}")

for entry in manifest["files"]:
    path = verify_dir / entry["path"]
    actual = subprocess.run(
        ["git", "-C", str(verify_dir), "hash-object", str(path)],
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    if actual != entry["result_blob"]:
        fail(
            f"runtime/category result blob mismatch for {entry['path']}: "
            f"expected={entry['result_blob']} actual={actual}"
        )

compiled = json.loads(
    (root / "workflow-templates/preset-agents/compiled-agents.json").read_text(encoding="utf-8")
)
agents = compiled.get("agents", [])
if len(agents) != 7:
    fail("compiled preset Agent contract no longer contains exactly seven Agents")

expected_ids = {agent["id"] for agent in agents}
legacy_ids = {agent.get("legacyId") for agent in agents}
if any(not agent_id.startswith("agent_workflow_") for agent_id in expected_ids):
    fail("compiled Agent IDs do not use the persistent agent_ prefix")
if any(not isinstance(agent_id, str) or not agent_id.startswith("workflow_") for agent_id in legacy_ids):
    fail("compiled legacy Agent IDs are incomplete")
if len(expected_ids) != 7 or len(legacy_ids) != 7:
    fail("compiled Agent ID mapping is not one-to-one")

contact_source = (verify_dir / "client/src/components/Agents/AgentContact.tsx").read_text(
    encoding="utf-8"
)
contact_match = re.search(
    r"const HIDDEN_CONTACT_AGENT_IDS = new Set\(\[(.*?)\]\);",
    contact_source,
    re.DOTALL,
)
if contact_match is None:
    fail("hidden contact Agent set is missing")
contact_ids = set(re.findall(r"'([^']+)'", contact_match.group(1)))
if contact_ids != expected_ids:
    fail(f"hidden contact Agent IDs differ from compiled IDs: {sorted(contact_ids)}")

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
starter_ids = set(re.findall(r"^\s*'([^']+)': \[", constant_body, re.MULTILINE))
if starter_ids != expected_ids:
    fail(f"conversation starter Agent IDs differ from compiled IDs: {sorted(starter_ids)}")
for agent in agents:
    block = re.search(
        rf"'{re.escape(agent['id'])}': \[(.*?)\n\s*\],",
        constant_body,
        re.DOTALL,
    )
    if block is None:
        fail(f"missing conversation starter block for {agent['id']}")
    if re.findall(r"'([^']*)'", block.group(1)) != agent.get("conversation_starters", []):
        fail(f"conversation starters differ from compiled Agent source: {agent['id']}")

marketplace_source = (verify_dir / "client/src/components/Agents/Marketplace.tsx").read_text(
    encoding="utf-8"
)
for marker in (
    "filterRedundantAgentCategories",
    "businessCategories.length === 1",
    "businessCategories[0].count === allCategory.count",
    "categories={visibleCategories}",
):
    if marker not in marketplace_source:
        fail(f"category de-duplication contract marker is missing: {marker}")

marketplace_test = (
    verify_dir / "client/src/components/Agents/tests/MarketplaceWorkspace.spec.tsx"
).read_text(encoding="utf-8")
for marker in (
    "hides the only business category when it duplicates all results",
    "keeps business category tabs when multiple categories contain results",
):
    if marker not in marketplace_test:
        fail(f"category regression test marker is missing: {marker}")

parser_source = (verify_dir / "packages/data-provider/src/parsers.ts").read_text(encoding="utf-8")
if "return !agentId?.startsWith('agent_');" not in parser_source:
    fail("LibreChat persistent Agent ID contract changed upstream")

if list(verify_dir.rglob("*.rej")):
    fail("runtime/category patch application produced reject files")

print("preset_agent_runtime_id_contract=passed")
print("preset_agent_category_dedup_contract=passed")
print("preset_agent_runtime_category_overlay_check=passed")
PY

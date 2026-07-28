#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${1:?usage: verify-agent-sidebar-menu-state-overlay.sh SOURCE_DIR [SOURCE_ARCHIVE]}"
SOURCE_ARCHIVE="${2:-}"
PIN="8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9"
INTEGRATION_DIR="$ROOT_DIR/integrations/librechat-upstream/$PIN"
BASE_PATCH="$INTEGRATION_DIR/agent-platform-p0-ui.patch"
MANIFEST="$INTEGRATION_DIR/agent-sidebar-menu-state.sources.json"
PATCH_PATH="$INTEGRATION_DIR/agent-sidebar-menu-state.patch"
VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/librechat-agent-sidebar-menu.XXXXXX")"

cleanup() {
  rm -rf "$VERIFY_DIR"
}
trap cleanup EXIT

if [[ -n "$SOURCE_ARCHIVE" ]]; then
  "$ROOT_DIR/scripts/verify-agent-platform-p0-ui-overlay.sh" "$SOURCE_DIR" "$SOURCE_ARCHIVE"
else
  "$ROOT_DIR/scripts/verify-agent-platform-p0-ui-overlay.sh" "$SOURCE_DIR"
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


base = manifest["base_overlay"]
base_manifest = root / base["manifest"]
base_patch = root / base["patch"]
if sha256(base_manifest) != base["manifest_sha256"]:
    fail("base Agent UI manifest hash mismatch")
if sha256(base_patch) != base["patch_sha256"]:
    fail("base Agent UI patch hash mismatch")
if sha256(patch_path) != manifest["patch"]["sha256"]:
    fail("Agent sidebar menu patch hash mismatch")

numstat = subprocess.run(
    ["git", "apply", "--numstat", str(patch_path)],
    cwd=root,
    check=True,
    text=True,
    capture_output=True,
).stdout.splitlines()
patch_paths = sorted(line.split("\t", 2)[2] for line in numstat if line.strip())
manifest_paths = sorted(entry["path"] for entry in manifest["files"])
if patch_paths != manifest_paths:
    fail("follow-up patch changed-file list differs from source manifest")

for entry in manifest["runtime_overlay_guard"]["files"]:
    path = root / entry["path"]
    if not path.is_file() or sha256(path) != entry["sha256"]:
        fail(f"Runtime Connector overlay guard failed: {entry['path']}")

print(f"base_patch_sha256={base['patch_sha256']}")
print(f"follow_up_patch_sha256={manifest['patch']['sha256']}")
print(f"follow_up_changed_files={len(manifest_paths)}")
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

git -C "$VERIFY_DIR" apply --check --whitespace=error-all "$BASE_PATCH"
git -C "$VERIFY_DIR" apply --index --whitespace=error-all "$BASE_PATCH"
git -C "$VERIFY_DIR" commit -q -m "base Agent P0 UI overlay"

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
            fail(f"follow-up file already exists in base overlay: {entry['path']}")
        continue
    if not path.is_file():
        fail(f"base overlay file is missing: {entry['path']}")
    actual = subprocess.run(
        ["git", "-C", str(verify_dir), "hash-object", str(path)],
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    if actual != entry["base_blob"]:
        fail(
            f"base overlay blob mismatch for {entry['path']}: "
            f"expected={entry['base_blob']} actual={actual}"
        )
PY

git -C "$VERIFY_DIR" apply --check --whitespace=error-all "$PATCH_PATH"
git -C "$VERIFY_DIR" apply --index --whitespace=error-all "$PATCH_PATH"
git -C "$VERIFY_DIR" diff --cached --check

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


changed = subprocess.run(
    ["git", "-C", str(verify_dir), "diff", "--cached", "--name-only"],
    check=True,
    text=True,
    capture_output=True,
).stdout.splitlines()
expected = sorted(entry["path"] for entry in manifest["files"])
if sorted(changed) != expected:
    fail(f"applied follow-up changed-file list mismatch: {changed}")

for entry in manifest["files"]:
    path = verify_dir / entry["path"]
    if not path.is_file():
        fail(f"patched source file is missing: {entry['path']}")
    actual = subprocess.run(
        ["git", "-C", str(verify_dir), "hash-object", str(path)],
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    if actual != entry["result_blob"]:
        fail(
            f"follow-up blob mismatch for {entry['path']}: "
            f"expected={entry['result_blob']} actual={actual}"
        )

contracts = {
    "client/src/Providers/ActivePanelContext.tsx": ("link.isActive === true",),
    "client/src/components/SidePanel/Nav.tsx": ("link.Component != null",),
    "client/src/components/UnifiedSidebar/ExpandedPanel.tsx": (
        "link.isActive === undefined",
        "link.onClick?.(e)",
    ),
    "client/src/hooks/Nav/useUnifiedSidebarLinks.ts": (
        "isActive: isAgentWorkspaceRoute",
        "location.pathname.startsWith('/agents/')",
    ),
    "client/src/locales/agentWorkspaceLocales.spec.ts": (
        "uses Agent as the workspace product name in both locales",
    ),
    "client/src/locales/en/translation.json": ('"com_agents_workspace": "Agent"',),
    "client/src/locales/zh-Hans/translation.json": ('"com_agents_workspace": "Agent"',),
}
for relative, markers in contracts.items():
    text = (verify_dir / relative).read_text(encoding="utf-8")
    for marker in markers:
        if marker not in text:
            fail(f"sidebar state contract marker missing from {relative}: {marker}")

if list(verify_dir.rglob("*.rej")):
    fail("follow-up patch application produced reject files")

print("base_overlay_blob_check=passed")
print("follow_up_patch_check=passed")
print("sidebar_state_contract_check=passed")
print("runtime_overlay_guard=passed")
PY

printf 'agent_sidebar_menu_state_overlay_check=passed\n'

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${1:?usage: verify-preset-agent-contact-visibility-overlay.sh SOURCE_DIR [SOURCE_ARCHIVE]}"
SOURCE_ARCHIVE="${2:-}"
PIN="8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9"
INTEGRATION_DIR="$ROOT_DIR/integrations/librechat-upstream/$PIN"
MANIFEST="$INTEGRATION_DIR/preset-agent-contact-visibility.sources.json"
PATCH_PATH="$INTEGRATION_DIR/preset-agent-contact-visibility.patch"
VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/librechat-agent-contact-visibility.XXXXXX")"

cleanup() {
  rm -rf "$VERIFY_DIR"
}
trap cleanup EXIT

if [[ -n "$SOURCE_ARCHIVE" ]]; then
  "$ROOT_DIR/scripts/verify-agent-sidebar-menu-state-overlay.sh" "$SOURCE_DIR" "$SOURCE_ARCHIVE"
else
  "$ROOT_DIR/scripts/verify-agent-sidebar-menu-state-overlay.sh" "$SOURCE_DIR"
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
    fail("preset Agent contact visibility patch hash mismatch")

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
    fail("contact visibility patch changed-file list differs from source manifest")

for entry in manifest["runtime_overlay_guard"]["files"]:
    path = root / entry["path"]
    if not path.is_file() or sha256(path) != entry["sha256"]:
        fail(f"Runtime Connector overlay guard failed: {entry['path']}")

print(f"contact_visibility_patch_sha256={manifest['patch']['sha256']}")
print(f"contact_visibility_changed_files={len(manifest_paths)}")
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
git -C "$VERIFY_DIR" apply --check --whitespace=error-all "$BASE_PATCH"
git -C "$VERIFY_DIR" apply --index --whitespace=error-all "$BASE_PATCH"
git -C "$VERIFY_DIR" commit -q -m "base Agent platform overlay"
git -C "$VERIFY_DIR" apply --check --whitespace=error-all "$SIDEBAR_PATCH"
git -C "$VERIFY_DIR" apply --index --whitespace=error-all "$SIDEBAR_PATCH"
git -C "$VERIFY_DIR" commit -q -m "Agent sidebar overlay"

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
        fail(f"contact visibility base file is missing: {entry['path']}")
    actual = subprocess.run(
        ["git", "-C", str(verify_dir), "hash-object", str(path)],
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    if actual != entry["base_blob"]:
        fail(
            f"contact visibility base blob mismatch for {entry['path']}: "
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
    fail(f"contact visibility applied file list mismatch: {changed}")

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
            f"contact visibility result blob mismatch for {entry['path']}: "
            f"expected={entry['result_blob']} actual={actual}"
        )

contact_source = (verify_dir / "client/src/components/Agents/AgentContact.tsx").read_text(
    encoding="utf-8"
)
for agent_id in [
    "workflow_meeting-to-action",
    "workflow_knowledge-base-curator",
    "workflow_excel-audit-reconciliation",
    "workflow_policy-change-impact",
    "workflow_feedback-root-cause-analysis",
    "workflow_kyc-periodic-review",
    "workflow_journal-entry-audit",
]:
    if agent_id not in contact_source:
        fail(f"hidden preset Agent ID missing from contact component: {agent_id}")
if "return null;" not in contact_source:
    fail("contact component does not suppress the hidden row")
if "workflow_custom-agent" not in (
    verify_dir / "client/src/components/Agents/tests/AgentContact.spec.tsx"
).read_text(encoding="utf-8"):
    fail("exact-ID regression test is missing")

print("contact_visibility_patch_check=passed")
print("contact_visibility_contract=passed")
PY

printf 'preset_agent_contact_visibility_overlay_check=passed\n'

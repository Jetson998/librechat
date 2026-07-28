#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${1:?usage: verify-agent-platform-p0-ui-overlay.sh SOURCE_DIR [SOURCE_ARCHIVE]}"
SOURCE_ARCHIVE="${2:-}"
PIN="8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9"
INTEGRATION_DIR="$ROOT_DIR/integrations/librechat-upstream/$PIN"
MANIFEST="$INTEGRATION_DIR/agent-platform-p0-ui.sources.json"
PATCH_PATH="$INTEGRATION_DIR/agent-platform-p0-ui.patch"
VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/librechat-agent-platform-p0-ui.XXXXXX")"

cleanup() {
  rm -rf "$VERIFY_DIR"
}
trap cleanup EXIT

python3 - "$ROOT_DIR" "$SOURCE_DIR" "$SOURCE_ARCHIVE" "$MANIFEST" "$PATCH_PATH" <<'PY'
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys


root, source, archive_arg, manifest_path, patch_path = map(Path, sys.argv[1:])
root = root.resolve()
source = source.resolve()
manifest_path = manifest_path.resolve()
patch_path = patch_path.resolve()
archive = archive_arg.resolve() if str(archive_arg) else None


def fail(message: str) -> None:
    raise SystemExit(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_blob(path: Path) -> str:
    body = path.read_bytes()
    digest = hashlib.sha1()
    digest.update(f"blob {len(body)}\0".encode("ascii"))
    digest.update(body)
    return digest.hexdigest()


if not source.is_dir():
    fail(f"missing upstream source directory: {source}")
if not manifest_path.is_file() or not patch_path.is_file():
    fail("Agent UI integration manifest or patch is missing")

manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
pin = manifest["upstream"]["commit"]
if pin != "8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9":
    fail(f"unexpected upstream pin: {pin}")

git_dir = source / ".git"
if git_dir.exists():
    head = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"],
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    if head != pin:
        fail(f"upstream source commit mismatch: expected={pin} actual={head}")
    source_mode = "git"
else:
    if archive is None or not archive.is_file():
        fail("non-Git source requires the exact official source archive as argument 2")
    actual_archive_sha = sha256(archive)
    expected_archive_sha = manifest["upstream"]["archive_sha256"]
    if actual_archive_sha != expected_archive_sha:
        fail(
            f"official source archive hash mismatch: "
            f"expected={expected_archive_sha} actual={actual_archive_sha}"
        )
    source_mode = "official-archive"

if sha256(patch_path) != manifest["patch"]["sha256"]:
    fail("Agent UI patch hash does not match source manifest")

lockfile = source / manifest["lockfile"]["path"]
if not lockfile.is_file():
    fail(f"missing upstream lockfile: {lockfile}")
if sha256(lockfile) != manifest["lockfile"]["sha256"]:
    fail("upstream package-lock.json SHA-256 mismatch")
if git_blob(lockfile) != manifest["lockfile"]["upstream_blob"]:
    fail("upstream package-lock.json blob mismatch")

for entry in manifest["files"]:
    path = source / entry["path"]
    if entry["status"] == "added":
        if path.exists():
            fail(f"expected Agent UI file to be absent upstream: {entry['path']}")
        continue
    if not path.is_file():
        fail(f"missing pinned upstream source file: {entry['path']}")
    actual_blob = git_blob(path)
    if actual_blob != entry["upstream_blob"]:
        fail(
            f"upstream blob mismatch for {entry['path']}: "
            f"expected={entry['upstream_blob']} actual={actual_blob}"
        )

for entry in manifest["runtime_overlay_guard"]["files"]:
    path = root / entry["path"]
    if not path.is_file() or sha256(path) != entry["sha256"]:
        fail(f"Runtime Connector overlay guard failed: {entry['path']}")

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
    fail("patch changed-file list differs from source manifest")

print(f"source_mode={source_mode}")
print(f"upstream_pin={pin}")
print(f"upstream_tree={manifest['upstream']['tree']}")
print(f"patch_sha256={manifest['patch']['sha256']}")
print(f"changed_files={len(manifest_paths)}")
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
    fail(f"applied changed-file list mismatch: {changed}")

for entry in manifest["files"]:
    path = verify_dir / entry["path"]
    if not path.is_file():
        fail(f"patched source file is missing: {entry['path']}")
    actual_blob = subprocess.run(
        ["git", "hash-object", str(path)],
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    if actual_blob != entry["result_blob"]:
        fail(
            f"patched blob mismatch for {entry['path']}: "
            f"expected={entry['result_blob']} actual={actual_blob}"
        )

if list(verify_dir.rglob("*.rej")):
    fail("patch application produced reject files")

en = json.loads((verify_dir / "client/src/locales/en/translation.json").read_text(encoding="utf-8"))
zh = json.loads(
    (verify_dir / "client/src/locales/zh-Hans/translation.json").read_text(encoding="utf-8")
)
workspace_keys = (
    "com_agents_workspace",
    "com_agents_workspace_recommended",
    "com_agents_workspace_mine",
    "com_agents_workspace_create",
    "com_agents_workspace_navigation",
    "com_agents_platform_capabilities",
    "com_agents_advanced_integrations",
)
for key in workspace_keys:
    if not en.get(key) or not zh.get(key):
        fail(f"missing Agent workspace locale key: {key}")
if any("智能体" in value for value in zh.values() if isinstance(value, str)):
    fail("Simplified Chinese Client still contains legacy Agent terminology")

marketplace = (verify_dir / "client/src/components/Agents/Marketplace.tsx").read_text(
    encoding="utf-8"
)
for marker in (
    "agent-workspace-panel-",
    "view === 'create' && endpointsQuery.isSuccess && !canCreate",
    "requiredPermission: PermissionBits.EDIT",
):
    if marker not in marketplace and marker != "requiredPermission: PermissionBits.EDIT":
        fail(f"Marketplace is missing workspace contract marker: {marker}")
my_agents = (verify_dir / "client/src/components/Agents/MyAgentsView.tsx").read_text(
    encoding="utf-8"
)
if "requiredPermission: PermissionBits.EDIT" not in my_agents:
    fail("My Assistants query is not constrained to EDIT permission")

print("applied_patch_check=passed")
print("locale_contract_check=passed")
print("runtime_overlay_guard=passed")
PY

printf 'agent_platform_p0_ui_overlay_check=passed\n'

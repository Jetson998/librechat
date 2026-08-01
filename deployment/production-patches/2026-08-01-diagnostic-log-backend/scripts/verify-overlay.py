#!/usr/bin/env python3
"""Replay and verify the diagnostic-log development overlays without mutation."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "SOURCE_MANIFEST.json"


def run(*args: str, cwd: Path | None = None, capture: bool = True) -> str:
    result = subprocess.run(
        list(args),
        cwd=cwd,
        check=True,
        text=True,
        capture_output=capture,
    )
    return result.stdout.strip() if capture else ""


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git_blob(path: Path) -> str:
    content = path.read_bytes()
    header = f"blob {len(content)}\0".encode("ascii")
    return hashlib.sha1(header + content).hexdigest()


def require_file(path: Path) -> None:
    if not path.is_file():
        raise RuntimeError(f"missing file: {path}")


def verify_file(path: Path, expected: dict, label: str) -> None:
    require_file(path)
    actual = {
        "result_blob": git_blob(path),
        "sha256": sha256(path),
        "bytes": path.stat().st_size,
    }
    for key in actual:
        if actual[key] != expected[key]:
            raise RuntimeError(
                f"{label} mismatch for {expected['path']}: "
                f"{key} expected={expected[key]} actual={actual[key]}"
            )


def verify_base(path: Path, expected: dict, label: str) -> None:
    if expected["base_blob"] is None:
        if path.exists():
            raise RuntimeError(f"{label} expected a new file but found: {path}")
        return
    require_file(path)
    actual = git_blob(path)
    if actual != expected["base_blob"]:
        raise RuntimeError(
            f"{label} base blob mismatch for {expected['path']}: "
            f"expected={expected['base_blob']} actual={actual}"
        )


def copy_overlay(overlay_root: Path, destination_root: Path, entries: list[dict], label: str) -> None:
    for entry in entries:
        source = overlay_root / entry["path"]
        destination = destination_root / entry["path"]
        verify_base(destination, entry, label)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        verify_file(destination, entry, label)


def archive_git_revision(repo: Path, destination: Path, revision: str = "HEAD") -> None:
    archive = subprocess.run(
        ["git", "-C", str(repo), "archive", revision],
        check=True,
        capture_output=True,
    ).stdout
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        tar.extractall(destination)


def archive_governance_base(repo: Path, manifest: dict, destination: Path) -> None:
    expected_revision = manifest["bases"]["admin_and_governance"]["repository_revision"]
    run("git", "-C", str(repo), "cat-file", "-e", f"{expected_revision}^{{commit}}")
    archive_git_revision(repo, destination, expected_revision)


def stage_backend_mounts(
    governance_base: Path, replay_root: Path, entries: list[dict]
) -> None:
    for entry in entries:
        source = governance_base / entry["source"]
        verify_file(source, entry, "backend production mount source")
        destination = replay_root / entry["path"]
        verify_base(destination, entry, "backend production mount")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        verify_file(destination, entry, "backend production mount")


def verify_backend(
    source: Path, manifest: dict, replay_root: Path, governance_base: Path
) -> None:
    expected_revision = manifest["bases"]["backend"]["local_revision"]
    actual_revision = run("git", "-C", str(source), "rev-parse", "HEAD")
    if actual_revision != expected_revision:
        raise RuntimeError(f"backend revision mismatch: expected={expected_revision} actual={actual_revision}")
    if run("git", "-C", str(source), "status", "--porcelain"):
        raise RuntimeError("backend source must be clean for replay")

    replay_root.mkdir(parents=True, exist_ok=True)
    archive_git_revision(source, replay_root, expected_revision)
    stage_backend_mounts(
        governance_base,
        replay_root,
        manifest.get("backend_mounted_base", []),
    )
    copy_overlay(ROOT / "backend" / "overlay", replay_root, manifest["backend_overlay"], "backend")


def verify_admin(source: Path, manifest: dict, replay_root: Path) -> None:
    if not source.is_dir():
        raise RuntimeError(f"Admin source directory does not exist: {source}")

    expected_revision = manifest["bases"]["admin_and_governance"]["repository_revision"]
    repo_root = Path(run("git", "-C", str(source), "rev-parse", "--show-toplevel"))
    source_prefix = run("git", "-C", str(source), "rev-parse", "--show-prefix")
    expected_source_path = manifest["bases"]["admin_and_governance"].get("admin_source_path")
    if expected_source_path and source_prefix.rstrip("/") != expected_source_path:
        raise RuntimeError(
            f"Admin source path mismatch: expected={expected_source_path} actual={source_prefix}"
        )
    run("git", "-C", str(repo_root), "cat-file", "-e", f"{expected_revision}^{{commit}}")
    if run(
        "git",
        "-C",
        str(repo_root),
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        source_prefix,
    ):
        raise RuntimeError("Admin source must be clean for replay")
    comparison = subprocess.run(
        ["git", "-C", str(repo_root), "diff", "--quiet", expected_revision, "--", source_prefix],
        check=False,
    )
    if comparison.returncode != 0:
        raise RuntimeError(
            f"Admin source revision mismatch: expected={expected_revision} path={source_prefix}"
        )
    shutil.copytree(source, replay_root)
    copy_overlay(ROOT / "admin" / "overlay", replay_root, manifest["admin_overlay"], "admin")


def verify_office(governance_base: Path, manifest: dict, replay_root: Path) -> None:
    replay_root.mkdir(parents=True, exist_ok=True)
    shutil.copytree(governance_base, replay_root, dirs_exist_ok=True)
    for entry in manifest["office_patches"]:
        patch = ROOT / entry["patch"]
        require_file(patch)
        target = replay_root / entry["path"]
        verify_base(target, entry, "office")
        run("git", "-C", str(replay_root), "apply", "--check", str(patch))
        run("git", "-C", str(replay_root), "apply", str(patch))
        verify_file(target, entry, "office")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend-source", type=Path, required=True)
    parser.add_argument("--admin-source", type=Path, required=True)
    parser.add_argument("--governance-repo", type=Path, required=True)
    args = parser.parse_args()

    manifest = json.loads(MANIFEST_PATH.read_text())
    with tempfile.TemporaryDirectory(prefix="diagnostic-log-overlay-") as temporary:
        temporary_root = Path(temporary)
        governance_base = temporary_root / "governance-base"
        archive_governance_base(args.governance_repo, manifest, governance_base)
        verify_backend(
            args.backend_source,
            manifest,
            temporary_root / "backend",
            governance_base,
        )
        verify_admin(args.admin_source, manifest, temporary_root / "admin")
        verify_office(governance_base, manifest, temporary_root / "governance")

    print("backend_overlay_replay=passed")
    print("admin_overlay_replay=passed")
    print("office_error_code_patch_replay=passed")
    print("diagnostic_log_source_manifest=passed")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Verify and package the default-disabled File Agent API mount overlay."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import tarfile
from pathlib import Path


PATCH_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = PATCH_ROOT.parents[2]
SOURCE_MANIFEST = PATCH_ROOT / "SOURCE_MANIFEST.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def load_manifest() -> dict:
    manifest = json.loads(SOURCE_MANIFEST.read_text(encoding="utf-8"))
    require(manifest.get("schema_version") == 1, "unsupported source manifest")
    targets = manifest.get("targets")
    require(isinstance(targets, list) and len(targets) == 4, "expected four API targets")
    return manifest


def verify_targets(manifest: dict) -> list[dict]:
    verified: list[dict] = []
    destinations: set[str] = set()
    relative_paths: set[str] = set()
    for item in manifest["targets"]:
        source = REPOSITORY_ROOT / item["source"]
        relative_path = item["relative_path"]
        destination = item["destination"]
        require(not Path(item["source"]).is_absolute(), f"absolute source is forbidden: {item['source']}")
        require(not Path(relative_path).is_absolute() and ".." not in Path(relative_path).parts, f"unsafe relative path: {relative_path}")
        require(destination.startswith("/app/api/"), f"unsafe destination: {destination}")
        require(source.is_file(), f"overlay source is missing: {item['source']}")
        require(relative_path not in relative_paths, f"duplicate relative path: {relative_path}")
        require(destination not in destinations, f"duplicate destination: {destination}")
        actual_sha256 = sha256(source)
        actual_bytes = source.stat().st_size
        require(actual_sha256 == item["sha256"], f"overlay digest mismatch: {relative_path}")
        require(actual_bytes == item["bytes"], f"overlay byte count mismatch: {relative_path}")
        relative_paths.add(relative_path)
        destinations.add(destination)
        verified.append(
            {
                "relative_path": relative_path,
                "destination": destination,
                "source": item["source"],
                "baseline_sha256": item["baseline_sha256"],
                "sha256": actual_sha256,
                "bytes": actual_bytes,
                "source_path": source,
            }
        )
    return verified


def archive_targets(targets: list[dict], output: Path) -> str:
    output.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(output, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        for target in sorted(targets, key=lambda value: value["relative_path"]):
            payload = target["source_path"].read_bytes()
            info = tarfile.TarInfo(target["relative_path"])
            info.size = len(payload)
            info.mode = 0o444
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            info.mtime = 0
            archive.addfile(info, io.BytesIO(payload))
    return sha256(output)


def build_handoff(manifest: dict, targets: list[dict], arguments: argparse.Namespace) -> dict:
    archive_sha256 = archive_targets(targets, arguments.output)
    handoff = {
        "schema_version": 1,
        "status": "packaged_for_deployment",
        "batch": manifest["batch"],
        "source_revision": arguments.source_revision,
        "artifact_sha256": arguments.artifact_sha256,
        "release_plan_sha256": arguments.release_plan_sha256,
        "overlay_archive": {
            "filename": arguments.output.name,
            "sha256": archive_sha256,
            "bytes": arguments.output.stat().st_size,
        },
        "targets": [
            {key: value for key, value in target.items() if key != "source_path"}
            for target in targets
        ],
        "invariants": manifest["invariants"],
    }
    arguments.handoff_manifest.parent.mkdir(parents=True, exist_ok=True)
    arguments.handoff_manifest.write_text(
        json.dumps(handoff, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return handoff


def verify_handoff(archive_path: Path, handoff_path: Path) -> None:
    handoff = json.loads(handoff_path.read_text(encoding="utf-8"))
    require(handoff.get("status") == "packaged_for_deployment", "handoff is not deployable")
    require(sha256(archive_path) == handoff["overlay_archive"]["sha256"], "handoff archive digest mismatch")
    expected = {item["relative_path"]: item for item in handoff["targets"]}
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        actual_names = {member.name for member in members}
        require(actual_names == set(expected), "handoff archive file set mismatch")
        for member in members:
            require(member.isfile() and not member.issym() and not member.islnk(), f"unsafe handoff member: {member.name}")
            payload = archive.extractfile(member)
            require(payload is not None, f"cannot read handoff member: {member.name}")
            content = payload.read()
            item = expected[member.name]
            require(len(content) == item["bytes"], f"handoff byte count mismatch: {member.name}")
            require(hashlib.sha256(content).hexdigest() == item["sha256"], f"handoff hash mismatch: {member.name}")


def validate_runtime_evidence(path: Path, source_revision: str, artifact_sha256: str) -> None:
    evidence = json.loads(path.read_text(encoding="utf-8"))
    require(evidence.get("status") == "passed", "runtime preflight did not pass")
    require(evidence.get("source_revision") == source_revision, "runtime preflight revision mismatch")
    require(evidence.get("artifact_sha256") == artifact_sha256, "runtime preflight artifact mismatch")
    require(evidence.get("write_operations") == [], "runtime preflight contains writes")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-handoff", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--handoff-manifest", type=Path)
    parser.add_argument("--source-revision")
    parser.add_argument("--artifact-sha256")
    parser.add_argument("--release-plan-sha256")
    parser.add_argument("--verify-handoff", action="store_true")
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--verify-manifest", type=Path)
    parser.add_argument("--validate-runtime-evidence", type=Path)
    parser.add_argument("--expected-source-revision")
    parser.add_argument("--expected-artifact-sha256")
    arguments = parser.parse_args()

    manifest = load_manifest()
    targets = verify_targets(manifest)
    if arguments.build_handoff:
        require(arguments.output is not None, "--output is required")
        require(arguments.handoff_manifest is not None, "--handoff-manifest is required")
        require(bool(arguments.source_revision), "--source-revision is required")
        require(bool(arguments.artifact_sha256), "--artifact-sha256 is required")
        require(bool(arguments.release_plan_sha256), "--release-plan-sha256 is required")
        handoff = build_handoff(manifest, targets, arguments)
        print(json.dumps(handoff, ensure_ascii=False, sort_keys=True))
    elif arguments.verify_handoff:
        require(arguments.archive is not None, "--archive is required")
        require(arguments.verify_manifest is not None, "--verify-manifest is required")
        verify_handoff(arguments.archive, arguments.verify_manifest)
        print("file_agent_api_handoff=passed")
    elif arguments.validate_runtime_evidence:
        require(bool(arguments.expected_source_revision), "--expected-source-revision is required")
        require(bool(arguments.expected_artifact_sha256), "--expected-artifact-sha256 is required")
        validate_runtime_evidence(
            arguments.validate_runtime_evidence,
            arguments.expected_source_revision,
            arguments.expected_artifact_sha256,
        )
        print("file_agent_api_runtime_preflight=passed")
    else:
        print("file_agent_api_overlay_manifest=passed")


if __name__ == "__main__":
    main()

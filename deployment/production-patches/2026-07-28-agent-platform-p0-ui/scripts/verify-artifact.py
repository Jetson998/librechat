#!/usr/bin/env python3
"""Verify the immutable Agent Platform Client artifact without extracting it."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import stat
import tarfile
import zipfile
from pathlib import Path, PurePosixPath


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def safe_archive_name(name: str) -> bool:
    path = PurePosixPath(name)
    return not path.is_absolute() and ".." not in path.parts


def normalized_tar_name(name: str) -> str:
    while name.startswith("./"):
        name = name[2:]
    return name or "."


def verify(artifact_zip: Path, metadata_path: Path) -> dict:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    artifact = metadata["artifact"]
    client = metadata["client"]
    source = metadata["source"]

    require(artifact_zip.is_file(), f"artifact ZIP not found: {artifact_zip}")
    require(
        artifact_zip.stat().st_size == artifact["zip_size"],
        "artifact ZIP size mismatch",
    )
    require(
        sha256_file(artifact_zip) == artifact["zip_sha256"],
        "artifact ZIP SHA-256 mismatch",
    )

    expected_members = artifact["members"]
    with zipfile.ZipFile(artifact_zip) as archive:
        infos = archive.infolist()
        names = [entry.filename for entry in infos]
        require(len(names) == len(set(names)), "artifact ZIP contains duplicate members")
        require(set(names) == set(expected_members), "artifact ZIP member set mismatch")
        for entry in infos:
            require(safe_archive_name(entry.filename), f"unsafe ZIP path: {entry.filename}")
            require(not entry.is_dir(), f"unexpected ZIP directory: {entry.filename}")
            mode = (entry.external_attr >> 16) & 0o170000
            require(mode != stat.S_IFLNK, f"ZIP symlink is not allowed: {entry.filename}")

        member_bytes = {name: archive.read(name) for name in names}

    for name, expected_hash in expected_members.items():
        require(
            sha256_bytes(member_bytes[name]) == expected_hash,
            f"artifact member SHA-256 mismatch: {name}",
        )

    checksum_text = member_bytes["client-dist.tar.gz.sha256"].decode("utf-8").strip()
    require(checksum_text == artifact["checksum_line"], "portable checksum line mismatch")

    source_manifest = json.loads(member_bytes["agent-platform-p0-ui.sources.json"])
    require(
        source_manifest["upstream"]["commit"] == source["upstream_commit"],
        "upstream commit mismatch",
    )
    require(
        source_manifest["patch"]["sha256"] == source["patch_sha256"],
        "Agent UI patch SHA-256 mismatch",
    )

    overlay_bytes = member_bytes["agent-platform-client-overlay.json"]
    overlay = json.loads(overlay_bytes)
    require(overlay["overlay_id"] == client["overlay_id"], "overlay ID mismatch")
    require(
        overlay["upstream_commit"] == source["upstream_commit"],
        "overlay upstream commit mismatch",
    )
    require(
        overlay["base_index_sha256"] == client["base_index_sha256"],
        "base Client index SHA-256 mismatch",
    )
    require(
        overlay["composed_index_sha256"] == client["composed_index_sha256"],
        "composed Client index SHA-256 mismatch",
    )
    require(len(overlay["assets"]) == client["asset_count"], "protected asset count mismatch")

    tar_payload = member_bytes["client-dist.tar.gz"]
    with tarfile.open(fileobj=io.BytesIO(tar_payload), mode="r:gz") as archive:
        members = archive.getmembers()
        require(len(members) == artifact["tar_members"], "Client tar member count mismatch")
        require(
            sum(member.isfile() for member in members) == artifact["tar_files"],
            "Client tar file count mismatch",
        )
        require(
            sum(member.isdir() for member in members) == artifact["tar_directories"],
            "Client tar directory count mismatch",
        )

        normalized = {}
        for member in members:
            require(safe_archive_name(member.name), f"unsafe Client tar path: {member.name}")
            require(
                member.isfile() or member.isdir(),
                f"unsupported Client tar member type: {member.name}",
            )
            name = normalized_tar_name(member.name)
            require(name not in normalized, f"duplicate normalized Client path: {name}")
            normalized[name] = member

        def read_file(name: str) -> bytes:
            member = normalized.get(name)
            require(member is not None and member.isfile(), f"missing Client file: {name}")
            handle = archive.extractfile(member)
            require(handle is not None, f"unable to read Client file: {name}")
            return handle.read()

        index_bytes = read_file("index.html")
        require(
            sha256_bytes(index_bytes) == client["composed_index_sha256"],
            "Client index SHA-256 mismatch",
        )
        require(
            read_file("agent-platform-client-overlay.json") == overlay_bytes,
            "inner and outer overlay manifests differ",
        )
        for asset in overlay["assets"]:
            require(
                sha256_bytes(read_file(asset["output"])) == asset["sha256"],
                f"protected Client asset SHA-256 mismatch: {asset['output']}",
            )

    return {
        "status": "passed",
        "zip_sha256": artifact["zip_sha256"],
        "client_tar_sha256": expected_members["client-dist.tar.gz"],
        "composed_index_sha256": client["composed_index_sha256"],
        "protected_assets": client["asset_count"],
        "tar_members": artifact["tar_members"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact_zip", type=Path)
    parser.add_argument("metadata", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.artifact_zip, args.metadata), sort_keys=True))


if __name__ == "__main__":
    main()

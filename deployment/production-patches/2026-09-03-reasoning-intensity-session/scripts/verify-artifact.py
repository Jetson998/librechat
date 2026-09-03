#!/usr/bin/env python3
"""Verify the immutable session-scoped reasoning intensity Client artifact."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import stat
import tarfile
import zipfile
from pathlib import Path, PurePosixPath


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def file_digest(path: Path) -> str:
    return digest(path.read_bytes())


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def safe_name(name: str) -> bool:
    path = PurePosixPath(name)
    return not path.is_absolute() and ".." not in path.parts


def normalized_name(name: str) -> str:
    while name.startswith("./"):
        name = name[2:]
    return name or "."


def verify(artifact_zip: Path, metadata_path: Path) -> dict:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    source = metadata["source"]
    artifact = metadata["artifact"]
    client = metadata["client"]
    provenance = metadata["build_provenance"]
    require(len(source["repository_commit"]) == 40, "source revision is not full length")
    require(provenance["build_environment"] == "independent-build", "build is not independent")
    require(provenance["production_host"] is False, "artifact was built on production")
    require(artifact_zip.is_file(), f"artifact ZIP not found: {artifact_zip}")
    require(artifact_zip.stat().st_size == artifact["zip_size"], "ZIP size mismatch")
    require(file_digest(artifact_zip) == artifact["zip_sha256"], "ZIP SHA-256 mismatch")

    expected_members = artifact["members"]
    with zipfile.ZipFile(artifact_zip) as bundle:
        infos = bundle.infolist()
        names = [info.filename for info in infos]
        require(len(names) == len(set(names)), "duplicate ZIP member")
        require(set(names) == set(expected_members), "ZIP member set mismatch")
        member_bytes = {}
        for info in infos:
            require(safe_name(info.filename), f"unsafe ZIP path: {info.filename}")
            require(
                "__MACOSX" not in PurePosixPath(info.filename).parts
                and not PurePosixPath(info.filename).name.startswith("._"),
                f"AppleDouble ZIP member: {info.filename}",
            )
            require(not info.is_dir(), f"unexpected ZIP directory: {info.filename}")
            mode = (info.external_attr >> 16) & 0o170000
            require(mode != stat.S_IFLNK, f"ZIP symlink: {info.filename}")
            member_bytes[info.filename] = bundle.read(info.filename)

    for name, expected in expected_members.items():
        require(digest(member_bytes[name]) == expected, f"member SHA-256 mismatch: {name}")
    require(
        member_bytes["client-dist.tar.gz.sha256"].decode("utf-8").strip()
        == artifact["checksum_line"],
        "portable tar checksum line mismatch",
    )

    candidate = json.loads(member_bytes["candidate-manifest.json"])
    require(candidate["source"]["repository_commit"] == source["repository_commit"], "candidate source mismatch")
    require(
        candidate["build"]["source_archive_sha256"] == source["source_archive_sha256"],
        "source archive mismatch",
    )
    require(candidate["client"]["index_sha256"] == client["index_sha256"], "candidate index mismatch")
    require(candidate["client"]["tar_sha256"] == expected_members["client-dist.tar.gz"], "candidate tar mismatch")
    require(candidate["client"]["file_count"] == client["file_count"], "Client file count mismatch")

    with tarfile.open(fileobj=io.BytesIO(member_bytes["client-dist.tar.gz"]), mode="r:gz") as archive:
        members = archive.getmembers()
        require(len(members) == artifact["tar_members"], "tar member count mismatch")
        require(sum(member.isfile() for member in members) == artifact["tar_files"], "tar file count mismatch")
        require(sum(member.isdir() for member in members) == artifact["tar_directories"], "tar directory count mismatch")
        normalized = {}
        for member in members:
            require(safe_name(member.name), f"unsafe tar path: {member.name}")
            require(
                "__MACOSX" not in PurePosixPath(member.name).parts
                and not PurePosixPath(member.name).name.startswith("._"),
                f"AppleDouble tar member: {member.name}",
            )
            require(member.isfile() or member.isdir(), f"unsupported tar member: {member.name}")
            name = normalized_name(member.name)
            require(name not in normalized, f"duplicate normalized tar path: {name}")
            normalized[name] = member

        def read_file(name: str) -> bytes:
            member = normalized.get(name)
            require(member is not None and member.isfile(), f"missing Client file: {name}")
            handle = archive.extractfile(member)
            require(handle is not None, f"unable to read Client file: {name}")
            return handle.read()

        require(digest(read_file("index.html")) == client["index_sha256"], "Client index SHA-256 mismatch")
        for name, expected in client["core_assets"].items():
            require(digest(read_file(name)) == expected, f"core bundle SHA-256 mismatch: {name}")
        javascript = b"\n".join(
            archive.extractfile(member).read()
            for name, member in normalized.items()
            if member.isfile() and name.endswith(".js")
        )
        for marker in client["required_markers"]:
            require(marker.encode("utf-8") in javascript, f"required Client marker missing: {marker}")

    return {
        "status": "passed",
        "source_revision": source["repository_commit"],
        "zip_sha256": artifact["zip_sha256"],
        "client_tar_sha256": expected_members["client-dist.tar.gz"],
        "client_index_sha256": client["index_sha256"],
        "file_count": client["file_count"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact_zip", type=Path)
    parser.add_argument("metadata", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.artifact_zip, args.metadata), sort_keys=True))


if __name__ == "__main__":
    main()

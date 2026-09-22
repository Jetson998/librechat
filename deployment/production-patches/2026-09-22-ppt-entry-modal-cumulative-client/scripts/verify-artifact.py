#!/usr/bin/env python3
"""Verify the cumulative Client and PPT candidate archive."""

from __future__ import annotations

import argparse
import hashlib
import json
import stat
import tarfile
from pathlib import Path, PurePosixPath


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def file_digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def safe_name(name: str) -> bool:
    path = PurePosixPath(name)
    return not path.is_absolute() and ".." not in path.parts


def parse_manifest(payload: bytes) -> dict[str, str]:
    entries: dict[str, str] = {}
    for line in payload.decode("utf-8").splitlines():
        expected, separator, name = line.partition("  ")
        require(separator == "  ", f"invalid MANIFEST line: {line}")
        require(len(expected) == 64, f"invalid MANIFEST SHA-256: {name}")
        require(name not in entries, f"duplicate MANIFEST entry: {name}")
        require(safe_name(name), f"unsafe MANIFEST path: {name}")
        entries[name] = expected
    return entries


def verify(archive_path: Path, metadata_path: Path) -> dict:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    candidate = metadata["candidate"]
    source = metadata["source"]
    client = metadata["client"]
    ppt = metadata["ppt"]
    provenance = metadata["build_provenance"]

    require(archive_path.is_file(), f"candidate archive missing: {archive_path}")
    require(archive_path.stat().st_size == candidate["archive_size"], "candidate size mismatch")
    require(file_digest(archive_path) == candidate["archive_sha256"], "candidate SHA-256 mismatch")
    require(provenance["build_environment"] == "independent-build", "build is not independent")
    require(provenance["production_host"] is False, "candidate was built on production")
    require(len(source["candidate_revision"]) == 40, "candidate revision is incomplete")

    root = candidate["root"]
    prefix = f"{root}/"
    files: dict[str, bytes] = {}
    with tarfile.open(archive_path, mode="r:gz") as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        require(len(names) == len(set(names)), "duplicate candidate archive member")
        for member in members:
            require(safe_name(member.name), f"unsafe archive path: {member.name}")
            require(member.name.startswith(prefix), f"archive member outside candidate root: {member.name}")
            mode = member.mode & stat.S_IFMT(member.mode)
            del mode
            require(member.isfile() or member.isdir(), f"unsupported archive member: {member.name}")
            if member.isdir():
                continue
            handle = archive.extractfile(member)
            require(handle is not None, f"unable to read archive member: {member.name}")
            relative = member.name[len(prefix):]
            files[relative] = handle.read()

    require(len(files) == candidate["regular_files"], "candidate regular file count mismatch")
    require("MANIFEST.sha256" in files, "candidate MANIFEST missing")
    manifest = parse_manifest(files["MANIFEST.sha256"])
    require(len(manifest) == candidate["manifest_entries"], "candidate MANIFEST count mismatch")
    require(set(manifest) == set(files) - {"MANIFEST.sha256"}, "candidate MANIFEST coverage mismatch")
    for name, expected in manifest.items():
        require(digest(files[name]) == expected, f"candidate MANIFEST mismatch: {name}")

    release = json.loads(files["RELEASE.json"])
    build = json.loads(files["BUILD_REVISION.json"])
    require(release["release_id"] == candidate["release_id"], "candidate release ID mismatch")
    require(release["source_revision"] == source["candidate_revision"], "candidate source mismatch")
    require(build["candidate_revision"] == source["candidate_revision"], "build source mismatch")
    require(build["production_client_baseline_observed"] == source["upstream_commit"], "upstream baseline mismatch")

    client_prefix = f"{client['path']}/"
    ppt_prefix = f"{ppt['path']}/"
    client_files = {name[len(client_prefix):]: payload for name, payload in files.items() if name.startswith(client_prefix)}
    ppt_files = {name[len(ppt_prefix):]: payload for name, payload in files.items() if name.startswith(ppt_prefix)}
    require(len(client_files) == client["file_count"], "Client file count mismatch")
    require(len(ppt_files) == ppt["file_count"], "PPT file count mismatch")
    require(digest(client_files["index.html"]) == client["index_sha256"], "Client index mismatch")
    require(digest(ppt_files["index.html"]) == ppt["index_sha256"], "PPT index mismatch")
    require(
        digest(client_files["agent-platform-client-overlay.json"])
        == client["overlay_manifest_sha256"],
        "Client overlay manifest mismatch",
    )
    for name, expected in client["protected_assets"].items():
        require(name in client_files, f"protected Client asset missing: {name}")
        require(digest(client_files[name]) == expected, f"protected Client asset mismatch: {name}")

    overlay = json.loads(client_files["agent-platform-client-overlay.json"])
    overlay_assets = {item["output"]: item["sha256"] for item in overlay["assets"]}
    require(overlay_assets == client["protected_assets"], "overlay metadata does not match protected assets")
    require(build["candidate_composed_index_sha256"] == client["index_sha256"], "build Client index mismatch")
    require(build["protected_overlay_asset_count"] == len(client["protected_assets"]), "build overlay count mismatch")
    require(build["protected_overlay_hashes_verified"] is True, "build overlay verification missing")
    require(
        build["built_artifacts"]["original_librechat_client"]["sha256"]
        == client["archive_sha256"],
        "Client split archive digest mismatch",
    )
    require(
        build["built_artifacts"]["ppt_static_entry"]["sha256"] == ppt["archive_sha256"],
        "PPT split archive digest mismatch",
    )

    routing_source = files["source/client/src/ppt-entry/routing.ts"].decode("utf-8")
    home_source = files["source/client/src/routes/PptMaterialsHome.tsx"].decode("utf-8")
    required_source_markers = (
        "frameWindow !== null",
        "event.origin === LIBRECHAT_ORIGIN",
        "event.source === frameWindow",
        "event.data?.type === PPT_AUTH_COMPLETE_MESSAGE",
        "window.parent.postMessage",
    )
    for marker in required_source_markers:
        require(marker in routing_source, f"strict auth bridge marker missing: {marker}")
    require("loginFrameRef.current?.contentWindow" in home_source, "PPT iframe source check missing")
    built_javascript = b"\n".join(
        payload for name, payload in {**client_files, **ppt_files}.items() if name.endswith(".js")
    )
    for marker in (
        b"librechat:ppt-authenticated",
        b"https://ppt.152.32.172.162.sslip.io",
        b"https://152.32.172.162.sslip.io",
        b"/c/new",
    ):
        require(marker in built_javascript, f"built authentication marker missing: {marker!r}")

    return {
        "status": "passed",
        "candidate_revision": source["candidate_revision"],
        "candidate_sha256": candidate["archive_sha256"],
        "client_index_sha256": client["index_sha256"],
        "client_file_count": len(client_files),
        "protected_asset_count": len(client["protected_assets"]),
        "ppt_index_sha256": ppt["index_sha256"],
        "ppt_file_count": len(ppt_files),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("metadata", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.archive, args.metadata), sort_keys=True))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Verify the immutable preset-Agent runtime/category Client artifact."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
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
    github_actions = metadata["github_actions"]

    require(github_actions["status"] == "completed", "GitHub Actions run is not complete")
    require(github_actions["conclusion"] == "success", "GitHub Actions run did not pass")
    require(
        github_actions["head_sha"] == source["repository_commit"],
        "GitHub Actions source revision mismatch",
    )
    hidden_ids = client["hidden_contact_agent_ids"]
    require(len(hidden_ids) == 7 and len(set(hidden_ids)) == 7, "hidden Agent ID contract changed")
    require(
        all(agent_id.startswith("agent_workflow_") for agent_id in hidden_ids),
        "hidden Agent IDs do not use the persistent agent_ prefix",
    )

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
            require(
                "__MACOSX" not in PurePosixPath(entry.filename).parts
                and not PurePosixPath(entry.filename).name.startswith("._"),
                f"AppleDouble ZIP member is not allowed: {entry.filename}",
            )
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
    sidebar_manifest = json.loads(member_bytes["agent-sidebar-menu-state.sources.json"])
    contact_manifest = json.loads(member_bytes["preset-agent-contact-visibility.sources.json"])
    terminology_manifest = json.loads(member_bytes["agent-guidance-terminology.sources.json"])
    runtime_manifest = json.loads(
        member_bytes["preset-agent-runtime-category-fix.sources.json"]
    )
    require(
        source_manifest["upstream"]["commit"] == source["upstream_commit"],
        "upstream commit mismatch",
    )
    require(
        source_manifest["patch"]["sha256"] == source["base_patch_sha256"],
        "base Agent UI patch SHA-256 mismatch",
    )
    require(
        sidebar_manifest["upstream"]["commit"] == source["upstream_commit"],
        "sidebar manifest upstream commit mismatch",
    )
    require(
        sidebar_manifest["base_overlay"]["patch_sha256"]
        == source["base_patch_sha256"],
        "sidebar manifest base patch SHA-256 mismatch",
    )
    require(
        sidebar_manifest["base_overlay"]["manifest_sha256"]
        == artifact["members"]["agent-platform-p0-ui.sources.json"],
        "sidebar manifest base source SHA-256 mismatch",
    )
    require(
        sidebar_manifest["patch"]["sha256"] == source["sidebar_patch_sha256"],
        "Agent sidebar patch SHA-256 mismatch",
    )
    require(
        contact_manifest["upstream"]["commit"] == source["upstream_commit"],
        "contact visibility manifest upstream commit mismatch",
    )
    require(
        contact_manifest["patch"]["sha256"] == source["contact_patch_sha256"],
        "contact visibility patch SHA-256 mismatch",
    )
    require(
        len(contact_manifest["base_overlays"]) == 2,
        "contact visibility base overlay chain changed",
    )
    expected_base_overlays = {
        "agent-platform-p0-ui": {
            "manifest_sha256": artifact["members"]["agent-platform-p0-ui.sources.json"],
            "patch_sha256": source["base_patch_sha256"],
        },
        "agent-sidebar-menu-state": {
            "manifest_sha256": artifact["members"]["agent-sidebar-menu-state.sources.json"],
            "patch_sha256": source["sidebar_patch_sha256"],
        },
    }
    for base_overlay in contact_manifest["base_overlays"]:
        expected = expected_base_overlays.get(base_overlay["integration_id"])
        require(expected is not None, "unknown contact visibility base overlay")
        require(
            base_overlay["manifest_sha256"] == expected["manifest_sha256"],
            f"base overlay manifest mismatch: {base_overlay['integration_id']}",
        )
        require(
            base_overlay["patch_sha256"] == expected["patch_sha256"],
            f"base overlay patch mismatch: {base_overlay['integration_id']}",
        )

    require(
        terminology_manifest["upstream"]["commit"] == source["upstream_commit"],
        "Agent guidance terminology manifest upstream commit mismatch",
    )
    require(
        terminology_manifest["patch"]["sha256"]
        == source["terminology_patch_sha256"],
        "Agent guidance terminology patch SHA-256 mismatch",
    )
    require(
        len(terminology_manifest["base_overlays"]) == 3,
        "Agent guidance terminology base overlay chain changed",
    )
    expected_terminology_overlays = {
        "agent-platform-p0-ui": {
            "manifest_sha256": artifact["members"]["agent-platform-p0-ui.sources.json"],
            "patch_sha256": source["base_patch_sha256"],
        },
        "agent-sidebar-menu-state": {
            "manifest_sha256": artifact["members"]["agent-sidebar-menu-state.sources.json"],
            "patch_sha256": source["sidebar_patch_sha256"],
        },
        "preset-agent-contact-visibility": {
            "manifest_sha256": artifact["members"]["preset-agent-contact-visibility.sources.json"],
            "patch_sha256": source["contact_patch_sha256"],
        },
    }
    for base_overlay in terminology_manifest["base_overlays"]:
        expected = expected_terminology_overlays.get(base_overlay["integration_id"])
        require(expected is not None, "unknown Agent guidance terminology base overlay")
        require(
            base_overlay["manifest_sha256"] == expected["manifest_sha256"],
            f"Agent guidance base manifest mismatch: {base_overlay['integration_id']}",
        )
        require(
            base_overlay["patch_sha256"] == expected["patch_sha256"],
            f"Agent guidance base patch mismatch: {base_overlay['integration_id']}",
        )

    require(
        runtime_manifest["upstream"]["commit"] == source["upstream_commit"],
        "runtime/category manifest upstream commit mismatch",
    )
    require(
        runtime_manifest["patch"]["sha256"]
        == source["runtime_category_patch_sha256"],
        "runtime/category patch SHA-256 mismatch",
    )
    require(
        len(runtime_manifest["base_overlays"]) == 4,
        "runtime/category base overlay chain changed",
    )
    expected_runtime_overlays = {
        "agent-platform-p0-ui": {
            "manifest_sha256": artifact["members"]["agent-platform-p0-ui.sources.json"],
            "patch_sha256": source["base_patch_sha256"],
        },
        "agent-sidebar-menu-state": {
            "manifest_sha256": artifact["members"]["agent-sidebar-menu-state.sources.json"],
            "patch_sha256": source["sidebar_patch_sha256"],
        },
        "preset-agent-contact-visibility": {
            "manifest_sha256": artifact["members"][
                "preset-agent-contact-visibility.sources.json"
            ],
            "patch_sha256": source["contact_patch_sha256"],
        },
        "agent-guidance-terminology": {
            "manifest_sha256": artifact["members"][
                "agent-guidance-terminology.sources.json"
            ],
            "patch_sha256": source["terminology_patch_sha256"],
        },
    }
    for base_overlay in runtime_manifest["base_overlays"]:
        expected = expected_runtime_overlays.get(base_overlay["integration_id"])
        require(expected is not None, "unknown runtime/category base overlay")
        require(
            base_overlay["manifest_sha256"] == expected["manifest_sha256"],
            f"runtime/category base manifest mismatch: {base_overlay['integration_id']}",
        )
        require(
            base_overlay["patch_sha256"] == expected["patch_sha256"],
            f"runtime/category base patch mismatch: {base_overlay['integration_id']}",
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
                "__MACOSX" not in PurePosixPath(member.name).parts
                and not PurePosixPath(member.name).name.startswith("._"),
                f"AppleDouble Client tar member is not allowed: {member.name}",
            )
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

        javascript = b"\n".join(
            read_file(name)
            for name, member in normalized.items()
            if member.isfile() and name.endswith(".js")
        )
        for agent_id in hidden_ids:
            require(
                agent_id.encode("utf-8") in javascript,
                f"hidden Agent ID missing from Client bundle: {agent_id}",
            )
        for legacy_id, _ in metadata["migration"]["id_mapping"]:
            require(
                re.search(
                    rb"(?<![A-Za-z0-9_])" + re.escape(legacy_id.encode("utf-8")),
                    javascript,
                )
                is None,
                f"legacy preset Agent ID remains in Client bundle: {legacy_id}",
            )

    return {
        "status": "passed",
        "zip_sha256": artifact["zip_sha256"],
        "client_tar_sha256": expected_members["client-dist.tar.gz"],
        "composed_index_sha256": client["composed_index_sha256"],
        "sidebar_patch_sha256": source["sidebar_patch_sha256"],
        "contact_patch_sha256": source["contact_patch_sha256"],
        "terminology_patch_sha256": source["terminology_patch_sha256"],
        "runtime_category_patch_sha256": source["runtime_category_patch_sha256"],
        "hidden_contact_agent_ids": hidden_ids,
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

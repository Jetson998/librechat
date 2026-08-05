#!/usr/bin/env python3
"""Create the self-contained production Connector source archive."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import tarfile
from pathlib import Path


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def digest_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def source_files(source_root: Path) -> list[Path]:
    require(source_root.is_dir() and not source_root.is_symlink(), "Connector source root is missing or unsafe")
    src_root = source_root / "src"
    require(src_root.is_dir() and not src_root.is_symlink(), "Connector src directory is missing or unsafe")
    candidates = [source_root / "package.json", *sorted(src_root.rglob("*"))]
    files = []
    for path in candidates:
        if path.is_symlink():
            raise RuntimeError(f"Connector archive source may not contain a symlink: {path}")
        if path.is_file():
            files.append(path)
    require(files, "Connector archive has no production source files")
    return files


def create_archive(source_root: Path, output: Path, manifest_output: Path) -> dict:
    files = source_files(source_root)
    entries = []
    payload_buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=payload_buffer, mode="wb", filename="", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for path in files:
                relative = path.relative_to(source_root).as_posix()
                payload = path.read_bytes()
                info = tarfile.TarInfo(relative)
                info.size = len(payload)
                info.mode = 0o444
                info.uid = 0
                info.gid = 0
                info.mtime = 0
                info.uname = ""
                info.gname = ""
                archive.addfile(info, io.BytesIO(payload))
                entries.append({
                    "path": relative,
                    "bytes": len(payload),
                    "sha256": digest_bytes(payload),
                })

    archive_payload = payload_buffer.getvalue()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(archive_payload)
    metadata = {
        "schema_version": 1,
        "source_root": "services/librechat-file-agent-connector",
        "archive": output.name,
        "sha256": digest_bytes(archive_payload),
        "files": entries,
    }
    manifest_output.parent.mkdir(parents=True, exist_ok=True)
    manifest_output.write_text(json.dumps(metadata, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest-output", type=Path, required=True)
    arguments = parser.parse_args()
    metadata = create_archive(
        arguments.source_root.resolve(),
        arguments.output.resolve(),
        arguments.manifest_output.resolve(),
    )
    print(json.dumps(metadata, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()

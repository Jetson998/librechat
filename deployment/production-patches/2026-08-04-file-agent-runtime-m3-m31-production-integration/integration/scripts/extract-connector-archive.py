#!/usr/bin/env python3
"""Safely extract the versioned Connector archive into the integration state."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tarfile
from pathlib import Path, PurePosixPath


def fail(message: str) -> None:
    raise SystemExit(message)


def safe_member(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or not path.parts:
        fail(f'unsafe archive member: {name}')
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    archive_path = Path(os.path.abspath(args.archive))
    manifest_path = Path(os.path.abspath(args.manifest))
    destination = Path(os.path.abspath(args.destination))
    if not archive_path.is_file() or archive_path.is_symlink():
        fail('Connector archive must be a regular file')
    if not manifest_path.is_file() or manifest_path.is_symlink():
        fail('Connector archive manifest must be a regular file')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    expected_archive_hash = manifest.get('sha256')
    actual_archive_hash = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    if expected_archive_hash != actual_archive_hash:
        fail('Connector archive hash does not match its manifest')
    if destination.is_symlink():
        fail('Connector extraction destination must not be a symbolic link')
    if destination.exists() and not destination.is_dir():
        fail('Connector extraction destination must be a directory')
    state_marker = destination.parent / '.integration-state'
    if not state_marker.is_file() or state_marker.is_symlink():
        fail('Connector extraction destination must be inside integration state')
    if state_marker.read_text(encoding='utf-8').strip() != 'file-agent-integration-state-v1':
        fail('Connector extraction destination has an unrecognized integration state marker')
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True, mode=0o755)
    with tarfile.open(archive_path, 'r:gz') as source:
        members = source.getmembers()
        for member in members:
            relative = safe_member(member.name)
            if member.issym() or member.islnk() or not member.isfile():
                fail(f'Connector archive contains a non-regular member: {member.name}')
            target = destination.joinpath(*relative.parts).resolve()
            if destination not in target.parents:
                fail(f'Connector archive escapes destination: {member.name}')
        for member in members:
            relative = safe_member(member.name)
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            with source.extractfile(member) as input_stream, target.open('wb') as output_stream:
                shutil.copyfileobj(input_stream, output_stream)
            target.chmod(0o444)
    for directory in destination.rglob('*'):
        if directory.is_dir() and not directory.is_symlink():
            directory.chmod(0o755)
    destination.chmod(0o755)
    print(json.dumps({'archiveSha256': actual_archive_hash, 'destination': str(destination)}, sort_keys=True))


if __name__ == '__main__':
    main()

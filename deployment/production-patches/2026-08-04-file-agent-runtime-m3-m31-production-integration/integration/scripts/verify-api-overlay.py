#!/usr/bin/env python3
"""Verify the reviewed LibreChat API overlay before building the harness image."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(message)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo-root', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    manifest_path = args.manifest.resolve()
    if not manifest_path.is_file() or manifest_path.is_symlink():
        fail('API overlay manifest must be a regular file')

    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        fail(f'API overlay manifest is not valid JSON: {error}')
    if manifest.get('schemaVersion') != 1:
        fail('API overlay manifest schemaVersion must be 1')
    source_revision = manifest.get('sourceRevision')
    if not isinstance(source_revision, str) or len(source_revision) != 40:
        fail('API overlay manifest sourceRevision must be a full Git revision')
    files = manifest.get('files')
    if not isinstance(files, list) or not files:
        fail('API overlay manifest files are required')

    try:
        subprocess.run(
            ['git', '-C', str(repo_root), 'cat-file', '-e', f'{source_revision}^{{commit}}'],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        fail(f'API overlay source revision is unavailable: {source_revision}')

    seen = set()
    for entry in files:
        if not isinstance(entry, dict):
            fail('API overlay manifest entries must be objects')
        relative = entry.get('path')
        expected = entry.get('sha256')
        role = entry.get('role')
        if role not in {'baseline', 'overlay'}:
            fail(f'API overlay manifest role is invalid: {role!r}')
        if not isinstance(relative, str) or not relative or relative.startswith('/'):
            fail(f'API overlay manifest path is invalid: {relative!r}')
        source_path = repo_root / relative
        path = source_path.resolve()
        if (
            source_path.is_symlink()
            or repo_root not in path.parents
            or not path.is_file()
        ):
            fail(f'API overlay manifest path is not a regular repository file: {relative}')
        if relative in seen:
            fail(f'API overlay manifest contains a duplicate path: {relative}')
        seen.add(relative)
        if not isinstance(expected, str) or len(expected) != 64:
            fail(f'API overlay manifest hash is invalid: {relative}')
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            fail(f'API overlay hash mismatch for {relative}: expected={expected} actual={actual}')

    print(json.dumps({
        'sourceRevision': source_revision,
        'files': len(files),
        'verified': True,
    }, sort_keys=True))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3

import hashlib
import os
from pathlib import Path
import sys


def source_tree_hash(root: Path) -> str:
    digest = hashlib.sha256()
    paths = sorted(path for path in root.rglob("*") if path.is_file() or path.is_symlink())
    for path in paths:
        relative = path.relative_to(root).as_posix().encode()
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        if path.is_symlink():
            content = os.readlink(path).encode()
            kind = b"L"
        else:
            content = path.read_bytes()
            kind = b"F"
        digest.update(kind)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


if __name__ == "__main__":
    source = Path(sys.argv[1] if len(sys.argv) > 1 else "source").resolve()
    print(source_tree_hash(source))

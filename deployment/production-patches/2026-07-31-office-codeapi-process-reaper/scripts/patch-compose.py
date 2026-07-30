#!/usr/bin/env python3
"""Insert the reviewed CodeAPI service block into a Compose override."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


def patch_override(source: str, service_block: str) -> str:
    if not source.startswith("services:\n"):
        raise ValueError("Compose override must start with services:")
    if re.search(r"(?m)^  codeapi:\s*$", source):
        if service_block.rstrip() in source:
            return source
        raise ValueError("an unmanaged codeapi service already exists")
    block = service_block.rstrip() + "\n"
    if not block.startswith("  codeapi:\n"):
        raise ValueError("service block must start with two-space codeapi key")
    return "services:\n" + block + source[len("services:\n") :]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("service_block", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    patched = patch_override(
        args.source.read_text(encoding="utf-8"),
        args.service_block.read_text(encoding="utf-8"),
    )
    args.output.write_text(patched, encoding="utf-8")


if __name__ == "__main__":
    main()

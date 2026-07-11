#!/usr/bin/env python3

from pathlib import Path
import re
import sys


PATTERN = re.compile(
    rb"github_pat_|BEGIN [A-Z ]+PRIVATE KEY|AKIA[0-9A-Z]{16}",
    re.IGNORECASE,
)
EXCLUDED_NAMES = {"bun.lock", "scan-release-secrets.py"}


def scan(root: Path) -> list[tuple[Path, int]]:
    matches: list[tuple[Path, int]] = []
    for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file()):
        if path.name in EXCLUDED_NAMES or path.suffix.lower() == ".svg":
            continue
        content = path.read_bytes()
        for match in PATTERN.finditer(content):
            line = content.count(b"\n", 0, match.start()) + 1
            matches.append((path.relative_to(root), line))
    return matches


if __name__ == "__main__":
    release = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    findings = scan(release)
    if findings:
        for path, line in findings:
            print(f"{path}:{line}: potential credential material", file=sys.stderr)
        raise SystemExit(1)
    print("Verified release tree contains no recognized credential material.")

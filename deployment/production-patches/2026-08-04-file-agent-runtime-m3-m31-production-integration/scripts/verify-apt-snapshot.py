#!/usr/bin/env python3
"""Verify exact APT lock entries against immutable Debian package indexes.

The Dockerfile is the source of truth for the snapshot and suites.  This
checker then reads the corresponding binary-amd64 Packages indexes and
requires every exact package/version in apt-packages.lock to be present as an
installable amd64 or all-architecture package record.  It deliberately does
not attempt to prove the transitive dependency transaction; the authorized
Docker build and native apt-get are the authority for that question.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import lzma
import re
import sys
import tempfile
import urllib.request
from pathlib import Path


SOURCE_RE = re.compile(
    r"snapshot\.debian\.org/archive/(?P<archive>debian(?:-security)?)/"
    r"(?P<snapshot>\d{8}T\d{6}Z)\s+(?P<suite>\S+)\s+(?P<components>[^']+)"
)
PACKAGE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9+.-]*$")


class SnapshotValidationError(ValueError):
    """A source, index, package, or dependency contract is invalid."""


def parse_sources(dockerfile: Path) -> dict[str, dict[str, object]]:
    sources: dict[str, dict[str, object]] = {}
    for line in dockerfile.read_text(encoding="utf-8").splitlines():
        match = SOURCE_RE.search(line)
        if not match:
            continue
        source = {
            "archive": match.group("archive"),
            "snapshot": match.group("snapshot"),
            "suite": match.group("suite"),
            "components": match.group("components").split(),
        }
        suite = str(source["suite"])
        previous = sources.get(suite)
        if previous is not None and previous != source:
            raise SnapshotValidationError(f"suite {suite} has conflicting Dockerfile sources")
        sources[suite] = source

    if not sources:
        raise SnapshotValidationError("Dockerfile contains no snapshot.debian.org source")
    snapshots = {str(source["snapshot"]) for source in sources.values()}
    if len(snapshots) != 1:
        raise SnapshotValidationError(f"Dockerfile uses multiple snapshot timestamps: {sorted(snapshots)}")
    return sources


def parse_lock(apt_lock: Path) -> dict[str, str]:
    locked: dict[str, str] = {}
    for line_number, raw_line in enumerate(apt_lock.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise SnapshotValidationError(f"invalid APT lock line {line_number}: {raw_line!r}")
        package, version = line.split("=", 1)
        if not PACKAGE_NAME_RE.fullmatch(package) or not version or any(char.isspace() for char in version):
            raise SnapshotValidationError(f"invalid APT lock line {line_number}: {raw_line!r}")
        if package in locked:
            raise SnapshotValidationError(f"duplicate package in APT lock: {package}")
        locked[package] = version
    if not locked:
        raise SnapshotValidationError("APT lock is empty")
    return locked


def parse_index_spec(raw_spec: str) -> tuple[str, Path]:
    suite, separator, raw_path = raw_spec.partition("=")
    if not separator or not suite or not raw_path:
        raise SnapshotValidationError(f"invalid --index value, expected suite=PATH: {raw_spec!r}")
    return suite, Path(raw_path)


def download_index(source: dict[str, object], architecture: str, output: Path) -> Path:
    archive = str(source["archive"])
    snapshot = str(source["snapshot"])
    suite = str(source["suite"])
    url = (
        f"https://snapshot.debian.org/archive/{archive}/{snapshot}/"
        f"dists/{suite}/main/binary-{architecture}/Packages.xz"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "LibreChat-apt-snapshot-verifier/1"})
    try:
        with urllib.request.urlopen(request, timeout=90) as response, output.open("wb") as target:
            target.write(response.read())
    except Exception as error:  # pragma: no cover - exercised by network failures
        raise SnapshotValidationError(f"could not download {url}: {error}") from error
    return output


def read_index(path: Path) -> tuple[str, str]:
    try:
        if path.suffix == ".xz":
            with lzma.open(path, "rt", encoding="utf-8") as source:
                text = source.read()
        else:
            text = path.read_text(encoding="utf-8")
    except (OSError, lzma.LZMAError, UnicodeError) as error:
        raise SnapshotValidationError(f"cannot read a complete Packages index {path}: {error}") from error
    return text, hashlib.sha256(path.read_bytes()).hexdigest()


def parse_stanza(block: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    current: str | None = None
    for line in block.splitlines():
        if line.startswith((" ", "\t")):
            if current is not None:
                fields[current] += "\n" + line
            continue
        name, separator, value = line.partition(":")
        if not separator:
            continue
        current = name
        fields[name] = value.lstrip()
    return fields


def parse_packages_index(text: str, suite: str, architecture: str) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    for block in re.split(r"\n\s*\n", text):
        fields = parse_stanza(block)
        package = fields.get("Package")
        version = fields.get("Version")
        package_architecture = fields.get("Architecture")
        if not package or not version or not package_architecture:
            continue
        if package_architecture not in {architecture, "all"}:
            continue
        filename = fields.get("Filename", "")
        if not filename or not (
            filename.endswith(f"_{architecture}.deb") or filename.endswith("_all.deb")
        ):
            continue
        records.append(
            {
                "Package": package,
                "Version": version,
                "Architecture": package_architecture,
                "Filename": filename,
                "Suite": suite,
            }
        )
    if not records:
        raise SnapshotValidationError(f"Packages index for {suite} has no {architecture} records")
    return records


def verify(args: argparse.Namespace) -> dict[str, object]:
    if args.architecture != "amd64":
        raise SnapshotValidationError("this Runtime contract is amd64-only")
    sources = parse_sources(Path(args.dockerfile))
    locked = parse_lock(Path(args.apt_lock))
    explicit_indexes = dict(parse_index_spec(raw) for raw in args.index)
    if explicit_indexes and args.download:
        raise SnapshotValidationError("--index and --download are mutually exclusive")
    if explicit_indexes and set(explicit_indexes) != set(sources):
        raise SnapshotValidationError(
            f"index suites {sorted(explicit_indexes)} do not match Dockerfile suites {sorted(sources)}"
        )
    if not explicit_indexes and not args.download:
        raise SnapshotValidationError("provide one --index suite=PATH per suite or use --download")

    index_paths: dict[str, Path] = explicit_indexes
    temporary: tempfile.TemporaryDirectory[str] | None = None
    if args.download:
        temporary = tempfile.TemporaryDirectory(prefix="librechat-apt-snapshot-")
        temporary_root = Path(temporary.name)
        index_paths = {
            suite: download_index(source, args.architecture, temporary_root / f"{suite}.Packages.xz")
            for suite, source in sources.items()
        }

    all_records: list[dict[str, str]] = []
    index_evidence: dict[str, object] = {}
    try:
        for suite, source in sources.items():
            path = index_paths[suite]
            if not path.is_file():
                raise SnapshotValidationError(f"Packages index is missing for {suite}: {path}")
            text, digest = read_index(path)
            records = parse_packages_index(text, suite, args.architecture)
            all_records.extend(records)
            index_evidence[suite] = {
                "archive": source["archive"],
                "snapshot": source["snapshot"],
                "suite": suite,
                "architecture": args.architecture,
                "path": str(path),
                "sha256": digest,
                "package_records": len(records),
            }

        by_name: dict[str, list[dict[str, str]]] = {}
        for record in all_records:
            by_name.setdefault(record["Package"], []).append(record)
        resolved: dict[str, dict[str, str]] = {}
        for package, version in locked.items():
            candidates = [
                record
                for record in by_name.get(package, [])
                if record["Version"] == version
            ]
            if not candidates:
                available = sorted({record["Version"] for record in by_name.get(package, [])})
                raise SnapshotValidationError(
                    f"{package}={version} is absent from the declared amd64 Packages indexes; "
                    f"available versions: {available or 'none'}"
                )
            selected = candidates[0]
            resolved[package] = {
                "version": selected["Version"],
                "suite": selected["Suite"],
                "architecture": selected["Architecture"],
                "filename": selected["Filename"],
            }
        return {
            "status": "passed",
            "snapshot": next(iter({str(source["snapshot"]) for source in sources.values()})),
            "architecture": args.architecture,
            "suites": index_evidence,
            "locked_packages": resolved,
        }
    finally:
        if temporary is not None:
            temporary.cleanup()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dockerfile", required=True)
    parser.add_argument("--apt-lock", required=True)
    parser.add_argument("--architecture", required=True)
    parser.add_argument("--index", action="append", default=[], metavar="SUITE=PATH")
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args), ensure_ascii=False, sort_keys=True))
    except SnapshotValidationError as error:
        print(f"apt_snapshot_validation_failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

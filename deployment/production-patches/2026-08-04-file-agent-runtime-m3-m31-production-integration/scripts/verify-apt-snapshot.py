#!/usr/bin/env python3
"""Verify that an immutable Debian snapshot can satisfy an APT lock.

The Dockerfile is the source of truth for the snapshot and suites.  This
checker then reads the corresponding binary-amd64 Packages indexes and
requires every exact package/version in apt-packages.lock to be present.  It
also walks Depends and Pre-Depends so an exact lock cannot pass merely because
the three LibreOffice package names happen to exist in a pool directory.
"""

from __future__ import annotations

import argparse
from functools import cmp_to_key
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
DEPENDENCY_RE = re.compile(
    r"^(?P<name>[a-z0-9][a-z0-9+.-]*)(?::(?:any|native|amd64))?"
    r"(?:\s*\((?P<operator><<|<=|=|>=|>>|<|>)\s*(?P<version>[^)]+)\))?$"
)


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
        if filename and not (filename.endswith(f"_{architecture}.deb") or filename.endswith("_all.deb")):
            continue
        records.append(
            {
                "Package": package,
                "Version": version,
                "Architecture": package_architecture,
                "Filename": filename,
                "Depends": fields.get("Depends", ""),
                "Pre-Depends": fields.get("Pre-Depends", ""),
                "Provides": fields.get("Provides", ""),
                "Suite": suite,
            }
        )
    if not records:
        raise SnapshotValidationError(f"Packages index for {suite} has no {architecture} records")
    return records


def split_dependency(value: str, separator: str) -> list[str]:
    parts: list[str] = []
    start = 0
    parentheses = 0
    brackets = 0
    for index, character in enumerate(value):
        if character == "(":
            parentheses += 1
        elif character == ")":
            parentheses = max(parentheses - 1, 0)
        elif character == "[":
            brackets += 1
        elif character == "]":
            brackets = max(brackets - 1, 0)
        elif character == separator and parentheses == 0 and brackets == 0:
            parts.append(value[start:index].strip())
            start = index + 1
    parts.append(value[start:].strip())
    return [part for part in parts if part]


def compare_debian_versions(left: str, right: str) -> int:
    def split_version(value: str) -> tuple[int, str, str]:
        epoch_text, separator, remainder = value.partition(":")
        if not separator:
            remainder = epoch_text
            epoch_text = "0"
        epoch = int(epoch_text)
        upstream, dash, revision = remainder.rpartition("-")
        if not dash:
            upstream, revision = remainder, ""
        return epoch, upstream, revision

    def compare_part(left_part: str, right_part: str) -> int:
        index = 0
        other = 0
        while index < len(left_part) or other < len(right_part):
            # Debian compares the non-digit runs first. A missing character
            # sorts before punctuation, while '~' sorts before everything.
            while (
                (index < len(left_part) and not left_part[index].isdigit())
                or (other < len(right_part) and not right_part[other].isdigit())
            ):
                left_char = left_part[index] if index < len(left_part) and not left_part[index].isdigit() else ""
                right_char = right_part[other] if other < len(right_part) and not right_part[other].isdigit() else ""
                if left_char == right_char:
                    if left_char:
                        index += 1
                    if right_char:
                        other += 1
                    continue
                if left_char == "~" or right_char == "~":
                    return -1 if left_char == "~" else 1
                if not left_char:
                    return -1
                if not right_char:
                    return 1
                return -1 if left_char < right_char else 1

            left_start = index
            right_start = other
            while index < len(left_part) and left_part[index].isdigit():
                index += 1
            while other < len(right_part) and right_part[other].isdigit():
                other += 1
            left_digits = left_part[left_start:index].lstrip("0") or "0"
            right_digits = right_part[right_start:other].lstrip("0") or "0"
            if len(left_digits) != len(right_digits):
                return -1 if len(left_digits) < len(right_digits) else 1
            if left_digits != right_digits:
                return -1 if left_digits < right_digits else 1
        return 0

    left_epoch, left_upstream, left_revision = split_version(left)
    right_epoch, right_upstream, right_revision = split_version(right)
    for left_value, right_value in (
        (left_epoch, right_epoch),
        (compare_part(left_upstream, right_upstream), 0),
        (compare_part(left_revision, right_revision), 0),
    ):
        if left_value != right_value:
            return -1 if left_value < right_value else 1
    return 0


def dependency_satisfied(candidate_version: str | None, operator: str | None, version: str | None) -> bool:
    if operator is None:
        return True
    if candidate_version is None:
        return False
    comparison = compare_debian_versions(candidate_version, version or "")
    return {
        "=": comparison == 0,
        ">=": comparison >= 0,
        ">": comparison > 0,
        ">>": comparison > 0,
        "<=": comparison <= 0,
        "<": comparison < 0,
        "<<": comparison < 0,
    }[operator]


def resolve_dependencies(records: list[dict[str, str]], roots: list[dict[str, str]], architecture: str) -> int:
    # A candidate is (record, effective version, is virtual provider).  A
    # versioned Provides must satisfy a versioned dependency using the version
    # declared in Provides, not the provider package's own version.
    by_name: dict[str, list[tuple[dict[str, str], str, bool]]] = {}
    providers: dict[str, list[tuple[dict[str, str], str | None, bool]]] = {}
    for record in records:
        by_name.setdefault(record["Package"], []).append((record, record["Version"], False))
        for provided in split_dependency(record["Provides"], ","):
            provided_match = re.fullmatch(
                r"(?P<name>[a-z0-9][a-z0-9+.-]*)(?:\s*\(=\s*(?P<version>[^)]+)\))?",
                provided.strip(),
            )
            if provided_match:
                providers.setdefault(provided_match.group("name"), []).append(
                    (record, provided_match.group("version"), True)
                )

    def candidates(name: str) -> list[tuple[dict[str, str], str | None, bool]]:
        return by_name.get(name, []) + providers.get(name, [])

    visited: set[tuple[str, str, str]] = set()
    visiting: set[tuple[str, str, str]] = set()

    def visit(record: dict[str, str]) -> None:
        identity = (record["Package"], record["Version"], record["Suite"])
        if identity in visited:
            return
        if identity in visiting:
            return
        visiting.add(identity)
        for field in ("Pre-Depends", "Depends"):
            for clause in split_dependency(record[field], ","):
                if not clause:
                    continue
                alternatives = split_dependency(clause, "|")
                selected: tuple[dict[str, str], str | None, bool] | None = None
                for alternative in alternatives:
                    normalized = re.sub(r"\[[^]]*\]", "", alternative)
                    normalized = re.sub(r"<[^>]*>", "", normalized).strip()
                    match = DEPENDENCY_RE.fullmatch(normalized)
                    if not match:
                        raise SnapshotValidationError(
                            f"cannot safely parse {field} dependency {alternative!r} of {record['Package']}"
                        )
                    name = match.group("name")
                    operator = match.group("operator")
                    version = match.group("version")
                    possible = [
                        candidate
                        for candidate in candidates(name)
                        if dependency_satisfied(candidate[1], operator, version)
                    ]
                    if possible:
                        selected = max(
                            possible,
                            key=cmp_to_key(
                                lambda left, right: compare_debian_versions(
                                    left[1] or "", right[1] or ""
                                )
                            ),
                        )
                        break
                if selected is None:
                    raise SnapshotValidationError(
                        f"no {architecture}-installable candidate satisfies {field} dependency "
                        f"{clause!r} of {record['Package']}={record['Version']}"
                    )
                visit(selected[0])
        visiting.remove(identity)
        visited.add(identity)

    for root in roots:
        visit(root)
    return len(visited)


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
        transitive_count = resolve_dependencies(all_records, list(resolved_record for package in resolved for resolved_record in by_name[package] if resolved_record["Version"] == locked[package]), args.architecture)
        return {
            "status": "passed",
            "snapshot": next(iter({str(source["snapshot"]) for source in sources.values()})),
            "architecture": args.architecture,
            "suites": index_evidence,
            "locked_packages": resolved,
            "transitive_package_records": transitive_count,
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

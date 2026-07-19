#!/usr/bin/env python3
"""Provider-neutral release state, evidence, and manifest helper."""

import argparse
import hashlib
import json
import os
import re
import sys
import tarfile
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path


GATE_ORDER = [
    "prepare",
    "preflight_permissions",
    "repository_gate",
    "package_manifest",
    "ci_attestation_gate",
    "target_preflight",
    "apply_gate",
    "acceptance_gate",
    "release_record",
]

VALID_GATE_STATUSES = {
    "pending",
    "passed",
    "failed",
    "blocked",
    "not_applicable",
    "invalidated",
}

VALID_RELEASE_STATUSES = {
    "planned",
    "ready",
    "in_progress",
    "deployed",
    "rolled_back",
    "blocked",
    "failed",
}

FAILURE_CATEGORIES = {
    "execution_not_started",
    "execution_failed",
    "dependency_unavailable",
    "authentication_failed",
    "authorization_failed",
    "state_conflict",
    "artifact_invalid",
    "attestation_failed",
    "target_drift",
    "deployment_failed",
    "acceptance_failed",
    "recording_failed",
}

RELEASE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class GateError(Exception):
    pass


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path):
    try:
        with Path(path).open(encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError as exc:
        raise GateError(f"file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise GateError(f"invalid JSON in {path}: {exc}") from exc


def write_json(path, data):
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=str(destination.parent), delete=False
    ) as handle:
        handle.write(payload)
        temporary = Path(handle.name)
    os.replace(str(temporary), str(destination))


def canonical_digest(data):
    payload = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def file_digest(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_release_id(value):
    if not RELEASE_ID_PATTERN.fullmatch(value):
        raise GateError(
            "release id must start with a letter or digit and contain only letters, "
            "digits, dot, underscore, or hyphen"
        )


def resolve_relative(root, value):
    path = Path(value)
    if path.is_absolute():
        raise GateError(f"path must be relative to the project root: {value}")
    resolved = (root / path).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError as exc:
        raise GateError(f"path escapes the project root: {value}") from exc
    return resolved


def validate_config_data(config, root):
    if config.get("schema_version") != 1:
        raise GateError("release-governance config requires schema_version 1")

    project = config.get("project")
    if not isinstance(project, dict) or not project.get("id") or not project.get("name"):
        raise GateError("project.id and project.name are required")

    adapter = config.get("adapter")
    if not isinstance(adapter, dict):
        raise GateError("adapter object is required")
    for key in ("prepare", "preflight", "package", "deploy", "acceptance"):
        value = adapter.get(key)
        if not isinstance(value, str) or not value:
            raise GateError(f"adapter.{key} is required")
        path = resolve_relative(root, value)
        if not path.is_file():
            raise GateError(f"adapter command not found: {value}")

    evidence = config.get("evidence")
    if not isinstance(evidence, dict):
        raise GateError("evidence object is required")
    for key in ("state_root", "record_root"):
        value = evidence.get(key)
        if not isinstance(value, str) or not value:
            raise GateError(f"evidence.{key} is required")
        resolve_relative(root, value)

    risk_modes = config.get("risk_modes")
    if not isinstance(risk_modes, dict) or not risk_modes:
        raise GateError("risk_modes object is required")
    for mode, settings in risk_modes.items():
        if not isinstance(settings, dict):
            raise GateError(f"risk mode must be an object: {mode}")
        required = settings.get("required_gates")
        allowed_na = settings.get("not_applicable_allowed", [])
        if not isinstance(required, list) or not required:
            raise GateError(f"risk mode requires required_gates: {mode}")
        if not isinstance(allowed_na, list):
            raise GateError(f"not_applicable_allowed must be a list: {mode}")
        for gate in required + allowed_na:
            if gate not in GATE_ORDER:
                raise GateError(f"unknown gate in mode {mode}: {gate}")
        indexes = [GATE_ORDER.index(gate) for gate in required]
        if indexes != sorted(set(indexes)):
            raise GateError(f"required_gates must be unique and ordered: {mode}")

    return config


def load_config(path):
    config_path = Path(path).resolve()
    config = load_json(config_path)
    return validate_config_data(config, config_path.parent), config_path.parent


def state_path(config, root, release_id):
    validate_release_id(release_id)
    return resolve_relative(root, config["evidence"]["state_root"]) / release_id / "checkpoint.json"


def load_state(config, root, release_id, mode):
    path = state_path(config, root, release_id)
    if path.exists():
        state = load_json(path)
        if state.get("release_id") != release_id:
            raise GateError("checkpoint release id mismatch")
        if state.get("mode") != mode:
            raise GateError(
                f"checkpoint mode is {state.get('mode')}, requested mode is {mode}"
            )
        return state, path
    return (
        {
            "schema_version": 1,
            "release_id": release_id,
            "mode": mode,
            "created_at": utc_now(),
            "updated_at": utc_now(),
            "gates": {},
            "history": [],
        },
        path,
    )


def effective_required_gates(config, mode):
    try:
        return config["risk_modes"][mode]["required_gates"]
    except KeyError as exc:
        raise GateError(f"unknown risk mode: {mode}") from exc


def check_prerequisites(state, required_gates, gate, terminal_record=False):
    gate_index = GATE_ORDER.index(gate)
    terminal_failure_seen = False
    for previous in required_gates:
        if GATE_ORDER.index(previous) >= gate_index:
            break
        status = state["gates"].get(previous, {}).get("status")
        if status in {"passed", "not_applicable"}:
            continue
        if terminal_record and status in {"failed", "blocked"}:
            terminal_failure_seen = True
            continue
        if terminal_record and terminal_failure_seen and status in {
            None,
            "pending",
            "invalidated",
        }:
            continue
        raise GateError(f"gate {gate} requires {previous} to pass first")
    if terminal_record and not terminal_failure_seen:
        raise GateError("terminal release record requires a failed or blocked gate")


def invalidate_downstream(state, gate, reason):
    gate_index = GATE_ORDER.index(gate)
    invalidated = []
    for candidate in GATE_ORDER[gate_index + 1 :]:
        item = state["gates"].get(candidate)
        if item and item.get("status") in {"passed", "not_applicable"}:
            item["status"] = "invalidated"
            item["invalidated_at"] = utc_now()
            item["invalidated_by"] = gate
            item["reason"] = reason
            invalidated.append(candidate)
    return invalidated


def command_validate_config(args):
    config, root = load_config(args.config)
    result = {
        "status": "passed",
        "config": str(Path(args.config).resolve()),
        "project_root": str(root),
        "project_id": config["project"]["id"],
        "risk_modes": sorted(config["risk_modes"]),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


def command_classify_failure(args):
    if args.category:
        if args.category not in FAILURE_CATEGORIES:
            raise GateError(f"unknown failure category: {args.category}")
        category = args.category
    elif not args.started:
        category = "execution_not_started"
    elif args.exit_code in (126, 127):
        category = "dependency_unavailable"
    else:
        message = (args.message or "").lower()
        patterns = [
            ("authentication_failed", ("authentication failed", "invalid credential", "unauthorized")),
            ("authorization_failed", ("authorization failed", "forbidden", "not authorized")),
            ("state_conflict", ("state conflict", "already locked", "concurrent", "conflict")),
            ("artifact_invalid", ("artifact invalid", "checksum mismatch", "digest mismatch", "missing required")),
            ("attestation_failed", ("attestation", "build proof", "provenance mismatch")),
            ("target_drift", ("target drift", "baseline mismatch", "fingerprint mismatch")),
            ("deployment_failed", ("deployment failed", "apply failed")),
            ("acceptance_failed", ("acceptance failed", "smoke test failed", "regression failed")),
            ("recording_failed", ("recording failed", "result persistence failed")),
            ("dependency_unavailable", ("dependency unavailable", "service unavailable", "timed out")),
        ]
        category = "execution_failed"
        for candidate, needles in patterns:
            if any(needle in message for needle in needles):
                category = candidate
                break

    result = {
        "category": category,
        "command_started": args.started,
        "exit_code": args.exit_code,
        "details": args.message or "",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


def command_checkpoint_set(args):
    config, root = load_config(args.config)
    required = effective_required_gates(config, args.mode)
    allowed_na = config["risk_modes"][args.mode].get("not_applicable_allowed", [])
    if args.gate not in GATE_ORDER:
        raise GateError(f"unknown gate: {args.gate}")
    if args.status not in VALID_GATE_STATUSES - {"pending", "invalidated"}:
        raise GateError(f"checkpoint-set cannot assign status: {args.status}")
    if args.gate not in required and not (
        args.status == "not_applicable" and args.gate in allowed_na
    ):
        raise GateError(f"gate {args.gate} is not part of mode {args.mode}")
    if args.status == "not_applicable":
        if args.gate not in allowed_na:
            raise GateError(f"gate {args.gate} cannot be not_applicable in mode {args.mode}")
        if not args.reason:
            raise GateError("not_applicable requires --reason")
    if args.status in {"failed", "blocked"} and not args.reason:
        raise GateError(f"{args.status} requires --reason")

    inputs = load_json(args.inputs) if args.inputs else {}
    input_digest = canonical_digest(inputs)
    state, path = load_state(config, root, args.release_id, args.mode)
    if args.status in {"passed", "not_applicable"}:
        check_prerequisites(
            state,
            required,
            args.gate,
            terminal_record=args.terminal_record,
        )
    if args.terminal_record and args.gate != "release_record":
        raise GateError("--terminal-record is only valid for release_record")

    previous = state["gates"].get(args.gate)
    invalidated = []
    if previous and previous.get("inputs_digest") != input_digest:
        invalidated = invalidate_downstream(
            state, args.gate, f"inputs changed for {args.gate}"
        )

    evidence = None
    if args.evidence:
        evidence_path = Path(args.evidence).resolve()
        if not evidence_path.is_file():
            raise GateError(f"evidence file not found: {args.evidence}")
        evidence = {
            "path": str(evidence_path),
            "sha256": file_digest(evidence_path),
        }
    elif args.status == "passed":
        raise GateError("passed checkpoints require --evidence")

    item = {
        "status": args.status,
        "updated_at": utc_now(),
        "inputs": inputs,
        "inputs_digest": input_digest,
        "evidence": evidence,
        "reason": args.reason or "",
    }
    state["gates"][args.gate] = item
    state["updated_at"] = utc_now()
    state["history"].append(
        {
            "at": utc_now(),
            "gate": args.gate,
            "status": args.status,
            "inputs_digest": input_digest,
            "invalidated": invalidated,
        }
    )
    write_json(path, state)
    print(
        json.dumps(
            {
                "status": "recorded",
                "checkpoint": str(path),
                "gate": args.gate,
                "gate_status": args.status,
                "invalidated": invalidated,
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
    )


def command_checkpoint_status(args):
    config, root = load_config(args.config)
    path = state_path(config, root, args.release_id)
    if not path.is_file():
        raise GateError(f"checkpoint not found: {path}")
    print(json.dumps(load_json(path), ensure_ascii=False, indent=2, sort_keys=True))


def command_checkpoint_verify(args):
    config, root = load_config(args.config)
    required = effective_required_gates(config, args.mode)
    state, path = load_state(config, root, args.release_id, args.mode)
    if args.through not in GATE_ORDER:
        raise GateError(f"unknown gate: {args.through}")
    through_index = GATE_ORDER.index(args.through)
    missing = []
    for gate in required:
        if GATE_ORDER.index(gate) > through_index:
            break
        status = state["gates"].get(gate, {}).get("status")
        if status not in {"passed", "not_applicable"}:
            missing.append({"gate": gate, "status": status or "missing"})
    result = {
        "status": "passed" if not missing else "blocked",
        "checkpoint": str(path),
        "through": args.through,
        "missing": missing,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    if missing:
        raise GateError(f"checkpoint is not valid through {args.through}")


def inventory_tar(path):
    files = []
    with tarfile.open(path, "r:*") as archive:
        for member in sorted(archive.getmembers(), key=lambda item: item.name):
            if not member.isfile():
                continue
            extracted = archive.extractfile(member)
            if extracted is None:
                continue
            digest = hashlib.sha256()
            size = 0
            for chunk in iter(lambda: extracted.read(1024 * 1024), b""):
                size += len(chunk)
                digest.update(chunk)
            files.append({"path": member.name, "size": size, "sha256": digest.hexdigest()})
    return files


def inventory_zip(path):
    files = []
    with zipfile.ZipFile(path) as archive:
        for info in sorted(archive.infolist(), key=lambda item: item.filename):
            if info.is_dir():
                continue
            digest = hashlib.sha256()
            size = 0
            with archive.open(info) as extracted:
                for chunk in iter(lambda: extracted.read(1024 * 1024), b""):
                    size += len(chunk)
                    digest.update(chunk)
            files.append({"path": info.filename, "size": size, "sha256": digest.hexdigest()})
    return files


def required_path_present(required, paths):
    normalized = required.rstrip("/")
    return normalized in paths or any(path.startswith(normalized + "/") for path in paths)


def command_package_manifest(args):
    validate_release_id(args.release_id)
    artifact = Path(args.artifact).resolve()
    if not artifact.is_file():
        raise GateError(f"artifact not found: {artifact}")
    if tarfile.is_tarfile(artifact):
        files = inventory_tar(artifact)
        artifact_format = "tar"
    elif zipfile.is_zipfile(artifact):
        files = inventory_zip(artifact)
        artifact_format = "zip"
    else:
        files = [
            {
                "path": artifact.name,
                "size": artifact.stat().st_size,
                "sha256": file_digest(artifact),
            }
        ]
        artifact_format = "file"

    paths = {item["path"] for item in files}
    missing = [item for item in args.required if not required_path_present(item, paths)]
    if missing:
        raise GateError("missing required artifact paths: " + ", ".join(missing))

    manifest = {
        "schema_version": 1,
        "release_id": args.release_id,
        "source_revision": args.source_revision,
        "created_at": utc_now(),
        "artifact": {
            "path": str(artifact),
            "format": artifact_format,
            "size": artifact.stat().st_size,
            "sha256": file_digest(artifact),
        },
        "required_paths": args.required,
        "files": files,
    }
    write_json(args.output, manifest)
    print(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True))


def empty_evidence(status="pending"):
    return {"status": status, "details": {}}


def command_new_record(args):
    validate_release_id(args.release_id)
    output = Path(args.output)
    if output.exists() and not args.force:
        raise GateError(f"release record already exists: {output}")
    record = {
        "schema_version": 1,
        "release_id": args.release_id,
        "project_id": args.project_id,
        "mode": args.mode,
        "status": "planned",
        "created_at": utc_now(),
        "updated_at": utc_now(),
        "source_revision": "",
        "change_summary": {
            "reason": "",
            "functions": [],
            "scope": [],
            "expected_result": "",
            "risk": "",
            "limitations": [],
        },
        "baseline_reference": empty_evidence(),
        "validation_plan": [],
        "release_plan": {"sha256": "", "details": {}},
        "artifact_digest": empty_evidence(),
        "build_attestation": empty_evidence(),
        "runtime_snapshot": empty_evidence(),
        "backup_reference": empty_evidence(),
        "acceptance_result": empty_evidence(),
        "rollback_reference": empty_evidence(),
        "unresolved_issues": [],
    }
    write_json(output, record)
    print(json.dumps({"status": "created", "record": str(output)}, indent=2))


def validate_evidence_object(record, key):
    value = record.get(key)
    if not isinstance(value, dict) or not isinstance(value.get("status"), str):
        raise GateError(f"release record requires {key}.status")
    if value["status"] == "not_applicable" and not value.get("reason"):
        raise GateError(f"{key} not_applicable requires a reason")


def command_validate_record(args):
    record = load_json(args.record)
    required_fields = {
        "schema_version",
        "release_id",
        "project_id",
        "mode",
        "status",
        "source_revision",
        "change_summary",
        "baseline_reference",
        "validation_plan",
        "artifact_digest",
        "build_attestation",
        "runtime_snapshot",
        "backup_reference",
        "acceptance_result",
        "rollback_reference",
        "unresolved_issues",
    }
    missing = sorted(required_fields - set(record))
    if missing:
        raise GateError("release record missing fields: " + ", ".join(missing))
    if record.get("schema_version") != 1:
        raise GateError("release record requires schema_version 1")
    validate_release_id(record["release_id"])
    if record["status"] not in VALID_RELEASE_STATUSES:
        raise GateError(f"invalid release status: {record['status']}")
    if not isinstance(record["change_summary"], dict):
        raise GateError("change_summary must be an object")
    for key in (
        "baseline_reference",
        "artifact_digest",
        "build_attestation",
        "runtime_snapshot",
        "backup_reference",
        "acceptance_result",
        "rollback_reference",
    ):
        validate_evidence_object(record, key)
    if not isinstance(record["validation_plan"], list):
        raise GateError("validation_plan must be a list")
    if not isinstance(record["unresolved_issues"], list):
        raise GateError("unresolved_issues must be a list")
    result = {
        "status": "passed",
        "record": str(Path(args.record).resolve()),
        "record_sha256": file_digest(args.record),
        "release_id": record["release_id"],
        "mode": record["mode"],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate_config = subparsers.add_parser("validate-config")
    validate_config.add_argument("--config", required=True)
    validate_config.set_defaults(func=command_validate_config)

    classify = subparsers.add_parser("classify-failure")
    classify.add_argument("--started", action=argparse.BooleanOptionalAction, default=True)
    classify.add_argument("--exit-code", type=int, default=1)
    classify.add_argument("--message", default="")
    classify.add_argument("--category", choices=sorted(FAILURE_CATEGORIES))
    classify.set_defaults(func=command_classify_failure)

    checkpoint_set = subparsers.add_parser("checkpoint-set")
    checkpoint_set.add_argument("--config", required=True)
    checkpoint_set.add_argument("--release-id", required=True)
    checkpoint_set.add_argument("--mode", required=True)
    checkpoint_set.add_argument("--gate", required=True)
    checkpoint_set.add_argument("--status", required=True)
    checkpoint_set.add_argument("--inputs")
    checkpoint_set.add_argument("--evidence")
    checkpoint_set.add_argument("--reason")
    checkpoint_set.add_argument("--terminal-record", action="store_true")
    checkpoint_set.set_defaults(func=command_checkpoint_set)

    checkpoint_status = subparsers.add_parser("checkpoint-status")
    checkpoint_status.add_argument("--config", required=True)
    checkpoint_status.add_argument("--release-id", required=True)
    checkpoint_status.set_defaults(func=command_checkpoint_status)

    checkpoint_verify = subparsers.add_parser("checkpoint-verify")
    checkpoint_verify.add_argument("--config", required=True)
    checkpoint_verify.add_argument("--release-id", required=True)
    checkpoint_verify.add_argument("--mode", required=True)
    checkpoint_verify.add_argument("--through", required=True)
    checkpoint_verify.set_defaults(func=command_checkpoint_verify)

    manifest = subparsers.add_parser("package-manifest")
    manifest.add_argument("--release-id", required=True)
    manifest.add_argument("--source-revision", required=True)
    manifest.add_argument("--artifact", required=True)
    manifest.add_argument("--required", action="append", default=[])
    manifest.add_argument("--output", required=True)
    manifest.set_defaults(func=command_package_manifest)

    new_record = subparsers.add_parser("new-record")
    new_record.add_argument("--release-id", required=True)
    new_record.add_argument("--project-id", required=True)
    new_record.add_argument("--mode", required=True)
    new_record.add_argument("--output", required=True)
    new_record.add_argument("--force", action="store_true")
    new_record.set_defaults(func=command_new_record)

    validate_record = subparsers.add_parser("validate-record")
    validate_record.add_argument("--record", required=True)
    validate_record.set_defaults(func=command_validate_record)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except GateError as exc:
        print(f"release_gate_error={exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

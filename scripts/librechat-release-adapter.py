#!/usr/bin/env python3
"""LibreChat adapter for the lightweight release-governance protocol."""

import argparse
import fcntl
import hashlib
import json
import os
import shutil
import ssl
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from fnmatch import fnmatchcase
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "release-governance.json"
GATE_SCRIPT = (
    ROOT
    / "skills"
    / "lightweight-release-governance"
    / "scripts"
    / "release_gate.py"
)
MODE_ORDER = {"light": 0, "release": 1, "protected": 2, "enhanced": 3}
PLAN_LIST_FIELDS = (
    "build_requirements",
    "test_requirements",
    "deployment_targets",
    "dependency_services",
    "preflight_checks",
    "public_preflight_checks",
    "public_acceptance_checks",
    "acceptance_checks",
    "conditional_checks",
)


class AdapterError(Exception):
    pass


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path):
    try:
        with Path(path).open(encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError as exc:
        raise AdapterError(f"file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise AdapterError(f"invalid JSON in {path}: {exc}") from exc


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


def file_digest(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_digest(data):
    payload = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def config():
    return load_json(CONFIG_PATH)


def validate_release_planning_config(settings):
    planning = settings.get("release_planning")
    if not isinstance(planning, dict):
        raise AdapterError("release_planning object is required")
    known_modes = set(settings["risk_modes"])
    for key in ("active_modes", "production_modes", "production_roots", "rules"):
        if not isinstance(planning.get(key), list):
            raise AdapterError(f"release_planning.{key} must be a list")
    unknown_modes = (
        set(planning["active_modes"] + planning["production_modes"]) - known_modes
    )
    if unknown_modes:
        raise AdapterError(
            "unknown release planning modes: " + ", ".join(sorted(unknown_modes))
        )
    thresholds = planning.get("resource_thresholds", {})
    for key in ("memory_available_mb", "disk_free_mb"):
        if not isinstance(thresholds.get(key), int) or thresholds[key] <= 0:
            raise AdapterError(
                f"release_planning.resource_thresholds.{key} must be positive"
            )
    defaults = planning.get("production_defaults")
    if not isinstance(defaults, dict):
        raise AdapterError("release_planning.production_defaults must be an object")
    for field in PLAN_LIST_FIELDS:
        if field in defaults and not isinstance(defaults[field], list):
            raise AdapterError(f"release_planning.production_defaults.{field} must be a list")
    rule_ids = []
    for rule in planning["rules"]:
        if not isinstance(rule, dict) or not rule.get("id"):
            raise AdapterError("release planning rule id is required")
        if not isinstance(rule.get("patterns"), list) or not rule["patterns"]:
            raise AdapterError(f"release planning rule patterns are required: {rule['id']}")
        rule_ids.append(rule["id"])
        if rule.get("minimum_mode") not in known_modes | {None}:
            raise AdapterError(f"unknown minimum mode in release rule: {rule['id']}")
        for field in PLAN_LIST_FIELDS:
            if field in rule and not isinstance(rule[field], list):
                raise AdapterError(
                    f"release planning rule {field} must be a list: {rule['id']}"
                )
        if "exclude_patterns" in rule and not isinstance(rule["exclude_patterns"], list):
            raise AdapterError(
                f"release planning exclude_patterns must be a list: {rule['id']}"
            )
    if len(rule_ids) != len(set(rule_ids)):
        raise AdapterError("release planning rule ids must be unique")
    return planning


def record_path(release_id):
    settings = config()
    return ROOT / settings["evidence"]["record_root"] / release_id / "RELEASE.json"


def state_dir(release_id):
    settings = config()
    return ROOT / settings["evidence"]["state_root"] / release_id


def run(command, check=True, cwd=None, env=None):
    if cwd is None:
        cwd = ROOT
    completed = subprocess.run(
        [str(item) for item in command],
        cwd=str(cwd),
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if check and completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip()
        raise AdapterError(f"command failed ({completed.returncode}): {message}")
    return completed


def run_gate(arguments, check=True):
    return run([sys.executable, GATE_SCRIPT] + list(arguments), check=check)


def git(arguments, check=True):
    return run(["git"] + list(arguments), check=check)


def save_command_output(path, completed):
    data = {
        "command_started": True,
        "exit_code": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "captured_at": utc_now(),
    }
    write_json(path, data)
    return data


def checkpoint_set(
    release_id,
    mode,
    gate,
    status,
    inputs,
    evidence=None,
    reason=None,
    terminal_record=False,
):
    inputs_path = state_dir(release_id) / f"{gate}-inputs.json"
    write_json(inputs_path, inputs)
    command = [
        "checkpoint-set",
        "--config",
        str(CONFIG_PATH),
        "--release-id",
        release_id,
        "--mode",
        mode,
        "--gate",
        gate,
        "--status",
        status,
        "--inputs",
        str(inputs_path),
    ]
    if evidence:
        command.extend(["--evidence", str(evidence)])
    if reason:
        command.extend(["--reason", reason])
    if terminal_record:
        command.append("--terminal-record")
    return run_gate(command)


def checkpoint_verify(release_id, mode, through):
    return run_gate(
        [
            "checkpoint-verify",
            "--config",
            str(CONFIG_PATH),
            "--release-id",
            release_id,
            "--mode",
            mode,
            "--through",
            through,
        ]
    )


def validate_mode(settings, mode):
    if mode not in settings["risk_modes"]:
        raise AdapterError(f"unknown risk mode: {mode}")


def validate_record_for_project(record):
    settings = config()
    if record.get("project_id") != settings["project"]["id"]:
        raise AdapterError("release record project_id does not match LibreChat")
    mode = record.get("mode")
    validate_mode(settings, mode)
    if not record.get("source_revision"):
        raise AdapterError("release record source_revision is required")
    resolved_revision = git(
        ["rev-parse", f"{record['source_revision']}^{{commit}}"], check=False
    )
    if resolved_revision.returncode != 0:
        raise AdapterError("release record source_revision is not available locally")
    if record["source_revision"] != resolved_revision.stdout.strip():
        raise AdapterError("release record source_revision must be the full revision id")
    summary = record.get("change_summary", {})
    for key in ("reason", "scope", "expected_result", "risk"):
        if not summary.get(key):
            raise AdapterError(f"release record change_summary.{key} is required")
    if not isinstance(summary.get("scope"), list):
        raise AdapterError("release record change_summary.scope must be a list")
    if record.get("baseline_reference", {}).get("status") != "passed":
        raise AdapterError("baseline_reference must be passed before verification")
    if record.get("rollback_reference", {}).get("status") != "passed":
        raise AdapterError("rollback_reference must be passed before verification")
    if not record.get("validation_plan"):
        raise AdapterError("validation_plan must contain at least one check")
    adapter = record.get("project_adapter")
    if not isinstance(adapter, dict):
        raise AdapterError("release record project_adapter object is required")
    billable_opt_in = adapter.get("billable_model_request_allowed", False)
    if not isinstance(billable_opt_in, bool):
        raise AdapterError(
            "project_adapter.billable_model_request_allowed must be boolean"
        )
    return mode


def validate_record(release_id):
    path = record_path(release_id)
    completed = run_gate(["validate-record", "--record", str(path)])
    record = load_json(path)
    mode = validate_record_for_project(record)
    evidence = state_dir(release_id) / "record-validation.json"
    write_json(evidence, json.loads(completed.stdout))
    return record, mode, path, evidence


def prepare_inputs(record):
    return {
        "project_id": record["project_id"],
        "mode": record["mode"],
        "source_revision": record["source_revision"],
        "change_summary": record["change_summary"],
        "baseline_reference": record["baseline_reference"],
        "validation_plan": record["validation_plan"],
        "rollback_reference": record["rollback_reference"],
    }


def status_paths():
    completed = git(["status", "--porcelain=v1", "-z"])
    entries = completed.stdout.split("\0")
    paths = []
    for entry in entries:
        if not entry:
            continue
        value = entry[3:]
        if " -> " in value:
            value = value.split(" -> ", 1)[1]
        paths.append(value)
    return sorted(set(paths))


def path_in_roots(path, roots):
    candidate = path.rstrip("/")
    for root in roots:
        normalized = root.rstrip("/")
        if candidate == normalized or candidate.startswith(normalized + "/"):
            return True
    return False


def extend_unique(target, values):
    for value in values or []:
        if value not in target:
            target.append(value)


def scope_files_at_revision(revision, scope):
    completed = run(
        ["git", "ls-tree", "-r", "--name-only", revision, "--"] + list(scope),
        check=False,
    )
    if completed.returncode != 0:
        raise AdapterError(completed.stderr.strip() or "unable to resolve release scope")
    paths = sorted({line.strip() for line in completed.stdout.splitlines() if line.strip()})
    if not paths:
        raise AdapterError("artifact_invalid: release scope contains no tracked files")
    return paths


def path_matches(path, patterns):
    return any(fnmatchcase(path, pattern) for pattern in patterns)


def release_plan(record, release_id, persist=True):
    settings = config()
    planning = validate_release_planning_config(settings)
    mode = record["mode"]
    if mode not in planning.get("active_modes", []):
        return None

    revision = git(["rev-parse", f"{record['source_revision']}^{{commit}}"]).stdout.strip()
    resolved_paths = scope_files_at_revision(revision, record["change_summary"]["scope"])
    production = mode in planning.get("production_modes", [])
    minimum_mode = "protected" if production else "release"
    release_kind = record.get("project_adapter", {}).get("release_kind", "batch")
    if release_kind not in {"batch", "mvp-promotion", "major-release"}:
        raise AdapterError(f"unknown project_adapter.release_kind: {release_kind}")
    plan = {
        "schema_version": 1,
        "release_id": release_id,
        "source_revision": revision,
        "mode": mode,
        "production_release": production,
        "batch_release": True,
        "release_kind": release_kind,
        "config_sha256": file_digest(CONFIG_PATH),
        "resolved_paths": resolved_paths,
        "matched_rules": [],
        "minimum_mode": minimum_mode,
        "acceptance_level": "light",
        "data_backup_required": False,
    }
    for field in PLAN_LIST_FIELDS:
        plan[field] = []

    if production:
        defaults = planning.get("production_defaults", {})
        for field in PLAN_LIST_FIELDS:
            extend_unique(plan[field], defaults.get(field, []))
        plan["acceptance_level"] = defaults.get("acceptance_level", "light")
        if release_kind in {"mvp-promotion", "major-release"}:
            plan["minimum_mode"] = "enhanced"
            plan["acceptance_level"] = "heavy"
            extend_unique(
                plan["acceptance_checks"], ["full-business-acceptance-reference"]
            )

    matched_paths = set()
    for rule in planning.get("rules", []):
        rule_paths = [
            path
            for path in resolved_paths
            if path_matches(path, rule.get("patterns", []))
            and not path_matches(path, rule.get("exclude_patterns", []))
        ]
        if not rule_paths:
            continue
        matched_paths.update(rule_paths)
        plan["matched_rules"].append(
            {
                "id": rule["id"],
                "matched_path_count": len(rule_paths),
                "sample_paths": rule_paths[:5],
            }
        )
        required_mode = rule.get("minimum_mode")
        if required_mode and MODE_ORDER[required_mode] > MODE_ORDER[plan["minimum_mode"]]:
            plan["minimum_mode"] = required_mode
        if rule.get("acceptance_level") == "heavy":
            plan["acceptance_level"] = "heavy"
        if rule.get("data_backup_required", False):
            plan["data_backup_required"] = True
        for field in PLAN_LIST_FIELDS:
            extend_unique(plan[field], rule.get(field, []))

    explicit_targets = record.get("project_adapter", {}).get("protected_services", [])
    if not production:
        explicit_targets = []
    if explicit_targets and plan["deployment_targets"]:
        if set(explicit_targets) != set(plan["deployment_targets"]):
            raise AdapterError(
                "state_conflict: explicit protected_services do not match path rules"
            )
    elif explicit_targets:
        extend_unique(plan["deployment_targets"], explicit_targets)

    production_paths = [
        path
        for path in resolved_paths
        if path_in_roots(path, planning.get("production_roots", []))
    ]
    if production and not production_paths:
        raise AdapterError(
            "state_conflict: protected release has no path under a production root"
        )
    if MODE_ORDER[mode] < MODE_ORDER[plan["minimum_mode"]]:
        raise AdapterError(
            f"state_conflict: release scope requires {plan['minimum_mode']} mode, got {mode}"
        )
    if production and not plan["deployment_targets"]:
        raise AdapterError(
            "state_conflict: production scope did not resolve any deployment target"
        )

    known_services = set(settings["target"]["protected_services"])
    selected_services = set(plan["deployment_targets"] + plan["dependency_services"])
    unknown_services = sorted(selected_services - known_services)
    if unknown_services:
        raise AdapterError("unknown protected services: " + ", ".join(unknown_services))

    public_ids = {item["id"] for item in settings["target"]["public_checks"]}
    selected_public = set(
        plan["public_preflight_checks"] + plan["public_acceptance_checks"]
    )
    unknown_public = sorted(selected_public - public_ids)
    if unknown_public:
        raise AdapterError("unknown public checks: " + ", ".join(unknown_public))

    plan["affected_services"] = sorted(selected_services)
    plan["unmatched_path_count"] = len(set(resolved_paths) - matched_paths)
    for field in PLAN_LIST_FIELDS:
        plan[field] = sorted(plan[field])
    plan["matched_rules"] = sorted(plan["matched_rules"], key=lambda item: item["id"])
    plan["release_plan_sha256"] = canonical_digest(plan)

    if persist:
        path = state_dir(release_id) / "release-plan.json"
        write_json(path, plan)
    return plan


def add_plan_input(inputs, plan):
    if plan:
        inputs["release_plan_sha256"] = plan["release_plan_sha256"]
    return inputs


def passed_check_ids(payload):
    passed = set()
    for item in payload.get("checks", []):
        if isinstance(item, str):
            passed.add(item)
        elif isinstance(item, dict) and item.get("status") == "passed" and item.get("id"):
            passed.add(item["id"])
    return passed


def require_plan_identity(payload, record, plan, label):
    if payload.get("status") != "passed":
        raise AdapterError(f"{label} status must be passed")
    if payload.get("source_revision") != record["source_revision"]:
        raise AdapterError(f"{label} source_revision mismatch")
    if payload.get("release_plan_sha256") != plan["release_plan_sha256"]:
        raise AdapterError(f"{label} release plan mismatch")
    artifact = record.get("artifact_digest", {}).get("details", {}).get("value")
    if artifact and payload.get("artifact_sha256") != artifact:
        raise AdapterError(f"{label} artifact digest mismatch")


def validate_runtime_evidence(payload, record, plan):
    require_plan_identity(payload, record, plan, "runtime evidence")
    required_checks = set(plan["preflight_checks"])
    missing_checks = sorted(required_checks - passed_check_ids(payload))
    if missing_checks:
        raise AdapterError(
            "target_drift: runtime evidence missing checks: " + ", ".join(missing_checks)
        )
    checked_services = set(payload.get("checked_services", []))
    missing_services = sorted(set(plan["affected_services"]) - checked_services)
    if missing_services:
        raise AdapterError(
            "target_drift: runtime evidence missing services: " + ", ".join(missing_services)
        )
    resources = payload.get("host_resources", {})
    thresholds = config()["release_planning"]["resource_thresholds"]
    if resources.get("memory_available_mb", -1) < thresholds["memory_available_mb"]:
        raise AdapterError("target_drift: production host memory is below threshold")
    if resources.get("disk_free_mb", -1) < thresholds["disk_free_mb"]:
        raise AdapterError("target_drift: production host disk is below threshold")
    if payload.get("rollback_available") is not True:
        raise AdapterError("target_drift: rollback target is not confirmed available")
    if plan["data_backup_required"] and not payload.get("backup_reference"):
        raise AdapterError("target_drift: data backup reference is required")


def validate_acceptance_evidence(payload, record, plan):
    require_plan_identity(payload, record, plan, "acceptance evidence")
    required_checks = set(plan["acceptance_checks"])
    missing_checks = sorted(required_checks - passed_check_ids(payload))
    if missing_checks:
        raise AdapterError(
            "acceptance_failed: missing checks: " + ", ".join(missing_checks)
        )
    billable_requests = payload.get("billable_model_requests", 0)
    if not isinstance(billable_requests, int) or billable_requests < 0 or billable_requests > 1:
        raise AdapterError("acceptance_failed: billable model requests must be between 0 and 1")
    billable_opt_in = record.get("project_adapter", {}).get(
        "billable_model_request_allowed", False
    )
    if (
        "billable-model-request" not in plan["conditional_checks"]
        and billable_opt_in is not True
        and billable_requests
    ):
        raise AdapterError("acceptance_failed: model request was not selected by the release plan")


def validate_build_attestation(attestation, record, plan):
    expected_artifact = record["artifact_digest"]["details"]["value"]
    if attestation.get("source_revision") != record["source_revision"]:
        raise AdapterError("attestation_failed: source_revision mismatch")
    if attestation.get("artifact_sha256") != expected_artifact:
        raise AdapterError("attestation_failed: artifact digest mismatch")
    if attestation.get("release_plan_sha256") != plan["release_plan_sha256"]:
        raise AdapterError("attestation_failed: release plan mismatch")
    required = set(plan["build_requirements"] + plan["test_requirements"])
    completed = set(attestation.get("completed_requirements", []))
    missing = sorted(required - completed)
    if missing:
        raise AdapterError(
            "attestation_failed: missing requirements: " + ", ".join(missing)
        )
    if plan["production_release"]:
        if attestation.get("production_host") is not False:
            raise AdapterError(
                "attestation_failed: production build must be explicitly false"
            )
        if attestation.get("build_environment") not in {"ci", "independent-build"}:
            raise AdapterError(
                "attestation_failed: build_environment must be ci or independent-build"
            )
    return expected_artifact


def ensure_local_object(revision):
    completed = git(["cat-file", "-e", f"{revision}^{{commit}}"], check=False)
    return completed.returncode == 0


def tree_listing_digest(revision, paths):
    completed = run(
        ["git", "ls-tree", "-r", "-z", revision, "--"] + paths,
        check=False,
    )
    if completed.returncode != 0:
        raise AdapterError(completed.stderr.strip() or "unable to inspect release scope")
    return hashlib.sha256(completed.stdout.encode("utf-8")).hexdigest()


def remote_head(settings):
    repository = settings["repository"]
    ref = f"refs/heads/{repository['default_branch']}"
    completed = git(["ls-remote", "--heads", repository["remote"], ref], check=False)
    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip()
        category = "authentication_failed" if "permission denied" in message.lower() else "dependency_unavailable"
        raise AdapterError(f"{category}: remote reference check failed: {message}")
    fields = completed.stdout.strip().split()
    if len(fields) != 2:
        raise AdapterError(f"dependency_unavailable: remote reference not found: {ref}")
    return fields[0]


def capability_evidence(settings):
    commands = {}
    for command in settings["capabilities"]["required_commands"]:
        commands[command] = shutil.which(command)
    missing = [name for name, path in commands.items() if path is None]
    if missing:
        raise AdapterError("dependency_unavailable: missing commands: " + ", ".join(missing))
    live_remote_head = None
    if settings["capabilities"].get("requires_remote_reference_read", False):
        live_remote_head = remote_head(settings)
    evidence = {
        "schema_version": 1,
        "status": "passed",
        "captured_at": utc_now(),
        "commands": commands,
        "remote_reference_readable": live_remote_head is not None,
        "remote_head": live_remote_head,
        "write_operations": [],
    }
    inputs = {
        "required_commands": sorted(commands),
        "remote_reference_readable": live_remote_head is not None,
        "remote": settings["repository"]["expected_remote"],
    }
    return evidence, inputs, live_remote_head


def repository_evidence(record, release_id, live_remote_head=None):
    settings = config()
    repository = settings["repository"]
    scope = sorted(set(record["change_summary"]["scope"]))
    governance_paths = list(repository.get("governance_paths", []))
    record_relative = str(record_path(release_id).relative_to(ROOT))
    governance_paths.append(record_relative)

    root = Path(git(["rev-parse", "--show-toplevel"]).stdout.strip()).resolve()
    if root != ROOT:
        raise AdapterError(f"wrong repository root: {root}")
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
    if branch != repository["default_branch"]:
        raise AdapterError(f"wrong branch: {branch}")
    remote_url = git(["remote", "get-url", repository["remote"]]).stdout.strip()
    if remote_url != repository["expected_remote"]:
        raise AdapterError(f"wrong remote: {remote_url}")

    source_revision = git(["rev-parse", f"{record['source_revision']}^{{commit}}"]).stdout.strip()
    local_head = git(["rev-parse", "HEAD"]).stdout.strip()
    if live_remote_head is None:
        live_remote_head = remote_head(settings)
    if not ensure_local_object(live_remote_head):
        raise AdapterError(
            "state_conflict: remote main moved to an object not available locally; "
            "run a read-only remote check first, then fetch only if scope comparison is required"
        )

    if git(["merge-base", "--is-ancestor", local_head, live_remote_head], check=False).returncode != 0:
        raise AdapterError("state_conflict: local HEAD is not contained in the remote branch")
    if git(["merge-base", "--is-ancestor", source_revision, live_remote_head], check=False).returncode != 0:
        raise AdapterError("state_conflict: source_revision is not contained in the remote branch")

    source_scope_digest = tree_listing_digest(source_revision, scope)
    remote_scope_digest = tree_listing_digest(live_remote_head, scope)
    if source_scope_digest != remote_scope_digest:
        raise AdapterError("state_conflict: release scope changed after source_revision")

    dirty = status_paths()
    dirty_in_scope = [path for path in dirty if path_in_roots(path, scope)]
    dirty_governance = [path for path in dirty if path_in_roots(path, governance_paths)]
    dirty_outside = [
        path for path in dirty if path not in set(dirty_in_scope + dirty_governance)
    ]
    if dirty_in_scope:
        raise AdapterError("state_conflict: dirty release scope: " + ", ".join(dirty_in_scope))
    if dirty_governance:
        raise AdapterError(
            "state_conflict: governance or release record changes are not committed: "
            + ", ".join(dirty_governance)
        )
    if dirty_outside and not repository.get("allow_dirty_outside_scope", False):
        raise AdapterError("state_conflict: unrelated worktree changes are present")

    evidence = {
        "schema_version": 1,
        "release_id": release_id,
        "status": "passed",
        "captured_at": utc_now(),
        "repository_root": str(ROOT),
        "branch": branch,
        "remote": repository["remote"],
        "remote_url": remote_url,
        "local_head": local_head,
        "remote_head": live_remote_head,
        "source_revision": source_revision,
        "scope": scope,
        "scope_digest": source_scope_digest,
        "dirty_outside_scope": dirty_outside,
    }
    inputs = {
        "remote_url": remote_url,
        "branch": branch,
        "source_revision": source_revision,
        "scope": scope,
        "scope_digest": source_scope_digest,
    }
    return evidence, inputs


def command_prepare(args):
    settings = config()
    validate_mode(settings, args.mode)
    path = record_path(args.release_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    completed = run_gate(
        [
            "new-record",
            "--release-id",
            args.release_id,
            "--project-id",
            settings["project"]["id"],
            "--mode",
            args.mode,
            "--output",
            str(path),
        ]
    )
    record = load_json(path)
    record["project_adapter"] = {
        "billable_model_request_allowed": False,
        "deploy_runner": "",
        "package_required_paths": [],
        "protected_services": [],
        "release_kind": "batch",
        "release_plan": "computed-from-change-summary.scope-at-verify",
    }
    write_json(path, record)
    print(completed.stdout.strip())
    print(f"next=complete_and_commit {path.relative_to(ROOT)}")


def command_verify(args):
    record, mode, _, validation_evidence = validate_record(args.release_id)
    plan = release_plan(record, args.release_id) if mode != "light" else None
    checkpoint_set(
        args.release_id,
        mode,
        "prepare",
        "passed",
        add_plan_input(prepare_inputs(record), plan),
        validation_evidence,
    )
    if mode == "light":
        print("prepare=passed mode=light production_gates=not_started")
        return
    capability, capability_inputs, live_remote_head = capability_evidence(config())
    capability_path = state_dir(args.release_id) / "preflight-permissions.json"
    write_json(capability_path, capability)
    checkpoint_set(
        args.release_id,
        mode,
        "preflight_permissions",
        "passed",
        capability_inputs,
        capability_path,
    )
    evidence, inputs = repository_evidence(
        record, args.release_id, live_remote_head=live_remote_head
    )
    add_plan_input(inputs, plan)
    evidence["release_plan"] = {
        "path": str((state_dir(args.release_id) / "release-plan.json").relative_to(ROOT)),
        "sha256": plan["release_plan_sha256"],
        "minimum_mode": plan["minimum_mode"],
        "acceptance_level": plan["acceptance_level"],
        "matched_rules": [item["id"] for item in plan["matched_rules"]],
    }
    evidence_path = state_dir(args.release_id) / "repository-gate.json"
    write_json(evidence_path, evidence)
    checkpoint_set(
        args.release_id,
        mode,
        "repository_gate",
        "passed",
        inputs,
        evidence_path,
    )
    print(json.dumps(evidence, ensure_ascii=False, indent=2, sort_keys=True))


def command_package(args):
    record, mode, path, _ = validate_record(args.release_id)
    plan = release_plan(record, args.release_id)
    checkpoint_verify(args.release_id, mode, "repository_gate")
    settings = config()
    source_revision = git(["rev-parse", f"{record['source_revision']}^{{commit}}"]).stdout.strip()
    release_paths = list(record["change_summary"]["scope"])
    release_paths.extend(settings["package"].get("always_include", []))
    release_paths.extend(record["project_adapter"].get("package_required_paths", []))
    release_paths = sorted(set(release_paths))
    for release_path in release_paths:
        if git(["cat-file", "-e", f"{source_revision}:{release_path}"], check=False).returncode != 0:
            raise AdapterError(f"artifact_invalid: path missing at source_revision: {release_path}")

    artifact_dir = state_dir(args.release_id) / "artifacts"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    artifact = artifact_dir / f"{args.release_id}-{source_revision[:12]}.tar.gz"
    manifest = artifact_dir / "manifest.json"
    completed = run(
        [
            "git",
            "archive",
            "--format=tar.gz",
            "--output",
            str(artifact),
            source_revision,
            "--",
        ]
        + release_paths,
        check=False,
    )
    if completed.returncode != 0:
        raise AdapterError(completed.stderr.strip() or "artifact_invalid: archive failed")

    command = [
        "package-manifest",
        "--release-id",
        args.release_id,
        "--source-revision",
        source_revision,
        "--artifact",
        str(artifact),
        "--output",
        str(manifest),
    ]
    for required in release_paths:
        command.extend(["--required", required])
    run_gate(command)
    manifest_data = load_json(manifest)
    inputs = {
        "source_revision": source_revision,
        "paths": release_paths,
        "artifact_sha256": manifest_data["artifact"]["sha256"],
    }
    add_plan_input(inputs, plan)
    checkpoint_set(
        args.release_id,
        mode,
        "package_manifest",
        "passed",
        inputs,
        manifest,
    )
    record["artifact_digest"] = {
        "status": "passed",
        "details": {
            "algorithm": "sha256",
            "value": manifest_data["artifact"]["sha256"],
            "artifact": str(artifact.relative_to(ROOT)),
            "manifest": str(manifest.relative_to(ROOT)),
        },
    }
    record["updated_at"] = utc_now()
    write_json(path, record)
    print(json.dumps(manifest_data, ensure_ascii=False, indent=2, sort_keys=True))
    print(f"next=attest_then_commit_once {path.relative_to(ROOT)}")


def command_attest(args):
    record, mode, path, _ = validate_record(args.release_id)
    plan = release_plan(record, args.release_id)
    checkpoint_verify(args.release_id, mode, "package_manifest")
    attestation = load_json(args.attestation)
    status = attestation.get("status")
    if status not in {"passed", "not_applicable"}:
        raise AdapterError("attestation status must be passed or not_applicable")
    if status == "passed":
        expected_artifact = validate_build_attestation(attestation, record, plan)
        inputs = {
            "source_revision": record["source_revision"],
            "artifact_sha256": expected_artifact,
            "attestation_sha256": file_digest(args.attestation),
            "release_plan_sha256": plan["release_plan_sha256"],
        }
        checkpoint_set(
            args.release_id,
            mode,
            "ci_attestation_gate",
            "passed",
            inputs,
            args.attestation,
        )
    else:
        reason = attestation.get("reason")
        if not reason:
            raise AdapterError("not_applicable attestation requires reason")
        checkpoint_set(
            args.release_id,
            mode,
            "ci_attestation_gate",
            "not_applicable",
            {
                "reason": reason,
                "source_revision": record["source_revision"],
                "release_plan_sha256": plan["release_plan_sha256"],
            },
            args.attestation,
            reason,
        )
    record["build_attestation"] = attestation
    record["updated_at"] = utc_now()
    write_json(path, record)
    print(f"attestation={status}")
    print(f"next=commit_and_push_release_evidence_once {path.relative_to(ROOT)}")


def probe(check):
    context = None
    if not check.get("tls_verify", True):
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    request = urllib.request.Request(check["url"], method="GET")
    try:
        response = urllib.request.urlopen(request, timeout=15, context=context)
        status = response.status
        headers = dict(response.headers.items())
        body = response.read(65536)
    except urllib.error.HTTPError as exc:
        status = exc.code
        headers = dict(exc.headers.items())
        body = exc.read(65536)
    except Exception as exc:
        raise AdapterError(f"dependency_unavailable: {check['id']}: {exc}") from exc

    passed = status == check["expected_status"]
    header_result = None
    expected_header = check.get("expected_header")
    if expected_header:
        actual = ""
        for name, value in headers.items():
            if name.lower() == expected_header["name"].lower():
                actual = value
                break
        header_result = {
            "name": expected_header["name"],
            "expected_contains": expected_header["contains"],
            "actual": actual,
        }
        passed = passed and expected_header["contains"] in actual
    return {
        "id": check["id"],
        "url": check["url"],
        "status": status,
        "expected_status": check["expected_status"],
        "header": header_result,
        "body_sha256_prefix_64k": hashlib.sha256(body).hexdigest(),
        "passed": passed,
    }


def run_public_checks(ids=None):
    settings = config()
    checks = settings["target"]["public_checks"]
    if ids is not None:
        selected = set(ids)
        checks = [item for item in checks if item["id"] in selected]
        missing = selected - {item["id"] for item in checks}
        if missing:
            raise AdapterError("unknown acceptance checks: " + ", ".join(sorted(missing)))
    results = [probe(item) for item in checks]
    if not all(item["passed"] for item in results):
        raise AdapterError("target_drift: one or more public checks failed")
    return results


def command_preflight(args):
    record, mode, _, _ = validate_record(args.release_id)
    if mode not in {"protected", "enhanced"}:
        raise AdapterError("target preflight is only used in protected or enhanced mode")
    plan = release_plan(record, args.release_id)
    evidence, inputs = repository_evidence(record, args.release_id)
    add_plan_input(inputs, plan)
    repository_path = state_dir(args.release_id) / "repository-gate.json"
    write_json(repository_path, evidence)
    checkpoint_set(
        args.release_id,
        mode,
        "repository_gate",
        "passed",
        inputs,
        repository_path,
    )
    checkpoint_verify(args.release_id, mode, "ci_attestation_gate")
    runtime_evidence = load_json(args.evidence)
    validate_runtime_evidence(runtime_evidence, record, plan)
    public_ids = plan["public_preflight_checks"]
    results = run_public_checks(public_ids)
    snapshot = {
        "schema_version": 1,
        "release_id": args.release_id,
        "status": "passed",
        "captured_at": utc_now(),
        "release_plan_sha256": plan["release_plan_sha256"],
        "runtime_evidence": runtime_evidence,
        "checks": results,
        "protected_services": plan["affected_services"],
        "write_operations": [],
    }
    snapshot_path = state_dir(args.release_id) / "target-preflight.json"
    write_json(snapshot_path, snapshot)
    preflight_inputs = {
        "repository_scope_digest": inputs["scope_digest"],
        "checks_digest": canonical_digest(results),
        "protected_services": snapshot["protected_services"],
        "release_plan_sha256": plan["release_plan_sha256"],
        "runtime_evidence_sha256": file_digest(args.evidence),
    }
    checkpoint_set(
        args.release_id,
        mode,
        "target_preflight",
        "passed",
        preflight_inputs,
        snapshot_path,
    )
    print(json.dumps(snapshot, ensure_ascii=False, indent=2, sort_keys=True))


def safe_extract(archive, destination):
    destination = Path(destination).resolve()
    with tarfile.open(archive, "r:*") as handle:
        for member in handle.getmembers():
            if member.issym() or member.islnk():
                raise AdapterError(
                    f"artifact_invalid: links are not allowed in deploy artifacts: {member.name}"
                )
            target = (destination / member.name).resolve()
            try:
                target.relative_to(destination)
            except ValueError as exc:
                raise AdapterError(f"artifact_invalid: unsafe archive path: {member.name}") from exc
        handle.extractall(destination)


def validate_runner(settings, record, staged_root, plan):
    runner = record["project_adapter"].get("deploy_runner")
    if not runner:
        raise AdapterError("project_adapter.deploy_runner is required for deployment")
    if not path_in_roots(runner, settings["deployment"]["allowed_runner_roots"]):
        raise AdapterError(f"deploy runner is outside allowed roots: {runner}")
    path = (staged_root / runner).resolve()
    try:
        path.relative_to(staged_root.resolve())
    except ValueError as exc:
        raise AdapterError("deploy runner escapes the staged artifact") from exc
    if not path.is_file():
        raise AdapterError(f"deploy runner missing from staged artifact: {runner}")
    content = path.read_text(encoding="utf-8")
    scoped_marker = settings["deployment"]["scoped_marker"]
    if scoped_marker not in content:
        raise AdapterError(f"deploy runner is missing marker: {scoped_marker}")
    targets_marker = settings["deployment"].get("targets_marker")
    declared_targets = None
    if targets_marker:
        for line in content.splitlines():
            if targets_marker in line:
                declared_targets = [
                    item.strip()
                    for item in line.split(targets_marker, 1)[1].split(",")
                    if item.strip()
                ]
                break
        if declared_targets is None:
            raise AdapterError(f"deploy runner is missing marker: {targets_marker}")
        if set(declared_targets) != set(plan["deployment_targets"]):
            raise AdapterError(
                "state_conflict: deploy runner targets do not match release plan"
            )
    if record["mode"] in settings["deployment"]["target_lock_required_modes"]:
        lock_marker = settings["deployment"]["target_lock_marker"]
        if lock_marker not in content:
            raise AdapterError(f"enhanced deploy runner is missing marker: {lock_marker}")
    return runner, path


def command_deploy(args):
    if args.confirm != args.release_id:
        raise AdapterError("deployment requires --confirm to exactly match the release id")
    record, mode, _, _ = validate_record(args.release_id)
    if mode not in {"protected", "enhanced"}:
        raise AdapterError("deployment is only allowed in protected or enhanced mode")
    plan = release_plan(record, args.release_id)
    repository, repository_inputs = repository_evidence(record, args.release_id)
    add_plan_input(repository_inputs, plan)
    repository_path = state_dir(args.release_id) / "repository-gate.json"
    write_json(repository_path, repository)
    checkpoint_set(
        args.release_id,
        mode,
        "repository_gate",
        "passed",
        repository_inputs,
        repository_path,
    )
    checkpoint_verify(args.release_id, mode, "target_preflight")

    manifest_path = state_dir(args.release_id) / "artifacts" / "manifest.json"
    manifest = load_json(manifest_path)
    artifact = Path(manifest["artifact"]["path"])
    if file_digest(artifact) != manifest["artifact"]["sha256"]:
        raise AdapterError("artifact_invalid: artifact digest changed after preflight")

    deployment_dir = state_dir(args.release_id) / "deployment"
    deployment_dir.mkdir(parents=True, exist_ok=True)
    stdout_path = deployment_dir / "stdout.log"
    stderr_path = deployment_dir / "stderr.log"
    result_path = deployment_dir / "apply-result.json"
    lock_path = ROOT / config()["evidence"]["state_root"] / "librechat-production.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="librechat-release-stage-") as temporary:
        staged_root = Path(temporary)
        safe_extract(artifact, staged_root)
        runner, runner_path = validate_runner(config(), record, staged_root, plan)
        with lock_path.open("w") as lock_handle:
            try:
                fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise AdapterError("state_conflict: another local deployment holds the lock") from exc
            environment = os.environ.copy()
            environment.update(
                {
                    "RELEASE_ID": args.release_id,
                    "RELEASE_SOURCE_REVISION": record["source_revision"],
                    "RELEASE_ARTIFACT_SHA256": manifest["artifact"]["sha256"],
                }
            )
            completed = run(
                ["bash", runner_path] + args.runner_args,
                check=False,
                cwd=staged_root,
                env=environment,
            )

    stdout_path.write_text(completed.stdout, encoding="utf-8")
    stderr_path.write_text(completed.stderr, encoding="utf-8")
    result = {
        "schema_version": 1,
        "release_id": args.release_id,
        "status": "passed" if completed.returncode == 0 else "failed",
        "captured_at": utc_now(),
        "runner": runner,
        "exit_code": completed.returncode,
        "artifact_sha256": manifest["artifact"]["sha256"],
        "stdout": str(stdout_path),
        "stderr": str(stderr_path),
    }
    write_json(result_path, result)
    inputs = {
        "runner": runner,
        "artifact_sha256": manifest["artifact"]["sha256"],
        "target_preflight": load_json(state_dir(args.release_id) / "target-preflight.json"),
        "release_plan_sha256": plan["release_plan_sha256"],
        "deployment_targets": plan["deployment_targets"],
    }
    if completed.returncode != 0:
        checkpoint_set(
            args.release_id,
            mode,
            "apply_gate",
            "failed",
            inputs,
            result_path,
            "deployment_failed: versioned runner returned non-zero",
        )
        raise AdapterError("deployment_failed: versioned runner returned non-zero")
    checkpoint_set(
        args.release_id,
        mode,
        "apply_gate",
        "passed",
        inputs,
        result_path,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


def command_acceptance(args):
    record, mode, _, _ = validate_record(args.release_id)
    if mode not in {"protected", "enhanced"}:
        raise AdapterError("acceptance is only used after protected or enhanced deployment")
    plan = release_plan(record, args.release_id)
    checkpoint_verify(args.release_id, mode, "apply_gate")
    external_evidence = {
        "status": "passed",
        "source_revision": record["source_revision"],
        "release_plan_sha256": plan["release_plan_sha256"],
        "checks": [],
        "billable_model_requests": 0,
    }
    if plan["acceptance_checks"]:
        if not args.evidence:
            raise AdapterError(
                "acceptance_failed: this release plan requires --evidence for business checks"
            )
        external_evidence = load_json(args.evidence)
        validate_acceptance_evidence(external_evidence, record, plan)
    check_ids = plan["public_acceptance_checks"]
    results = run_public_checks(check_ids)
    evidence = {
        "schema_version": 1,
        "release_id": args.release_id,
        "status": "passed",
        "captured_at": utc_now(),
        "release_plan_sha256": plan["release_plan_sha256"],
        "acceptance_level": plan["acceptance_level"],
        "external_evidence": external_evidence,
        "checks": results,
        "conversation_created": bool(external_evidence.get("conversation_created", False)),
        "billable_model_request_sent": bool(
            external_evidence.get("billable_model_requests", 0)
        ),
    }
    path = state_dir(args.release_id) / "acceptance-result.json"
    write_json(path, evidence)
    checkpoint_set(
        args.release_id,
        mode,
        "acceptance_gate",
        "passed",
        {
            "checks_digest": canonical_digest(results),
            "release_plan_sha256": plan["release_plan_sha256"],
            "external_evidence_sha256": (
                file_digest(args.evidence) if args.evidence else None
            ),
        },
        path,
    )
    print(json.dumps(evidence, ensure_ascii=False, indent=2, sort_keys=True))


def command_finalize(args):
    record, mode, path, evidence = validate_record(args.release_id)
    plan = release_plan(record, args.release_id) if mode != "light" else None
    required = config()["risk_modes"][mode]["required_gates"]
    previous = required[-2] if required[-1] == "release_record" else required[-1]
    terminal = record["status"] in {"rolled_back", "blocked", "failed"}
    if not terminal:
        checkpoint_verify(args.release_id, mode, previous)
    if "repository_gate" in required:
        repository, repository_inputs = repository_evidence(record, args.release_id)
        add_plan_input(repository_inputs, plan)
        repository_path = state_dir(args.release_id) / "repository-gate.json"
        write_json(repository_path, repository)
        checkpoint_set(
            args.release_id,
            mode,
            "repository_gate",
            "passed",
            repository_inputs,
            repository_path,
        )
    if record["status"] not in {"ready", "deployed", "rolled_back", "blocked", "failed"}:
        raise AdapterError("final release record status is not complete")
    if mode in {"protected", "enhanced"} and record["status"] == "deployed":
        required_evidence = ["runtime_snapshot", "acceptance_result"]
        if plan["data_backup_required"]:
            required_evidence.append("backup_reference")
        elif record.get("backup_reference", {}).get("status") == "not_applicable":
            if not record["backup_reference"].get("reason"):
                raise AdapterError("backup_reference not_applicable requires a reason")
        else:
            required_evidence.append("backup_reference")
        for key in required_evidence:
            if record.get(key, {}).get("status") != "passed":
                raise AdapterError(f"final protected release requires {key}.status=passed")
    if terminal and not record.get("unresolved_issues"):
        raise AdapterError("failed, blocked, or rolled-back release requires unresolved_issues")
    inputs = {
        "record_sha256": file_digest(path),
        "record_status": record["status"],
        "source_revision": record["source_revision"],
    }
    add_plan_input(inputs, plan)
    checkpoint_set(
        args.release_id,
        mode,
        "release_record",
        "passed",
        inputs,
        evidence,
        terminal_record=terminal,
    )
    print(f"release_record=passed path={path.relative_to(ROOT)}")


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare")
    prepare.add_argument("release_id")
    prepare.add_argument("mode", choices=("light", "release", "protected", "enhanced"))
    prepare.set_defaults(func=command_prepare)

    verify = subparsers.add_parser("verify")
    verify.add_argument("release_id")
    verify.set_defaults(func=command_verify)

    package = subparsers.add_parser("package")
    package.add_argument("release_id")
    package.set_defaults(func=command_package)

    attest = subparsers.add_parser("attest")
    attest.add_argument("release_id")
    attest.add_argument("attestation")
    attest.set_defaults(func=command_attest)

    preflight = subparsers.add_parser("preflight")
    preflight.add_argument("release_id")
    preflight.add_argument(
        "--evidence",
        required=True,
        help="JSON produced by the project's read-only target preflight",
    )
    preflight.set_defaults(func=command_preflight)

    deploy = subparsers.add_parser("deploy")
    deploy.add_argument("release_id")
    deploy.add_argument("--confirm", required=True)
    deploy.add_argument("runner_args", nargs=argparse.REMAINDER)
    deploy.set_defaults(func=command_deploy)

    acceptance = subparsers.add_parser("acceptance")
    acceptance.add_argument("release_id")
    acceptance.add_argument(
        "--evidence",
        help="JSON containing selected business acceptance results",
    )
    acceptance.set_defaults(func=command_acceptance)

    finalize = subparsers.add_parser("finalize")
    finalize.add_argument("release_id")
    finalize.set_defaults(func=command_finalize)

    return parser


def main():
    args = build_parser().parse_args()
    try:
        args.func(args)
    except AdapterError as exc:
        print(f"librechat_release_error={exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

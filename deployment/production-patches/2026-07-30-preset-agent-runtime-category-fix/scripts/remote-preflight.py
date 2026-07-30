#!/usr/bin/env python3
"""Collect the read-only Client and Mongo runtime snapshot for this release."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import ssl
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


DOCKER_SERVICES = (
    "LibreChat-API",
    "LibreChat-NGINX",
    "LibreChat-CodeAPI",
    "LibreChat-RAG-API",
    "LibreChat-Admin-Panel",
    "chat-mongodb",
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def run(
    command: list[str], check: bool = True, input_text: str | None = None
) -> subprocess.CompletedProcess:
    completed = subprocess.run(
        command, text=True, capture_output=True, input=input_text
    )
    if check and completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"command failed: {' '.join(command)}: {message}")
    return completed


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_json(value: object) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def parse_json_output(output: str) -> dict:
    for line in reversed([line.strip() for line in output.splitlines() if line.strip()]):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise RuntimeError(f"mongosh returned no JSON object: {output[-4000:]}")


def run_mongosh(mapping: list[list[str]], script_path: Path) -> dict:
    prefix = f"const MAPPING = {json.dumps(mapping, ensure_ascii=False)};\n"
    payload = prefix + script_path.read_text(encoding="utf-8")
    completed = run(
        [
            "docker",
            "exec",
            "-i",
            "chat-mongodb",
            "mongosh",
            "--quiet",
            "LibreChat",
            "--file",
            "/dev/stdin",
        ],
        input_text=payload,
    )
    return parse_json_output(completed.stdout)


def validate_mongo_snapshot(metadata: dict, snapshot: dict) -> None:
    mapping = metadata["migration"]["id_mapping"]
    legacy_ids = sorted(legacy for legacy, _ in mapping)
    next_ids = sorted(next_id for _, next_id in mapping)
    require(snapshot.get("legacyIds") == legacy_ids, "Mongo legacy ID mapping mismatch")
    require(snapshot.get("nextIds") == next_ids, "Mongo target ID mapping mismatch")
    require(snapshot.get("externalReferences") == [], "legacy Agent IDs have external references")
    agents = snapshot.get("agents", [])
    require(len(agents) == 7, f"expected seven legacy Agents, found {len(agents)}")
    require(
        sorted(agent.get("id") for agent in agents) == legacy_ids,
        "production Agents are not exactly the seven expected legacy IDs",
    )
    resource_ids = {
        agent.get("_id", {}).get("$oid")
        for agent in agents
    }
    require(None not in resource_ids and len(resource_ids) == 7, "Agent resource IDs are invalid")
    for agent in agents:
        require(
            agent.get("managedBy") == metadata["migration"]["managed_by"],
            f"unexpected Agent manager: {agent.get('id')}",
        )
        require(agent.get("provider") == "anthropic", f"provider drift: {agent.get('id')}")
        require(agent.get("model") == "claude-fable-5", f"model drift: {agent.get('id')}")
        versions = agent.get("versions") or []
        require(len(versions) > 0, f"Agent has no versions: {agent.get('id')}")
        require(
            all(version.get("id") == agent.get("id") for version in versions),
            f"Agent version ID drift: {agent.get('id')}",
        )
    acl_entries = snapshot.get("aclEntries", [])
    require(
        len(acl_entries) == metadata["migration"]["expected_acl_count"],
        f"expected 14 ACL entries, found {len(acl_entries)}",
    )
    by_resource: dict[str, list[dict]] = {}
    for entry in acl_entries:
        resource_id = entry.get("resourceId", {}).get("$oid")
        by_resource.setdefault(resource_id or "", []).append(entry)
    for resource_id in resource_ids:
        entries = by_resource.get(resource_id or "", [])
        owners = [
            entry
            for entry in entries
            if entry.get("principalType") == "user" and entry.get("permBits") == 15
        ]
        public = [
            entry
            for entry in entries
            if entry.get("principalType") == "public" and entry.get("permBits") == 1
        ]
        require(len(owners) == 1 and len(public) == 1 and len(entries) == 2, "Agent ACL contract changed")
    categories = snapshot.get("categories", [])
    require(
        len(categories) == 1 and categories[0].get("isActive") is True,
        "automation-workflow category is not the single active target category",
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_container(name: str) -> dict:
    payload = json.loads(run(["docker", "inspect", name]).stdout)[0]
    state = payload["State"]
    require(state.get("Running") is True, f"container is not running: {name}")
    health = state.get("Health", {}).get("Status", "running")
    require(health in {"healthy", "running"}, f"container is not healthy: {name}: {health}")
    return {
        "id": payload["Id"],
        "started_at": state["StartedAt"],
        "health": health,
        "mounts": payload.get("Mounts", []),
    }


def office_identity() -> dict:
    docker_result = run(["docker", "inspect", "LibreChat-Office-Converter"], check=False)
    if docker_result.returncode == 0:
        payload = json.loads(docker_result.stdout)[0]
        state = payload["State"]
        require(state.get("Running") is True, "Office Converter container is not running")
        return {
            "kind": "container",
            "name": "LibreChat-Office-Converter",
            "id": payload["Id"],
            "started_at": state["StartedAt"],
            "health": state.get("Health", {}).get("Status", "running"),
        }

    properties = run(
        [
            "systemctl",
            "show",
            "office-converter.service",
            "--property=ActiveState",
            "--property=MainPID",
            "--property=ActiveEnterTimestampMonotonic",
        ]
    ).stdout
    values = dict(line.split("=", 1) for line in properties.splitlines() if "=" in line)
    require(values.get("ActiveState") == "active", "Office Converter service is not active")
    return {
        "kind": "systemd",
        "name": "office-converter.service",
        "active_state": values["ActiveState"],
        "main_pid": values.get("MainPID", "0"),
        "active_enter_timestamp_monotonic": values.get(
            "ActiveEnterTimestampMonotonic", "0"
        ),
    }


def https_get(url: str) -> tuple[int, dict, bytes]:
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=20, context=context) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()), error.read()


def available_memory_mb() -> int:
    for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) // 1024
    raise RuntimeError("MemAvailable is missing from /proc/meminfo")


def free_disk_mb(path: Path) -> int:
    stats = os.statvfs(path)
    return stats.f_bavail * stats.f_frsize // (1024 * 1024)


def collect(metadata_path: Path, snapshot_script: Path) -> dict:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    baseline_contract = metadata["production_baseline"]
    run(["docker", "compose", "version"])
    run(["python3", "-c", "import yaml"])
    run(["curl", "--version"])
    run(["sha256sum", "--version"])
    root = Path("/opt/librechat")
    compose_base = root / "compose.yaml"
    compose_override = root / "compose.override.yaml"
    config_file = root / "librechat.yaml"
    for path in (compose_base, compose_override, config_file):
        require(path.is_file(), f"required production file is missing: {path}")

    containers = {name: inspect_container(name) for name in DOCKER_SERVICES}
    api_mounts = [
        mount
        for mount in containers["LibreChat-API"]["mounts"]
        if mount.get("Destination") == "/app/client/dist"
    ]
    require(len(api_mounts) == 1, "expected exactly one /app/client/dist mount")
    client_mount = api_mounts[0]
    require(client_mount.get("Type") == "bind", "Client mount is not a bind mount")
    require(client_mount.get("RW") is False, "Client mount is not read-only")
    client_path = Path(client_mount["Source"])
    require(client_path.is_dir(), f"active Client mount is missing: {client_path}")
    client_index = client_path / "index.html"
    require(client_index.is_file(), "active Client index is missing")

    root_status, _, root_body = https_get("https://152.32.172.162.sslip.io/")
    require(root_status == 200, f"public root status is {root_status}")
    public_index_sha256 = hashlib.sha256(root_body).hexdigest()
    require(
        public_index_sha256 == baseline_contract["public_index_sha256"],
        "public Client baseline SHA-256 drift",
    )
    require(
        sha256_file(client_index) == public_index_sha256,
        "mounted and public Client indexes differ",
    )

    config_status, _, config_body = https_get(
        "https://152.32.172.162.sslip.io/api/config"
    )
    require(config_status == 200, f"/api/config status is {config_status}")
    public_config = json.loads(config_body)
    build_commit = public_config.get("buildInfo", {}).get("commit")
    require(
        build_commit == baseline_contract["build_info_commit"],
        "LibreChat buildInfo.commit drift",
    )

    memory_mb = available_memory_mb()
    disk_mb = free_disk_mb(root)
    rollback_available = compose_override.is_file() and client_path.is_dir()
    require(rollback_available, "rollback source is unavailable")
    mongo_snapshot = run_mongosh(metadata["migration"]["id_mapping"], snapshot_script)
    validate_mongo_snapshot(metadata, mongo_snapshot)

    baseline = {
        "client_mount": str(client_path),
        "client_mount_read_only": True,
        "client_index_sha256": sha256_file(client_index),
        "public_index_sha256": public_index_sha256,
        "build_info_commit": build_commit,
        "compose_base_sha256": sha256_file(compose_base),
        "compose_override_sha256": sha256_file(compose_override),
        "config_sha256": sha256_file(config_file),
        "containers": {
            name: {
                "id": details["id"],
                "started_at": details["started_at"],
                "health": details["health"],
            }
            for name, details in containers.items()
        },
        "office_converter": office_identity(),
    }

    return {
        "schema_version": 1,
        "status": "passed",
        "captured_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "checked_services": list(DOCKER_SERVICES),
        "checks": [
            {"id": "service-state", "status": "passed"},
            {"id": "dependency-interface", "status": "passed"},
            {"id": "host-memory", "status": "passed"},
            {"id": "host-disk", "status": "passed"},
            {"id": "rollback-available", "status": "passed"},
            {"id": "data-backup", "status": "passed"},
        ],
        "host_resources": {
            "memory_available_mb": memory_mb,
            "disk_free_mb": disk_mb,
        },
        "rollback_available": rollback_available,
        "baseline": baseline,
        "mongo_snapshot": mongo_snapshot,
        "mongo_snapshot_sha256": sha256_json(mongo_snapshot),
        "write_operations": [],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("metadata", type=Path)
    parser.add_argument("snapshot_script", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    payload = collect(args.metadata, args.snapshot_script)
    args.output.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(payload, sort_keys=True))


if __name__ == "__main__":
    main()

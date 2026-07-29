#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import shutil
import ssl
import subprocess
import urllib.error
import urllib.request
from pathlib import Path


CONTAINERS = [
    "LibreChat-API",
    "LibreChat-NGINX",
    "LibreChat-CodeAPI",
    "LibreChat-RAG-API",
    "LibreChat-Admin-Panel",
    "chat-mongodb",
]


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def verify_compiled(compiled: dict) -> None:
    expected = compiled.get("compiledDigest")
    payload = {key: value for key, value in compiled.items() if key != "compiledDigest"}
    actual = sha256_text(canonical_json(payload))
    if expected != actual:
        raise RuntimeError(f"compiled catalog digest mismatch: expected {expected}, got {actual}")
    if len(compiled.get("agents", [])) != 7:
        raise RuntimeError("compiled catalog must contain exactly 7 agents")


def run(command: list[str], *, input_text: str | None = None) -> str:
    result = subprocess.run(
        command,
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"command failed ({result.returncode}): {' '.join(command)}\n"
            f"stdout: {result.stdout[-4000:]}\n"
            f"stderr: {result.stderr[-4000:]}"
        )
    return result.stdout


def parse_json_output(output: str) -> dict:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    for line in reversed(lines):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise RuntimeError(f"no JSON object found in command output: {output[-4000:]}")


def run_mongosh(compiled: dict, script_path: Path, *, backup: dict | None = None) -> dict:
    prefix = f"const COMPILED = {json.dumps(compiled, ensure_ascii=False)};\n"
    if backup is not None:
        backup_ejson = json.dumps(backup, ensure_ascii=False, separators=(",", ":"))
        prefix += f"const BACKUP = EJSON.parse({json.dumps(backup_ejson, ensure_ascii=False)});\n"
    payload = prefix + script_path.read_text(encoding="utf-8")
    output = run(
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
    return parse_json_output(output)


def collect_target_snapshot(compiled: dict, script_path: Path) -> dict:
    snapshot = run_mongosh(compiled, script_path)
    if snapshot.get("catalogDigest") != compiled.get("compiledDigest"):
        raise RuntimeError("Mongo snapshot catalog digest mismatch")
    return snapshot


def snapshot_digest(snapshot: dict) -> str:
    return sha256_text(canonical_json(snapshot))


def container_snapshot() -> dict:
    inspected = json.loads(run(["docker", "inspect", *CONTAINERS]))
    by_name = {}
    for item in inspected:
        name = item.get("Name", "").lstrip("/")
        state = item.get("State", {})
        by_name[name] = {
            "id": item.get("Id"),
            "image": item.get("Image"),
            "status": state.get("Status"),
            "health": (state.get("Health") or {}).get("Status"),
            "startedAt": state.get("StartedAt"),
        }
    missing = [name for name in CONTAINERS if name not in by_name]
    if missing:
        raise RuntimeError(f"missing containers: {', '.join(missing)}")
    return {name: by_name[name] for name in CONTAINERS}


def validate_container_health(containers: dict) -> None:
    for name, state in containers.items():
        if state.get("status") != "running":
            raise RuntimeError(f"{name} is not running")
        if state.get("health") not in (None, "healthy"):
            raise RuntimeError(f"{name} health is {state.get('health')}")


def read_runtime_config() -> dict:
    script = r'''
const fs = require('fs');
const YAML = require('yaml');
const config = YAML.parse(fs.readFileSync('/app/librechat.yaml', 'utf8'));
console.log(JSON.stringify({
  agents: config.endpoints?.agents ?? {},
  modelSpecs: (config.modelSpecs?.list ?? []).map((entry) => ({
    name: entry.name,
    endpoint: entry.preset?.endpoint,
    model: entry.preset?.model,
  })),
}));
'''
    return parse_json_output(run(["docker", "exec", "LibreChat-API", "node", "-e", script]))


def host_resources() -> dict:
    memory_available_kb = None
    for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
        if line.startswith("MemAvailable:"):
            memory_available_kb = int(line.split()[1])
            break
    if memory_available_kb is None:
        raise RuntimeError("MemAvailable is unavailable")
    disk = shutil.disk_usage("/opt/librechat")
    return {
        "memoryAvailableMb": memory_available_kb // 1024,
        "diskFreeMb": disk.free // (1024 * 1024),
    }


def http_check(url: str, expected_status: int, *, expected_realm: str | None = None) -> dict:
    context = ssl._create_unverified_context()
    request = urllib.request.Request(url, headers={"User-Agent": "librechat-release-preflight/1"})
    try:
        with urllib.request.urlopen(request, context=context, timeout=20) as response:
            status = response.status
            headers = response.headers
            body = response.read(65536)
    except urllib.error.HTTPError as error:
        status = error.code
        headers = error.headers
        body = error.read(65536)
    if status != expected_status:
        raise RuntimeError(f"{url} returned {status}, expected {expected_status}")
    auth = headers.get("WWW-Authenticate", "")
    if expected_realm and expected_realm not in auth:
        raise RuntimeError(f"{url} did not return realm {expected_realm}")
    return {
        "url": url,
        "status": status,
        "bodySha256Prefix64k": hashlib.sha256(body).hexdigest(),
        "wwwAuthenticate": auth or None,
    }


def public_checks() -> dict:
    return {
        "mainRoot": http_check("https://152.32.172.162.sslip.io/", 200),
        "apiConfig": http_check("https://152.32.172.162.sslip.io/api/config", 200),
        "adminRoot": http_check("https://admin.152.32.172.162.sslip.io/", 200),
        "officeBoundary": http_check(
            "https://152.32.172.162.sslip.io/office/",
            401,
            expected_realm="Office Converter",
        ),
    }


def oid(value: object) -> str | None:
    if isinstance(value, dict) and isinstance(value.get("$oid"), str):
        return value["$oid"]
    if isinstance(value, str):
        return value
    return None


def validate_target_snapshot(compiled: dict, snapshot: dict) -> None:
    owners = snapshot.get("ownerCandidates", [])
    if len(owners) != 1 or owners[0].get("role") != "ADMIN":
        raise RuntimeError("expected exactly one ADMIN owner named admin")
    owner_id = oid(owners[0].get("_id"))
    roles = {entry.get("accessRoleId"): entry for entry in snapshot.get("accessRoles", [])}
    if roles.get("agent_owner", {}).get("permBits") != 15:
        raise RuntimeError("agent_owner role is missing or invalid")
    if roles.get("agent_viewer", {}).get("permBits") != 1:
        raise RuntimeError("agent_viewer role is missing or invalid")

    expected_ids = {agent["id"] for agent in compiled["agents"]}
    agents = snapshot.get("agents", [])
    for agent in agents:
        if agent.get("id") not in expected_ids:
            raise RuntimeError(f"unexpected target agent {agent.get('id')}")
        if agent.get("managedBy") != "librechat-preset-workflow-agents":
            raise RuntimeError(f"{agent.get('id')} conflicts with an unmanaged Agent")
        if oid(agent.get("author")) != owner_id:
            raise RuntimeError(f"{agent.get('id')} has a different owner")

    target_resources = {oid(agent.get("_id")): agent.get("id") for agent in agents}
    acl_by_resource: dict[str, list[dict]] = {}
    for entry in snapshot.get("aclEntries", []):
        resource_id = oid(entry.get("resourceId"))
        acl_by_resource.setdefault(resource_id or "", []).append(entry)
    for resource_id, agent_id in target_resources.items():
        entries = acl_by_resource.get(resource_id or "", [])
        owners_for_agent = [
            entry
            for entry in entries
            if entry.get("principalType") == "user" and oid(entry.get("principalId")) == owner_id
        ]
        public_for_agent = [entry for entry in entries if entry.get("principalType") == "public"]
        other = [entry for entry in entries if entry not in owners_for_agent and entry not in public_for_agent]
        if len(owners_for_agent) > 1 or len(public_for_agent) > 1 or other:
            raise RuntimeError(f"{agent_id} has conflicting ACL entries")

    for category in snapshot.get("categories", []):
        if category.get("value") == compiled["category"]["value"] and category.get("custom") is True:
            raise RuntimeError("automation-workflow conflicts with a custom category")


def validate_runtime_config(compiled: dict, runtime_config: dict) -> None:
    agents_config = runtime_config.get("agents", {})
    capabilities = set(agents_config.get("capabilities", []))
    required = {capability for agent in compiled["agents"] for capability in agent["tools"]}
    missing = sorted(required - capabilities)
    if missing:
        raise RuntimeError(f"missing Agent capabilities: {', '.join(missing)}")
    if "anthropic" not in set(agents_config.get("allowedProviders", [])):
        raise RuntimeError("anthropic is not an allowed Agent provider")
    models = {
        (entry.get("name"), entry.get("endpoint"), entry.get("model"))
        for entry in runtime_config.get("modelSpecs", [])
    }
    if ("claude-fable-5", "anthropic", "claude-fable-5") not in models:
        raise RuntimeError("claude-fable-5 model spec is unavailable")

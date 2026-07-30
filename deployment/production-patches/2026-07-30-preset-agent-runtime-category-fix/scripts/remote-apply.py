#!/usr/bin/env python3
"""Apply the bounded preset-Agent ID migration and verified Client artifact."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import shutil
import ssl
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

import yaml


ROOT = Path("/opt/librechat")
COMPOSE_BASE = ROOT / "compose.yaml"
COMPOSE_OVERRIDE = ROOT / "compose.override.yaml"
ENV_FILE = ROOT / ".env"
CONFIG_FILE = ROOT / "librechat.yaml"


def run(command: list[str], *, input_text: str | None = None) -> str:
    completed = subprocess.run(
        command, input=input_text, text=True, capture_output=True, check=False
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"command failed ({completed.returncode}): {' '.join(command)}\n"
            f"stdout: {completed.stdout[-4000:]}\nstderr: {completed.stderr[-4000:]}"
        )
    return completed.stdout


def parse_json_output(output: str) -> dict:
    for line in reversed([line.strip() for line in output.splitlines() if line.strip()]):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise RuntimeError(f"no JSON object in command output: {output[-4000:]}")


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_json(value: object) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_mongosh(mapping: list[list[str]], script: Path) -> dict:
    prefix = f"const MAPPING = {json.dumps(mapping, ensure_ascii=False)};\n"
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
        input_text=prefix + script.read_text(encoding="utf-8"),
    )
    return parse_json_output(output)


def extract_client(artifact_zip: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    with zipfile.ZipFile(artifact_zip) as bundle:
        tar_payload = bundle.read("client-dist.tar.gz")
    with tarfile.open(fileobj=io.BytesIO(tar_payload), mode="r:gz") as archive:
        for member in archive.getmembers():
            relative = PurePosixPath(member.name)
            if relative.is_absolute() or ".." in relative.parts:
                raise RuntimeError(f"unsafe Client archive path: {member.name}")
            while str(relative).startswith("./"):
                relative = PurePosixPath(str(relative)[2:])
            if str(relative) in {"", "."}:
                continue
            target = (destination / str(relative)).resolve()
            target.relative_to(destination)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                target.chmod(0o555)
                continue
            if not member.isfile():
                raise RuntimeError(f"unsupported Client archive member: {member.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise RuntimeError(f"unable to read Client archive member: {member.name}")
            with target.open("wb") as handle:
                shutil.copyfileobj(source, handle)
            target.chmod(0o444)


def mount_target(entry: object) -> str:
    if isinstance(entry, str):
        parts = entry.split(":")
        return parts[1] if len(parts) > 1 else ""
    if isinstance(entry, dict):
        return str(entry.get("target", ""))
    return ""


def build_override(source: Path, destination: Path, release_client: Path) -> None:
    payload = yaml.safe_load(source.read_text(encoding="utf-8")) or {}
    api = payload.setdefault("services", {}).setdefault("api", {})
    volumes = api.setdefault("volumes", [])
    api["volumes"] = [entry for entry in volumes if mount_target(entry) != "/app/client/dist"]
    api["volumes"].append(f"{release_client}:/app/client/dist:ro")
    destination.write_text(
        yaml.safe_dump(payload, allow_unicode=True, sort_keys=False), encoding="utf-8"
    )


def http_get(url: str) -> tuple[int, dict[str, str], bytes]:
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    request = urllib.request.Request(url, headers={"User-Agent": "librechat-release/1"})
    try:
        with urllib.request.urlopen(request, timeout=20, context=context) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()), error.read()


def wait_ready() -> None:
    for _ in range(120):
        try:
            if http_get("https://152.32.172.162.sslip.io/api/config")[0] == 200:
                return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError("LibreChat API did not become ready")


def validate_migration(before: dict, after: dict, mapping: list[list[str]]) -> None:
    legacy_ids = sorted(legacy for legacy, _ in mapping)
    next_ids = sorted(next_id for _, next_id in mapping)
    if sorted(agent.get("id") for agent in before["agents"]) != legacy_ids:
        raise RuntimeError("pre-migration Agent IDs changed")
    if sorted(agent.get("id") for agent in after["agents"]) != next_ids:
        raise RuntimeError("post-migration Agent IDs are not the expected persistent IDs")
    if after.get("externalReferences") != []:
        raise RuntimeError("legacy Agent IDs gained external references during migration")

    reverse = {next_id: legacy for legacy, next_id in mapping}
    normalized_after = copy.deepcopy(after["agents"])
    for agent in normalized_after:
        agent["id"] = reverse.get(agent.get("id"), agent.get("id"))
        for version in agent.get("versions") or []:
            version["id"] = reverse.get(version.get("id"), version.get("id"))
    normalized_after.sort(key=lambda agent: (agent.get("id", ""), canonical_json(agent.get("_id"))))
    before_agents = copy.deepcopy(before["agents"])
    before_agents.sort(key=lambda agent: (agent.get("id", ""), canonical_json(agent.get("_id"))))
    if canonical_json(normalized_after) != canonical_json(before_agents):
        raise RuntimeError("Agent migration changed fields other than top-level and version IDs")
    if canonical_json(after["aclEntries"]) != canonical_json(before["aclEntries"]):
        raise RuntimeError("Agent ACL entries changed during migration")
    if canonical_json(after["categories"]) != canonical_json(before["categories"]):
        raise RuntimeError("Agent categories changed during migration")


def assert_protected_services(baseline: dict) -> dict[str, str]:
    identities = {}
    for name, expected in baseline["containers"].items():
        payload = json.loads(run(["docker", "inspect", name]))[0]
        identities[name] = payload["Id"]
        if name == "LibreChat-API":
            continue
        if (
            payload["Id"] != expected["id"]
            or payload["State"]["StartedAt"] != expected["started_at"]
        ):
            raise RuntimeError(f"protected container changed: {name}")
    return identities


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: remote-apply.py <stage-dir> <source-revision>")
    stage_dir = Path(sys.argv[1]).resolve()
    source_revision = sys.argv[2]
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    artifact_zip = stage_dir / "client-artifact.zip"
    metadata_path = stage_dir / "artifact.json"
    runtime_path = stage_dir / "runtime-preflight.json"
    verify_script = stage_dir / "verify-artifact.py"
    preflight_script = stage_dir / "remote-preflight.py"
    snapshot_script = stage_dir / "snapshot.js"
    migrate_script = stage_dir / "migrate.js"
    mongo_rollback_script = stage_dir / "rollback.js"
    rollback_runner = stage_dir / "remote-rollback.py"
    result_path = stage_dir / "DEPLOY_RESULT.json"
    for path in (
        artifact_zip,
        metadata_path,
        runtime_path,
        verify_script,
        preflight_script,
        snapshot_script,
        migrate_script,
        mongo_rollback_script,
        rollback_runner,
        COMPOSE_BASE,
        COMPOSE_OVERRIDE,
        ENV_FILE,
        CONFIG_FILE,
    ):
        if not path.is_file():
            raise RuntimeError(f"deployment input is missing: {path}")

    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
    mapping = metadata["migration"]["id_mapping"]
    if runtime.get("source_revision") != source_revision:
        raise RuntimeError("runtime preflight source revision mismatch")
    run(["python3", str(verify_script), str(artifact_zip), str(metadata_path)])

    work_dir = Path(
        run(["mktemp", "-d", "/tmp/librechat-preset-agent-runtime-category-apply.XXXXXX"])
        .strip()
    )
    release_root = ROOT / "preset-agent-runtime-category-fix" / f"{source_revision[:12]}-{timestamp}"
    release_client = release_root / "client-dist"
    backup_dir = ROOT / "backups" / f"preset-agent-runtime-category-fix-{source_revision[:12]}-{timestamp}"
    candidate_client = work_dir / "client-dist"
    candidate_override = work_dir / "compose.override.yaml"
    current_runtime = work_dir / "current-runtime.json"
    mutation_started = False
    try:
        run(
            [
                "python3",
                str(preflight_script),
                str(metadata_path),
                str(snapshot_script),
                str(current_runtime),
            ]
        )
        current = json.loads(current_runtime.read_text(encoding="utf-8"))
        if current.get("baseline") != runtime.get("baseline"):
            raise RuntimeError("production Client/service baseline drifted after preflight")
        if current.get("mongo_snapshot_sha256") != runtime.get("mongo_snapshot_sha256"):
            raise RuntimeError("production Mongo target state drifted after preflight")
        before = current["mongo_snapshot"]
        if sha256_json(before) != runtime["mongo_snapshot_sha256"]:
            raise RuntimeError("runtime Mongo snapshot digest is invalid")

        extract_client(artifact_zip, candidate_client)
        expected_index = metadata["client"]["composed_index_sha256"]
        if sha256_file(candidate_client / "index.html") != expected_index:
            raise RuntimeError("candidate Client index SHA-256 mismatch")
        build_override(COMPOSE_OVERRIDE, candidate_override, release_client)
        run(
            [
                "docker",
                "compose",
                "--env-file",
                str(ENV_FILE),
                "-f",
                str(COMPOSE_BASE),
                "-f",
                str(candidate_override),
                "config",
            ]
        )

        current_client = Path(runtime["baseline"]["client_mount"])
        api_before = runtime["baseline"]["containers"]["LibreChat-API"]["id"]
        compose_before = sha256_file(COMPOSE_OVERRIDE)
        config_before = sha256_file(CONFIG_FILE)
        release_root.mkdir(parents=True)
        backup_dir.mkdir(parents=True, mode=0o700)
        shutil.copytree(candidate_client, release_client)
        shutil.copytree(current_client, backup_dir / "client-dist")
        shutil.copy2(COMPOSE_OVERRIDE, backup_dir / "compose.override.yaml")
        shutil.copy2(runtime_path, backup_dir / "runtime-preflight.json")
        shutil.copy2(metadata_path, backup_dir / "artifact.json")
        (backup_dir / "before-target-snapshot.json").write_text(
            json.dumps(before, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        for path in (snapshot_script, migrate_script, mongo_rollback_script, rollback_runner):
            shutil.copy2(path, backup_dir / path.name)
        for path in (
            artifact_zip,
            metadata_path,
            runtime_path,
            snapshot_script,
            migrate_script,
            mongo_rollback_script,
            rollback_runner,
        ):
            shutil.copy2(path, release_root / path.name)

        if sha256_file(backup_dir / "client-dist" / "index.html") != runtime["baseline"]["client_index_sha256"]:
            raise RuntimeError("backed-up Client index SHA-256 mismatch")
        mutation_started = True
        migration_result = run_mongosh(mapping, migrate_script)
        if migration_result.get("status") != "passed":
            raise RuntimeError("Mongo migration did not report success")
        after = run_mongosh(mapping, snapshot_script)
        validate_migration(before, after, mapping)

        next_override = COMPOSE_OVERRIDE.with_name(f"compose.override.yaml.next-{timestamp}")
        shutil.copy2(candidate_override, next_override)
        next_override.replace(COMPOSE_OVERRIDE)
        run(
            [
                "docker",
                "compose",
                "--env-file",
                str(ENV_FILE),
                "-f",
                str(COMPOSE_BASE),
                "-f",
                str(COMPOSE_OVERRIDE),
                "up",
                "-d",
                "--no-deps",
                "--force-recreate",
                "api",
            ]
        )
        wait_ready()

        root_status, _, root_body = http_get("https://152.32.172.162.sslip.io/")
        api_status, _, api_body = http_get("https://152.32.172.162.sslip.io/api/config")
        admin_status, _, _ = http_get("https://admin.152.32.172.162.sslip.io/")
        office_status, office_headers, _ = http_get("https://152.32.172.162.sslip.io/office/")
        if (root_status, api_status, admin_status, office_status) != (200, 200, 200, 401):
            raise RuntimeError("post-deploy public status checks failed")
        if "Office Converter" not in office_headers.get("WWW-Authenticate", ""):
            raise RuntimeError("Office authentication boundary changed")
        if hashlib.sha256(root_body).hexdigest() != expected_index:
            raise RuntimeError("public Client index SHA-256 mismatch")
        api_config = json.loads(api_body)
        if api_config.get("buildInfo", {}).get("commit") != metadata["source"]["upstream_commit"]:
            raise RuntimeError("LibreChat buildInfo.commit changed")
        for asset in json.loads(
            (release_client / "agent-platform-client-overlay.json").read_text(encoding="utf-8")
        )["assets"]:
            status, _, body = http_get("https://152.32.172.162.sslip.io/" + asset["output"])
            if status != 200 or hashlib.sha256(body).hexdigest() != asset["sha256"]:
                raise RuntimeError(f"public protected asset mismatch: {asset['output']}")

        active_mount = run(
            [
                "docker",
                "inspect",
                "LibreChat-API",
                "--format",
                '{{range .Mounts}}{{if eq .Destination "/app/client/dist"}}{{.Source}}{{end}}{{end}}',
            ]
        ).strip()
        if active_mount != str(release_client):
            raise RuntimeError("LibreChat-API did not mount the release Client")
        api_after = json.loads(run(["docker", "inspect", "LibreChat-API"]))[0]["Id"]
        if api_after == api_before:
            raise RuntimeError("LibreChat-API was not recreated")
        protected = assert_protected_services(runtime["baseline"])
        if sha256_file(CONFIG_FILE) != config_before:
            raise RuntimeError("librechat.yaml changed")
        if sha256_file(COMPOSE_BASE) != runtime["baseline"]["compose_base_sha256"]:
            raise RuntimeError("compose.yaml changed")

        result = {
            "schema_version": 1,
            "status": "passed",
            "deployed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "source_revision": source_revision,
            "release_root": str(release_root),
            "backup_dir": str(backup_dir),
            "client_mount_before": str(current_client),
            "client_mount_after": str(release_client),
            "client_index_sha256": expected_index,
            "compose_sha256_before": compose_before,
            "compose_sha256_after": sha256_file(COMPOSE_OVERRIDE),
            "api_container_before": api_before,
            "api_container_after": api_after,
            "mongo_snapshot_sha256_before": runtime["mongo_snapshot_sha256"],
            "mongo_snapshot_sha256_after": sha256_json(after),
            "migrated_agent_ids": mapping,
            "preserved_resource_ids": sorted(
                agent["_id"]["$oid"] for agent in after["agents"]
            ),
            "acl_count": len(after["aclEntries"]),
            "migration_result": migration_result,
            "protected_services": protected,
            "protected_services_unchanged": True,
            "changed_targets": ["LibreChat-API", "chat-mongodb:data"],
            "recreated_services": ["LibreChat-API"],
            "public_checks": {
                "main_root": root_status,
                "api_config": api_status,
                "admin_root": admin_status,
                "office_auth_boundary": office_status,
            },
        }
        result_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        shutil.copy2(result_path, release_root / "DEPLOY_RESULT.json")
        shutil.copy2(result_path, backup_dir / "DEPLOY_RESULT.json")
        print(json.dumps(result, sort_keys=True))
    except Exception as error:
        rollback_result = None
        if mutation_started:
            completed = subprocess.run(
                [
                    "python3",
                    str(rollback_runner),
                    str(backup_dir),
                    str(backup_dir / "runtime-preflight.json"),
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            try:
                rollback_result = parse_json_output(completed.stdout)
            except Exception:
                rollback_result = {
                    "status": "failed",
                    "exit_code": completed.returncode,
                    "stdout": completed.stdout[-2000:],
                    "stderr": completed.stderr[-2000:],
                }
        failure = {
            "schema_version": 1,
            "status": "rolled_back" if rollback_result and rollback_result.get("status") == "passed" else "failed",
            "source_revision": source_revision,
            "error": str(error),
            "backup_dir": str(backup_dir),
            "rollback_result": rollback_result,
        }
        result_path.write_text(json.dumps(failure, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        if backup_dir.is_dir():
            shutil.copy2(result_path, backup_dir / "DEPLOY_RESULT.json")
        raise
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    main()

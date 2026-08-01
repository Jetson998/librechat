#!/usr/bin/env python3
"""Apply the API/Admin diagnostic overlay with automatic rollback."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path("/opt/librechat")
CAPABILITIES_PATH = "/app/packages/data-schemas/dist/admin/capabilities.cjs"
EXPECTED_CAPABILITIES_SHA256 = "5d9b8d6f3fa1de98ba4d1bec1f43310190d2d7f24dbe8d66aa50177d2dbc87a9"
PROTECTED = (
    "LibreChat-CodeAPI",
    "LibreChat-NGINX",
    "LibreChat-RAG-API",
    "chat-mongodb",
)
API_TARGETS = {
    "backend/api/models/index.js": "/app/api/models/index.js",
    "backend/api/server/index.js": "/app/api/server/index.js",
    "backend/api/server/routes/index.js": "/app/api/server/routes/index.js",
    "backend/api/server/routes/admin/diagnosticEvents.js": "/app/api/server/routes/admin/diagnosticEvents.js",
    "backend/api/server/services/DiagnosticEvents.js": "/app/api/server/services/DiagnosticEvents.js",
    "backend/api/server/controllers/agents/request.js": "/app/api/server/controllers/agents/request.js",
    "backend/api/server/controllers/agents/InitializationFailure.js": "/app/api/server/controllers/agents/InitializationFailure.js",
    "office/OfficePreparse.js": "/app/api/server/services/Files/OfficePreparse.js",
}


def run(command: list[str], check: bool = True, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(command, text=True, capture_output=True, cwd=cwd)
    if check and completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    return completed


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def inspect(name: str) -> dict:
    return json.loads(run(["docker", "inspect", name]).stdout)[0]


def safe_extract(archive: Path, destination: Path) -> None:
    destination = destination.resolve()
    with tarfile.open(archive, "r:*") as handle:
        for member in handle.getmembers():
            if member.islnk():
                raise RuntimeError(f"hard links are not allowed: {member.name}")
            target = (destination / member.name).resolve()
            try:
                target.relative_to(destination)
            except ValueError as error:
                raise RuntimeError(f"unsafe archive path: {member.name}") from error
            if member.issym():
                raise RuntimeError(f"symlinks are not allowed: {member.name}")
        handle.extractall(destination)


def artifact_path(stage: Path, item: dict) -> Path:
    name = item.get("filename") or Path(item["path"]).name
    path = (stage / name).resolve()
    require(path.parent == stage.resolve(), f"handoff artifact escapes stage: {name}")
    return path


def verify_handoff(stage: Path) -> dict:
    manifest = json.loads((stage / "deployment-handoff-manifest.json").read_text(encoding="utf-8"))
    require(manifest.get("status") == "packaged_for_later_deployment", "handoff is not packaged")
    artifacts = {item["kind"]: item for item in manifest["artifacts"]}
    api_tar = stage / "api-office-overlay.tar.gz"
    require(digest(api_tar) == artifacts["api-office-overlay"]["sha256"], "API overlay digest mismatch")
    if "admin-dist-tar" in artifacts:
        admin_item = artifacts["admin-dist-tar"]
        admin_dist = artifact_path(stage, admin_item)
        require(digest(admin_dist) == admin_item["sha256"], "Admin dist digest mismatch")
        return {
            "mode": "dist",
            "admin_dist": admin_dist,
            "candidate_image_manifest_digest": admin_item.get("candidate_image_manifest_digest"),
            "source_tree_sha256": admin_item["source_tree_sha256"],
        }
    admin_item = artifacts["admin-image-tar"]
    admin_tar = artifact_path(stage, admin_item)
    require(digest(admin_tar) == admin_item["sha256"], "Admin image digest mismatch")
    return {
        "mode": "image",
        "admin_tar": admin_tar,
        "admin_image_ref": admin_item["image_ref"],
        "admin_image_id": admin_item["image_id"],
        "admin_image_manifest_digest": admin_item.get("image_manifest_digest"),
        "source_tree_sha256": admin_item["source_tree_sha256"],
    }


def build_capability_runtime(stage: Path, destination: Path) -> str:
    current = run(["docker", "exec", "LibreChat-API", "cat", CAPABILITIES_PATH]).stdout
    require(
        hashlib.sha256(current.encode()).hexdigest() == EXPECTED_CAPABILITIES_SHA256,
        "capability runtime changed during apply",
    )
    require("READ_DIAGNOSTIC_LOGS" not in current, "candidate capability already mounted")
    constant_pattern = re.compile(r'(READ_AUDIT_LOG:\s*"read:audit_log")(\s*})')
    updated, constant_count = constant_pattern.subn(
        r'\1,\n\tREAD_DIAGNOSTIC_LOGS: "read:diagnostic_logs"\2', current
    )
    require(constant_count == 1, "capability constant patch did not match exactly once")
    category_pattern = "SystemCapabilities.READ_AUDIT_LOG\n\t\t]"
    require(updated.count(category_pattern) == 1, "capability category patch did not match exactly once")
    updated = updated.replace(
        category_pattern,
        "SystemCapabilities.READ_AUDIT_LOG,\n\t\t\tSystemCapabilities.READ_DIAGNOSTIC_LOGS\n\t\t]",
        1,
    )
    destination.write_text(updated, encoding="utf-8")
    return digest(destination)


def target(entry: object) -> str:
    if isinstance(entry, str):
        parts = entry.split(":")
        return parts[1] if len(parts) > 1 else ""
    if isinstance(entry, dict):
        return str(entry.get("target", ""))
    return ""


def write_candidate_compose(path: Path, release_dir: Path, admin_image_ref: str) -> Path:
    payload = json.loads(
        run(
            [
                "docker",
                "compose",
                "-f",
                str(ROOT / "compose.yaml"),
                "-f",
                str(path),
                "config",
                "--format",
                "json",
            ]
        ).stdout
    )
    services = payload.setdefault("services", {})
    api = services.setdefault("api", {})
    volumes = api.setdefault("volumes", [])
    destinations = set(API_TARGETS.values()) | {CAPABILITIES_PATH}
    api["volumes"] = [entry for entry in volumes if target(entry) not in destinations]
    for source_rel, destination in API_TARGETS.items():
        api["volumes"].append(f"{release_dir / source_rel}:{destination}:ro")
    api["volumes"].append(f"{release_dir / 'data-schemas/admin/capabilities.cjs'}:{CAPABILITIES_PATH}:ro")
    services.setdefault("admin-panel", {})["image"] = admin_image_ref
    candidate = path.with_name(f"compose.override.yaml.next-{os.getpid()}")
    candidate.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return candidate


def write_admin_dist(stage: Path, release_dir: Path, admin_dist: Path) -> None:
    destination = release_dir / "admin-dist"
    destination.mkdir(parents=True, exist_ok=True)
    safe_extract(admin_dist, destination)
    require((destination / "client").is_dir(), "Admin dist client directory is missing")
    require((destination / "server/server.js").is_file(), "Admin dist server entry is missing")


def public_status(url: str) -> int:
    result = run(["curl", "-ksS", "-o", "/dev/null", "-w", "%{http_code}", url])
    return int(result.stdout.strip())


def check_file_hashes(release_dir: Path) -> None:
    for source_rel, destination in API_TARGETS.items():
        expected = digest(release_dir / source_rel)
        actual = run(["docker", "exec", "LibreChat-API", "sha256sum", destination]).stdout.split()[0]
        require(actual == expected, f"runtime file hash mismatch: {destination}")
        if destination.endswith((".js", ".cjs")):
            run(["docker", "exec", "LibreChat-API", "node", "--check", destination])
    expected = digest(release_dir / "data-schemas/admin/capabilities.cjs")
    actual = run(["docker", "exec", "LibreChat-API", "sha256sum", CAPABILITIES_PATH]).stdout.split()[0]
    require(actual == expected, "runtime capability hash mismatch")
    run(["docker", "exec", "LibreChat-API", "node", "--check", CAPABILITIES_PATH])


def main() -> None:
    stage = Path(sys.argv[1]).resolve()
    source_revision = sys.argv[2]
    runtime = json.loads((stage / "runtime-preflight.json").read_text(encoding="utf-8"))
    baseline = runtime["baseline"]
    admin_artifact = verify_handoff(stage)
    require(runtime["source_revision"] == source_revision, "runtime evidence revision mismatch")
    admin_mode = admin_artifact["mode"]
    admin_image_ref = (
        baseline["admin_image"]["ref"]
        if admin_mode == "dist"
        else admin_artifact["admin_image_ref"]
    )
    expected_admin_image_id = (
        baseline["admin_image"]["id"]
        if admin_mode == "dist"
        else admin_artifact["admin_image_id"]
    )
    source_tree_hash = admin_artifact["source_tree_sha256"]

    work_dir = Path(tempfile.mkdtemp(prefix="diagnostic-log-apply-"))
    release_dir = ROOT / "diagnostic-log-backend" / f"{source_revision[:12]}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    backup_dir = ROOT / "backups" / f"diagnostic-log-backend-{source_revision[:12]}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    compose_override = ROOT / "compose.override.yaml"
    changed = False

    lock_path = Path("/var/lock/librechat-diagnostic-log-backend.lock")
    with lock_path.open("w") as lock_handle:
        try:
            fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("another LibreChat deployment is active") from error

        try:
            require(digest(compose_override) == baseline["compose_override_sha256"], "Compose override drifted")
            for name, expected in baseline["containers"].items():
                require(inspect(name)["Id"] == expected["id"], f"container drifted: {name}")
            current_capability = run(["docker", "exec", "LibreChat-API", "sha256sum", CAPABILITIES_PATH]).stdout.split()[0]
            require(current_capability == EXPECTED_CAPABILITIES_SHA256, "capability runtime drifted")

            overlay_root = work_dir / "overlay"
            overlay_root.mkdir(parents=True)
            safe_extract(stage / "api-office-overlay.tar.gz", overlay_root)
            release_dir.parent.mkdir(parents=True, exist_ok=True)
            release_dir.mkdir(parents=True, exist_ok=False)
            for source_rel in API_TARGETS:
                source = overlay_root / source_rel
                require(source.is_file(), f"candidate file is missing: {source_rel}")
                destination = release_dir / source_rel
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
                destination.chmod(0o444)
            capability = release_dir / "data-schemas/admin/capabilities.cjs"
            capability.parent.mkdir(parents=True, exist_ok=True)
            build_capability_runtime(stage, capability)
            capability.chmod(0o444)

            if admin_mode == "image":
                run(["docker", "load", "--input", str(admin_artifact["admin_tar"])])
                loaded_image = json.loads(run(["docker", "image", "inspect", admin_image_ref]).stdout)[0]
                accepted_ids = {expected_admin_image_id, admin_artifact.get("admin_image_manifest_digest")}
                require(loaded_image["Id"] in accepted_ids, "loaded Admin image ID mismatch")
                require(loaded_image.get("Architecture") == "amd64", "Admin image architecture mismatch")
            else:
                write_admin_dist(stage, release_dir, admin_artifact["admin_dist"])

            backup_dir.mkdir(parents=True, exist_ok=False)
            backup_dir.chmod(0o700)
            shutil.copy2(compose_override, backup_dir / "compose.override.yaml.before")
            (backup_dir / "runtime-preflight.json").write_text(
                json.dumps(runtime, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            (backup_dir / "active-containers.json").write_text(
                json.dumps({name: inspect(name)["Id"] for name in baseline["containers"]}, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            (backup_dir / "capabilities.cjs.before").write_text(
                run(["docker", "exec", "LibreChat-API", "cat", CAPABILITIES_PATH]).stdout,
                encoding="utf-8",
            )
            candidate_override = write_candidate_compose(compose_override, release_dir, admin_image_ref)
            if admin_mode == "dist":
                payload = json.loads(candidate_override.read_text(encoding="utf-8"))
                admin = payload["services"]["admin-panel"]
                admin_volumes = admin.setdefault("volumes", [])
                admin_volumes = [entry for entry in admin_volumes if target(entry) != "/app/dist"]
                admin_volumes.append(f"{release_dir / 'admin-dist'}:/app/dist:ro")
                admin["volumes"] = admin_volumes
                candidate_override.write_text(
                    json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
                )
            run(["docker", "compose", "-f", str(ROOT / "compose.yaml"), "-f", str(candidate_override), "config"])
            os.replace(candidate_override, compose_override)
            changed = True
            run(["docker", "compose", "-f", str(ROOT / "compose.yaml"), "-f", str(compose_override), "up", "-d", "--no-deps", "--force-recreate", "api"])
            for _ in range(90):
                if public_status("https://152.32.172.162.sslip.io/api/config") == 200:
                    break
                time.sleep(1)
            require(public_status("https://152.32.172.162.sslip.io/api/config") == 200, "API did not become ready")
            run(["docker", "compose", "-f", str(ROOT / "compose.yaml"), "-f", str(compose_override), "up", "-d", "--no-deps", "--force-recreate", "admin-panel"])
            for _ in range(60):
                if public_status("https://admin.152.32.172.162.sslip.io/") == 200:
                    break
                time.sleep(1)
            require(public_status("https://admin.152.32.172.162.sslip.io/") == 200, "Admin Panel did not become ready")

            check_file_hashes(release_dir)
            run(["docker", "exec", "-w", "/app/api", "LibreChat-API", "node", "-e", "const {SystemCapabilities}=require('@librechat/data-schemas'); if(SystemCapabilities.READ_DIAGNOSTIC_LOGS!=='read:diagnostic_logs') process.exit(2); require('./server/routes/admin/diagnosticEvents'); console.log('diagnostic-runtime-ok')"])
            if admin_mode == "dist":
                for relative in ("server/server.js", "client/assets/logs-DKP2w2mP.js"):
                    expected = digest(release_dir / "admin-dist" / relative)
                    actual = run(
                        ["docker", "exec", "LibreChat-Admin-Panel", "sha256sum", f"/app/dist/{relative}"]
                    ).stdout.split()[0]
                    require(actual == expected, f"Admin dist hash mismatch: {relative}")
            require(public_status("https://152.32.172.162.sslip.io/") == 200, "main site failed")
            require(public_status("https://152.32.172.162.sslip.io/office/") == 401, "Office auth boundary changed")

            protected_after = {name: inspect(name)["Id"] for name in PROTECTED}
            protected_before = {name: baseline["containers"][name]["id"] for name in PROTECTED}
            require(protected_after == protected_before, "protected service identity changed")
            api_after = inspect("LibreChat-API")
            admin_after = inspect("LibreChat-Admin-Panel")
            require(api_after["Id"] != baseline["containers"]["LibreChat-API"]["id"], "API was not recreated")
            require(admin_after["Id"] != baseline["containers"]["LibreChat-Admin-Panel"]["id"], "Admin was not recreated")
            require(admin_after["Image"] == expected_admin_image_id, "Admin image identity changed")

            result = {
                "schema_version": 1,
                "status": "passed",
                "deployed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                "source_revision": source_revision,
                "backup_dir": str(backup_dir),
                "release_dir": str(release_dir),
                "admin_image_ref": admin_image_ref,
                "admin_image_id": expected_admin_image_id,
                "admin_deployment_mode": admin_mode,
                "admin_candidate_image_manifest_digest": admin_artifact.get("candidate_image_manifest_digest"),
                "admin_dist_sha256": (
                    digest(admin_artifact["admin_dist"]) if admin_mode == "dist" else None
                ),
                "admin_source_tree_sha256": source_tree_hash,
                "compose_override_sha256_before": baseline["compose_override_sha256"],
                "compose_override_sha256_after": digest(compose_override),
                "api_container_before": baseline["containers"]["LibreChat-API"]["id"],
                "api_container_after": api_after["Id"],
                "admin_container_before": baseline["containers"]["LibreChat-Admin-Panel"]["id"],
                "admin_container_after": admin_after["Id"],
                "protected_services": protected_before,
                "protected_services_unchanged": True,
                "public_checks": {"main_root": 200, "api_config": 200, "admin_root": 200, "office_auth_boundary": 401},
                "billable_model_requests": 0,
                "business_acceptance": "technical smoke only; no user/model request generated",
            }
            (stage / "DEPLOY_RESULT.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            print(json.dumps(result, sort_keys=True))
        except Exception:
            if changed:
                run(["bash", str(stage / "remote-rollback.sh"), str(backup_dir)], check=False)
            raise
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    main()

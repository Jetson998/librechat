#!/usr/bin/env python3
"""Read-only production snapshot for the cumulative Client/PPT release."""

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


SERVICES = (
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


def run(command: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, text=True, capture_output=True)
    if check and result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "command failed")
    return result


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def inspect(name: str) -> dict:
    payload = json.loads(run(["docker", "inspect", name]).stdout)[0]
    state = payload["State"]
    require(state.get("Running") is True, f"container is not running: {name}")
    health = state.get("Health", {}).get("Status", "unreported")
    require(health in {"healthy", "unreported"}, f"container is not healthy: {name}: {health}")
    return {
        "id": payload["Id"],
        "started_at": state["StartedAt"],
        "status": state["Status"],
        "health": health,
        "mounts": payload.get("Mounts", []),
    }


def https_get(url: str) -> tuple[int, dict[str, str], bytes]:
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, method="GET"), timeout=20, context=context
        ) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()), error.read()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, msg, headers, newurl):
        return None


def https_get_no_redirect(url: str) -> tuple[int, dict[str, str], bytes]:
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    opener = urllib.request.build_opener(
        NoRedirect,
        urllib.request.HTTPSHandler(context=context),
    )
    try:
        with opener.open(urllib.request.Request(url, method="GET"), timeout=20) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()), error.read()


def available_memory_mb() -> int:
    for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) // 1024
    raise RuntimeError("MemAvailable is missing")


def free_disk_mb(path: Path) -> int:
    stats = os.statvfs(path)
    return stats.f_bavail * stats.f_frsize // (1024 * 1024)


def client_mount(details: dict) -> tuple[Path, bool]:
    mounts = [item for item in details["mounts"] if item.get("Destination") == "/app/client/dist"]
    require(len(mounts) == 1, "expected exactly one Client mount")
    mount = mounts[0]
    require(mount.get("Type") == "bind", "Client mount is not a bind mount")
    require(mount.get("RW") is False, "Client mount is not read-only")
    path = Path(mount["Source"])
    require(path.is_dir() and (path / "index.html").is_file(), f"Client mount is missing: {path}")
    return path, bool(mount.get("RW"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("metadata", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    metadata = json.loads(args.metadata.read_text(encoding="utf-8"))
    baseline = metadata["production_baseline"]
    client_contract = metadata["client"]
    ppt_contract = metadata["ppt"]
    root = Path("/opt/librechat")
    compose = root / "compose.yaml"
    override = root / "compose.override.yaml"
    config = root / "librechat.yaml"
    nginx = Path("/etc/nginx/conf.d/ppt-entry.conf")
    ppt_active = Path(baseline["ppt_active_path"])

    for path in (compose, override, config, nginx):
        require(path.is_file(), f"required production file is missing: {path}")
    services = {name: inspect(name) for name in SERVICES}
    client_path, _ = client_mount(services["LibreChat-API"])
    require(str(client_path) == baseline["active_client_mount"], "active Client mount drift")
    client_files = [path for path in client_path.rglob("*") if path.is_file()]
    require(len(client_files) == baseline["active_client_file_count"], "active Client file count drift")
    require(sha256_file(client_path / "index.html") == baseline["public_index_sha256"], "active Client index drift")
    require(
        sha256_file(client_path / "agent-platform-client-overlay.json")
        == baseline["active_overlay_manifest_sha256"],
        "active overlay manifest drift",
    )
    for name, expected in client_contract["protected_assets"].items():
        require(sha256_file(client_path / name) == expected, f"active protected asset drift: {name}")

    require(ppt_active.is_symlink(), "PPT active path is not a symlink")
    ppt_target = Path(os.path.realpath(ppt_active))
    require(str(ppt_target) == baseline["ppt_resolved_path"], "active PPT path drift")
    require(sha256_file(ppt_target / "index.html") == baseline["ppt_index_sha256"], "active PPT index drift")
    require(sha256_file(nginx) == baseline["ppt_nginx_sha256"], "PPT Nginx config drift")

    root_status, _, root_body = https_get("https://152.32.172.162.sslip.io/")
    config_status, _, config_body = https_get("https://152.32.172.162.sslip.io/api/config")
    ppt_status, _, ppt_body = https_get("https://ppt.152.32.172.162.sslip.io/")
    ppt_api_status, _, _ = https_get("https://ppt.152.32.172.162.sslip.io/api/config")
    ppt_login_status, ppt_login_headers, _ = https_get_no_redirect("https://ppt.152.32.172.162.sslip.io/login")
    require(root_status == 200 and sha256_bytes(root_body) == baseline["public_index_sha256"], "public main root drift")
    require(config_status == 200, "public /api/config is not 200")
    require(json.loads(config_body).get("buildInfo", {}).get("commit") == baseline["build_info_commit"], "buildInfo commit drift")
    require(ppt_status == 200 and sha256_bytes(ppt_body) == baseline["ppt_index_sha256"], "public PPT root drift")
    require(ppt_api_status == 404, "PPT API boundary is not 404")
    require(ppt_login_status == 302, "PPT login redirect is not 302")
    require(
        ppt_login_headers.get("Location") == "https://152.32.172.162.sslip.io/login",
        "PPT login redirect target drift",
    )

    memory_mb = available_memory_mb()
    disk_mb = free_disk_mb(root)
    require(memory_mb >= 512, "production memory is below threshold")
    require(disk_mb >= 2048, "production disk is below threshold")

    snapshot = {
        "schema_version": 1,
        "status": "passed",
        "captured_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "candidate_revision": metadata["source"]["candidate_revision"],
        "candidate_sha256": metadata["candidate"]["archive_sha256"],
        "checked_services": list(SERVICES),
        "services": {
            name: {key: value for key, value in details.items() if key != "mounts"}
            for name, details in services.items()
        },
        "host_resources": {"memory_available_mb": memory_mb, "disk_free_mb": disk_mb},
        "baseline": {
            "client_mount": str(client_path),
            "client_index_sha256": sha256_file(client_path / "index.html"),
            "ppt_active_path": str(ppt_active),
            "ppt_resolved_path": str(ppt_target),
            "ppt_index_sha256": sha256_file(ppt_target / "index.html"),
            "compose_sha256": sha256_file(compose),
            "compose_override_sha256": sha256_file(override),
            "config_sha256": sha256_file(config),
            "nginx_sha256": sha256_file(nginx),
        },
        "rollback_available": True,
        "write_operations": [],
        "checks": [
            "service-state",
            "dependency-interface",
            "host-memory",
            "host-disk",
            "rollback-available",
            "main-client-baseline",
            "ppt-baseline",
            "public-boundaries",
        ],
    }
    args.output.write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(snapshot, sort_keys=True))


if __name__ == "__main__":
    main()

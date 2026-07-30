#!/usr/bin/env python3
"""Apply the bounded CodeAPI init/reaping fix with automatic rollback."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


EXPECTED_IMAGE_ID = "sha256:dc97d2378247102a6ef9f42dbabc9698ed5e39d299179db5b356f7a2e7681b3c"
PROTECTED = (
    "LibreChat-API", "LibreChat-NGINX", "LibreChat-RAG-API",
    "LibreChat-Admin-Panel", "chat-mongodb",
)


def run(command: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(command, text=True, capture_output=True)
    if check and completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    return completed


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect(name: str) -> dict:
    return json.loads(run(["docker", "inspect", name]).stdout)[0]


def public_status(url: str) -> int:
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def main() -> None:
    stage = Path(sys.argv[1]).resolve()
    revision = sys.argv[2]
    root = Path("/opt/librechat")
    evidence = json.loads((stage / "runtime-preflight.json").read_text(encoding="utf-8"))
    baseline = evidence["baseline"]
    compose_override = root / "compose.override.yaml"
    if digest(compose_override) != baseline["compose_override_sha256"]:
        raise RuntimeError("target drift: Compose override changed after preflight")
    before = {name: inspect(name)["Id"] for name in PROTECTED}
    codeapi_before = inspect("LibreChat-CodeAPI")
    if codeapi_before["Id"] != baseline["containers"]["LibreChat-CodeAPI"]["id"]:
        raise RuntimeError("target drift: CodeAPI container changed after preflight")
    if codeapi_before["Image"] != EXPECTED_IMAGE_ID:
        raise RuntimeError("target drift: CodeAPI image changed")

    lock_dir = root / ".release-locks"
    lock_dir.mkdir(mode=0o700, exist_ok=True)
    with (lock_dir / "codeapi-process-reaper.lock").open("w") as lock_handle:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        backup = root / "backups" / f"codeapi-process-reaper-{revision[:12]}-{stamp}"
        backup.mkdir(parents=True, mode=0o700)
        shutil.copy2(compose_override, backup / "compose.override.yaml.before")
        block = (stage / "codeapi-service.block").read_text(encoding="utf-8")
        rollback_block = block.replace("    init: true\n", "")
        (backup / "codeapi-rollback.override.yaml").write_text("services:\n" + rollback_block, encoding="utf-8")
        changed = False
        try:
            patched = stage / "compose.override.yaml.patched"
            run(["python3", str(stage / "patch-compose.py"), str(compose_override), str(stage / "codeapi-service.block"), str(patched)])
            os.replace(patched, compose_override)
            changed = True
            run([
                "docker", "compose", "--project-directory", str(root),
                "-f", str(root / "compose.yaml"), "-f", str(compose_override), "config", "-q",
            ])
            run([
                "docker", "compose", "--project-directory", str(root),
                "-f", str(root / "compose.yaml"), "-f", str(compose_override),
                "up", "-d", "--no-deps", "--force-recreate", "codeapi",
            ])
            codeapi_after = None
            for _ in range(45):
                candidate = inspect("LibreChat-CodeAPI")
                health = candidate["State"].get("Health", {}).get("Status")
                if candidate["State"].get("Running") and health in {None, "healthy"}:
                    codeapi_after = candidate
                    break
                time.sleep(2)
            if codeapi_after is None:
                raise RuntimeError("CodeAPI did not become healthy")
            if codeapi_after["Id"] == codeapi_before["Id"]:
                raise RuntimeError("CodeAPI was not recreated")
            if codeapi_after["Image"] != EXPECTED_IMAGE_ID:
                raise RuntimeError("CodeAPI image identity changed")
            if codeapi_after["HostConfig"].get("Init") is not True:
                raise RuntimeError("CodeAPI init is not enabled")
            if codeapi_after["HostConfig"].get("PidsLimit") != 256:
                raise RuntimeError("CodeAPI PID limit changed")
            for name, container_id in before.items():
                if inspect(name)["Id"] != container_id:
                    raise RuntimeError(f"protected service changed: {name}")
            js = "fetch('http://codeapi:8000/exec',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lang:'bash',code:'printf codeapi-process-reaper-ok'})}).then(async r=>{const t=await r.text();if(!r.ok||!t.includes('codeapi-process-reaper-ok')){console.error(r.status,t);process.exit(2)}console.log(r.status)}).catch(e=>{console.error(e);process.exit(3)})"
            exec_smoke = None
            last_exec_error = ""
            for _ in range(45):
                candidate = run(["docker", "exec", "LibreChat-API", "node", "-e", js], check=False)
                if candidate.returncode == 0:
                    exec_smoke = candidate
                    break
                last_exec_error = candidate.stderr.strip() or candidate.stdout.strip()
                time.sleep(2)
            if exec_smoke is None:
                raise RuntimeError(f"API-to-CodeAPI exec did not recover after DNS transition: {last_exec_error}")
            result = {
                "schema_version": 1,
                "status": "passed",
                "deployed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                "source_revision": revision,
                "backup_dir": str(backup),
                "compose_override_sha256_before": baseline["compose_override_sha256"],
                "compose_override_sha256_after": digest(compose_override),
                "codeapi_container_before": codeapi_before["Id"],
                "codeapi_container_after": codeapi_after["Id"],
                "codeapi_image_id": codeapi_after["Image"],
                "codeapi_init": True,
                "codeapi_exec_status": int(exec_smoke.stdout.strip()),
                "protected_services": before,
                "protected_services_unchanged": True,
                "public_checks": {
                    "main_root": public_status("http://127.0.0.1:3081/"),
                    "api_config": public_status("http://127.0.0.1:3081/api/config"),
                },
            }
            (stage / "DEPLOY_RESULT.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            print(json.dumps(result, sort_keys=True))
        except Exception:
            if changed:
                run(["python3", str(stage / "remote-rollback.py"), str(backup)], check=False)
            raise


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Contract checks for the diagnostic-log production runner."""

from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parent


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    deploy = (ROOT / "deploy.sh").read_text(encoding="utf-8")
    preflight = (ROOT / "remote-preflight.py").read_text(encoding="utf-8")
    apply = (ROOT / "remote-apply.py").read_text(encoding="utf-8")
    rollback = (ROOT / "remote-rollback.sh").read_text(encoding="utf-8")
    collect = (ROOT / "collect-preflight.sh").read_text(encoding="utf-8")

    require("release-governance:scoped-deployment" in deploy, "runner scope marker missing")
    require("release-governance:targets=LibreChat-API,LibreChat-Admin-Panel,LibreChat-CodeAPI" in deploy, "runner targets marker drift")
    require("release-governance:target-lock" in deploy, "runner lock marker missing")
    for service in ("LibreChat-CodeAPI", "LibreChat-NGINX", "LibreChat-RAG-API", "chat-mongodb"):
        require(service in preflight and service in apply, f"protected service is not guarded: {service}")
    for destination in (
        "/app/api/models/index.js",
        "/app/api/server/index.js",
        "/app/api/server/routes/index.js",
        "/app/api/server/routes/admin/diagnosticEvents.js",
        "/app/api/server/services/DiagnosticEvents.js",
        "/app/api/server/controllers/agents/request.js",
        "/app/api/server/controllers/agents/InitializationFailure.js",
        "/app/api/server/services/Files/OfficePreparse.js",
        "/app/packages/data-schemas/dist/admin/capabilities.cjs",
    ):
        require(destination in apply, f"runtime destination missing: {destination}")
    require("compose.override.yaml.before" in apply and "remote-rollback.sh" in apply, "rollback contract missing")
    require("up" in apply and "--no-deps" in apply, "single-service Compose recreation missing")
    require("write_operations" in preflight and "rollback_available" in collect, "read-only preflight contract missing")
    require("rm -rf \"$handoff_stage\"" in deploy, "handoff cleanup is not bounded")

    subprocess.run(["bash", "-n", str(ROOT / "ssh-transport.sh")], check=True)
    subprocess.run(["bash", "-n", str(ROOT / "collect-preflight.sh")], check=True)
    subprocess.run(["bash", "-n", str(ROOT / "deploy.sh")], check=True)
    subprocess.run(["bash", "-n", str(ROOT / "remote-rollback.sh")], check=True)
    compile((ROOT / "remote-preflight.py").read_text(encoding="utf-8"), str(ROOT / "remote-preflight.py"), "exec")
    compile((ROOT / "remote-apply.py").read_text(encoding="utf-8"), str(ROOT / "remote-apply.py"), "exec")
    print("diagnostic release runner contract passed")


if __name__ == "__main__":
    main()

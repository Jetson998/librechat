#!/usr/bin/env python3
from __future__ import annotations

import pathlib
import re
import subprocess


ROOT = pathlib.Path(__file__).resolve().parents[1]
CLIENT = ROOT / "client"
SCRIPTS = ROOT / "scripts"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


required = [
    ROOT / "README.md",
    CLIENT / "context-safety-ui.js",
    CLIENT / "context-safety-ui.css",
    CLIENT / "context-safety-stage-b-smoke.html",
    SCRIPTS / "test-contract.js",
    SCRIPTS / "test-release.py",
    SCRIPTS / "deploy.sh",
    SCRIPTS / "run-remote-release.sh",
    SCRIPTS / "deploy-remote.exp",
]
for path in required:
    require(path.is_file(), f"missing release file: {path.relative_to(ROOT)}")

subprocess.run(
    ["node", "--check", str(CLIENT / "context-safety-ui.js")], check=True
)
subprocess.run(["node", str(SCRIPTS / "test-contract.js")], check=True)

readme = (ROOT / "README.md").read_text(encoding="utf-8")
deploy = (SCRIPTS / "deploy.sh").read_text(encoding="utf-8")
remote = (SCRIPTS / "run-remote-release.sh").read_text(encoding="utf-8")
transport = (SCRIPTS / "deploy-remote.exp").read_text(encoding="utf-8")
client_source = (CLIENT / "context-safety-ui.js").read_text(encoding="utf-8")

for marker in [
    "90a03305d3f1706f1363e33b7a7368fe9dc69a11cb31858c1535a571669aa1ec",
    "29306df25134b09716727523eaeea0bfca1d75029a8ffc89ec02b47a4bf105e0",
    "a2dae8d2e54e6c63a94980b9d0167b8b94ad4eb13cdd8d5f27e91561aa4359d9",
    "aeb91c87012ee37a7c94635f3673f9c4747c39245f2c0242eae4d6a79e860f27",
    "6f76a7379c01d640460bf34864b88554771ca43c18e063239c5d1a294300433f",
    "2817b8722535d3d46c514c8b93c8713abe4852860cc0075e5c07df1b0f4a01ff",
    "PREFLIGHT_ONLY",
    "--no-deps --force-recreate api",
    "LibreChat-NGINX",
    "LibreChat-CodeAPI",
    "LibreChat-RAG-API",
    "chat-mongodb",
    "LibreChat-Admin-Panel",
    "context-safety-stage-b-smoke.html",
    "business-upload-menu.js",
    "odysseia-login.js",
    "user-usage-dashboard.js",
    "user-usage-dashboard.css",
    'test "$office_status" = "401"',
]:
    require(marker in deploy, f"deployment guard missing: {marker}")

for marker in [
    "CONTEXT_SAFETY_STAGE_B_PREFLIGHT_ONLY",
    "remote_preflight_only=ok",
    "DEPLOY_RESULT.txt",
]:
    require(marker in remote, f"remote runner marker missing: {marker}")

for marker in [
    "RELEASE_COMMIT",
    "local HEAD does not match RELEASE_COMMIT",
    "scp -r",
    "CONTEXT_SAFETY_STAGE_B_PREFLIGHT_ONLY",
]:
    require(marker in transport, f"transport marker missing: {marker}")

for marker in [
    "external asset",
    "compressed application bundle",
    "95%",
    "rollback",
    "browser acceptance",
]:
    require(marker.lower() in readme.lower(), f"README marker missing: {marker}")

require("assets/index.P3glMaNP.js" not in client_source, "client must not patch main bundle")

secret_patterns = [
    re.compile(r"github_pat_[A-Za-z0-9_]+"),
    re.compile(r"ghp_[A-Za-z0-9]+"),
    re.compile(r"-----BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY-----"),
    re.compile(r"SSH_PASS\s*=\s*['\"][^$][^'\"]+['\"]"),
]
for path in ROOT.rglob("*"):
    if not path.is_file():
        continue
    text = path.read_text(encoding="utf-8", errors="ignore")
    for pattern in secret_patterns:
        require(not pattern.search(text), f"possible secret in {path.relative_to(ROOT)}")

print("context_safety_stage_b_release: ok")

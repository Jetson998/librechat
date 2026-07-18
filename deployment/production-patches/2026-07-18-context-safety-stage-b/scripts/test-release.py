#!/usr/bin/env python3
from __future__ import annotations

import pathlib
import re
import subprocess
import tempfile


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
    SCRIPTS / "build-client.py",
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

with tempfile.TemporaryDirectory() as temp_dir:
    temp = pathlib.Path(temp_dir)
    index = temp / "index.html"
    fixture = temp / "fixture.html"
    index.write_text("<html><head></head><body></body></html>", encoding="utf-8")
    fixture.write_text(
        '<link href="/context-safety-ui.css?v=smoke">'
        '<script src="/context-safety-ui.js?v=smoke"></script>',
        encoding="utf-8",
    )
    subprocess.run(
        [
            "python3",
            str(SCRIPTS / "build-client.py"),
            str(index),
            str(fixture),
            "context-safety-ui-first.css",
            "context-safety-ui-first.js",
        ],
        check=True,
    )
    subprocess.run(
        [
            "python3",
            str(SCRIPTS / "build-client.py"),
            str(index),
            str(fixture),
            "context-safety-ui-second.css",
            "context-safety-ui-second.js",
        ],
        check=True,
    )
    built_index = index.read_text(encoding="utf-8")
    built_fixture = fixture.read_text(encoding="utf-8")
    require(built_index.count('id="context-safety-stage-b-style"') == 1, "style marker")
    require(built_index.count('id="context-safety-stage-b"') == 1, "script marker")
    require("/context-safety-ui-second.css" in built_index, "updated style asset")
    require("/context-safety-ui-second.js" in built_index, "updated script asset")
    require("/context-safety-ui-first.css" not in built_index, "stale style asset")
    require("/context-safety-ui-first.js" not in built_index, "stale script asset")
    require("/context-safety-ui-second.css" in built_fixture, "fixture style asset")
    require("/context-safety-ui-second.js" in built_fixture, "fixture script asset")

readme = (ROOT / "README.md").read_text(encoding="utf-8")
deploy = (SCRIPTS / "deploy.sh").read_text(encoding="utf-8")
remote = (SCRIPTS / "run-remote-release.sh").read_text(encoding="utf-8")
transport = (SCRIPTS / "deploy-remote.exp").read_text(encoding="utf-8")
client_source = (CLIENT / "context-safety-ui.js").read_text(encoding="utf-8")

for marker in [
    "eed955af8350578f5e04a55f141f4ea40caf3fddf5ebe151c6ee63641557c639",
    "d91b77a94159788e44a4cc506d20f2103c39edd4c43feef7bf5dc10ed4a490bc",
    "a2dae8d2e54e6c63a94980b9d0167b8b94ad4eb13cdd8d5f27e91561aa4359d9",
    "aeb91c87012ee37a7c94635f3673f9c4747c39245f2c0242eae4d6a79e860f27",
    "6f76a7379c01d640460bf34864b88554771ca43c18e063239c5d1a294300433f",
    "2817b8722535d3d46c514c8b93c8713abe4852860cc0075e5c07df1b0f4a01ff",
    "b9d40771ae9d679c43bcf03e00a240124643b0187f496ca9771db859b891cb39",
    "a2ebfa336df18d54d96a07cae7c17d04091cf384bd413e17554bb456be5e979d",
    "model-pricing-dotted-key/406693a-20260718201634/api-index.cjs",
    "b9cac9721e5dcbde30b5d3b1052ba8306e15119255d4b8c53bb330ca8b089b27",
    "librechat-admin-panel-model-pricing-keyfix:1ff1e5728a85",
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

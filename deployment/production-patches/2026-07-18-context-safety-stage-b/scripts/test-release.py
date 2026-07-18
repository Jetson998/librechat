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
    index.write_text(
        '<html><head><link id="context-safety-stage-b-style" rel="stylesheet" '
        'href="/context-safety-ui.css?v=old"></head><body>'
        '<script id="context-safety-stage-b" defer '
        'src="/context-safety-ui.js?v=old"></script></body></html>',
        encoding="utf-8",
    )
    fixture.write_text(
        '<link href="/context-safety-ui.css?v=smoke">'
        '<script src="/context-safety-ui.js?v=smoke"></script>',
        encoding="utf-8",
    )
    (temp / "context-safety-ui-first.css").write_text(
        "/* first-style-marker */", encoding="utf-8"
    )
    (temp / "context-safety-ui-first.js").write_text(
        'window.__inlineStageB = "first-script-marker";', encoding="utf-8"
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
    (temp / "context-safety-ui-second.css").write_text(
        "/* second-style-marker */", encoding="utf-8"
    )
    (temp / "context-safety-ui-second.js").write_text(
        'window.__inlineStageB = "second-script-marker";', encoding="utf-8"
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
    require("second-style-marker" in built_index, "inline style body")
    require("second-script-marker" in built_index, "inline script body")
    require("second-style-marker" in built_fixture, "fixture inline style body")
    require("second-script-marker" in built_fixture, "fixture inline script body")
    require('id="context-safety-stage-b-style" rel=' not in built_index, "no style link")
    require('id="context-safety-stage-b" defer' not in built_index, "no external script")

readme = (ROOT / "README.md").read_text(encoding="utf-8")
deploy = (SCRIPTS / "deploy.sh").read_text(encoding="utf-8")
remote = (SCRIPTS / "run-remote-release.sh").read_text(encoding="utf-8")
transport = (SCRIPTS / "deploy-remote.exp").read_text(encoding="utf-8")
client_source = (CLIENT / "context-safety-ui.js").read_text(encoding="utf-8")

for marker in [
    "82690eb847fe78401258d7ccb5f469d370cd21d764af30478f9503716979b6ec",
    "b2205004f64846905701eddec56c068b8761a4d44708b639ef08ef305309090e",
    "a2dae8d2e54e6c63a94980b9d0167b8b94ad4eb13cdd8d5f27e91561aa4359d9",
    "aeb91c87012ee37a7c94635f3673f9c4747c39245f2c0242eae4d6a79e860f27",
    "1f03cbd793319a80ea59229889c510fa5801d30cf2b8074ae5c58064812dc115",
    "121b1907784ff2214246e2c7ad67933faf01038d480e23ee581f5d2c85d6c3a1",
    "user-model-market/6bfb5be23255-20260718235639/usage-dashboard.js",
    "dfb57eedf861c14a342b0821e7d1fca6f004f3cb7bfa671f24bbb892f37455a8",
    "user-model-market/6bfb5be23255-20260718235639/client-dist",
    "b9d40771ae9d679c43bcf03e00a240124643b0187f496ca9771db859b891cb39",
    "7be394908eadb381fa40078d8f64a05c283ada8841998462ba92b4024a74be39",
    "a2ebfa336df18d54d96a07cae7c17d04091cf384bd413e17554bb456be5e979d",
    "search-favicon-fallback-14b9fc7972f5.js",
    "6dc1974118b843218c9178caccedaf4cd7cba5e1e17574ab883d622f550bdade",
    "2026-07-18-search-favicon-v1",
    "createFallbackDataUri",
    "data-view=\"market\"",
    "renderMarket",
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
    "context_fixture_asset",
    "data-asset",
    "removeGenericFileLines",
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
    "inline asset",
    "no-store",
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

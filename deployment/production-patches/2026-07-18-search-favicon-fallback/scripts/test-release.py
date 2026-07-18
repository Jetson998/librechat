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
    CLIENT / "search-favicon-fallback.js",
    SCRIPTS / "build-client.py",
    SCRIPTS / "test-contract.js",
    SCRIPTS / "test-release.py",
    SCRIPTS / "deploy.sh",
    SCRIPTS / "run-remote-release.sh",
    SCRIPTS / "deploy-remote.exp",
]
for path in required:
    require(path.is_file(), f"missing release file: {path.relative_to(ROOT)}")

subprocess.run(
    ["node", "--check", str(CLIENT / "search-favicon-fallback.js")], check=True
)
subprocess.run(["node", str(SCRIPTS / "test-contract.js")], check=True)

with tempfile.TemporaryDirectory() as temp_dir:
    temp = pathlib.Path(temp_dir)
    index = temp / "index.html"
    first = temp / "search-favicon-fallback-first.js"
    second = temp / "search-favicon-fallback-second.js"
    index.write_text("<html><head></head><body></body></html>", encoding="utf-8")
    first.write_text('window.__faviconMarker = "first";', encoding="utf-8")
    second.write_text('window.__faviconMarker = "second";', encoding="utf-8")
    subprocess.run(
        ["python3", str(SCRIPTS / "build-client.py"), str(index), first.name],
        check=True,
    )
    subprocess.run(
        ["python3", str(SCRIPTS / "build-client.py"), str(index), second.name],
        check=True,
    )
    built = index.read_text(encoding="utf-8")
    require(built.count('id="search-favicon-fallback"') == 1, "script marker")
    require(f'data-asset="/{second.name}"' in built, "updated asset marker")
    require('window.__faviconMarker = "second";' in built, "updated inline body")
    require(first.name not in built, "stale asset reference")
    require('id="search-favicon-fallback" src=' not in built, "external script")

readme = (ROOT / "README.md").read_text(encoding="utf-8")
deploy = (SCRIPTS / "deploy.sh").read_text(encoding="utf-8")
remote = (SCRIPTS / "run-remote-release.sh").read_text(encoding="utf-8")
transport = (SCRIPTS / "deploy-remote.exp").read_text(encoding="utf-8")

for marker in [
    "0414a99197a5594ef18b06393f615331327b5fc53f15897f2763a4ece52ca68c",
    "b6834a3533fef6ca1a65d5061ebe63f274c15516bd9a92d14a6ec6b2a84aac87",
    "user-usage-cost-detail-availability/de2beeace561-20260718223055/client-dist",
    "5bd0bd087aab75799fb429b7da8cbb68b6947856b6fe388aeb86985a94821ba9",
    "6dc1974118b843218c9178caccedaf4cd7cba5e1e17574ab883d622f550bdade",
    "c15452691c0cad96b8846a94242cd6f9884a2c2061ac2cc8784dca8a79279546",
    "724094199fa29f77799331988748b8eef8d88c135b35abf5bea5f2c19a1a494b",
    "b9d40771ae9d679c43bcf03e00a240124643b0187f496ca9771db859b891cb39",
    "model-pricing-dotted-key/406693a-20260718201634/api-index.cjs",
    "librechat-admin-panel-model-pricing-keyfix:1ff1e5728a85",
    "PREFLIGHT_ONLY",
    "data-asset",
    "--no-deps --force-recreate api",
    "LibreChat-NGINX",
    "LibreChat-CodeAPI",
    "LibreChat-RAG-API",
    "chat-mongodb",
    "LibreChat-Admin-Panel",
    'test "$office_status" = "401"',
]:
    require(marker in deploy, f"deployment guard missing: {marker}")

for marker in [
    "SEARCH_FAVICON_PREFLIGHT_ONLY",
    "remote_preflight_only=ok",
    "DEPLOY_RESULT.txt",
]:
    require(marker in remote, f"remote runner marker missing: {marker}")

for marker in [
    "RELEASE_COMMIT",
    "local HEAD does not match RELEASE_COMMIT",
    "scp -r",
    "SEARCH_FAVICON_PREFLIGHT_ONLY",
]:
    require(marker in transport, f"transport marker missing: {marker}")

for marker in [
    "local svg",
    "no-store",
    "compressed",
    "browser acceptance",
    "rollback",
]:
    require(marker in readme.lower(), f"README marker missing: {marker}")

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

print("search_favicon_fallback_release: ok")

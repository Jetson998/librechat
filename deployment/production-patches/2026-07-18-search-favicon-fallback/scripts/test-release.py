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
    "cd6002ddc8893f25a6337dc823c9a9978f928aa5652f7e16ca28ac4d4e8fa6d2",
    "488e92e83bd289e709ae746e766c28af9c176406a4d93d0a8d6d1c7958fea76e",
    "user-usage-usd-symbol/0b57393fab4b-20260718214145/client-dist",
    "6d51f0f488790bc117a2ae33a61c0a23a296ee1dbc5a7352e84fa7d09d35e187",
    "6dc1974118b843218c9178caccedaf4cd7cba5e1e17574ab883d622f550bdade",
    "aba651fe592a0059296fa8f5d679c0eeb693424def58a304c53037fd686248da",
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

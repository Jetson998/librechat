#!/usr/bin/env python3
"""Contracts for the bounded session-scoped reasoning Client release."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
METADATA = ROOT / "client" / "artifact.json"
SCRIPTS = ROOT / "scripts"


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load_verifier():
    path = SCRIPTS / "verify-artifact.py"
    spec = importlib.util.spec_from_file_location("reasoning_intensity_verifier", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def main() -> None:
    metadata = json.loads(METADATA.read_text(encoding="utf-8"))
    check(metadata["schema_version"] == 1, "metadata schema mismatch")
    check(
        metadata["component"] == "reasoning-intensity-session-client",
        "component identity mismatch",
    )
    check(
        metadata["source"]["repository_commit"]
        == "dcef7febecece61012436194c4c5aeab0e081f93",
        "source revision mismatch",
    )
    check(
        metadata["source"]["source_origin"]
        == "operator-supplied nested Git checkout",
        "source origin missing",
    )
    check(metadata["artifact"]["origin"] == "independent-build", "artifact origin changed")
    check(len(metadata["artifact"]["zip_sha256"]) == 64, "ZIP digest missing")
    check(
        set(metadata["artifact"]["members"])
        == {"client-dist.tar.gz", "client-dist.tar.gz.sha256", "candidate-manifest.json"},
        "artifact member contract changed",
    )
    check(metadata["client"]["file_count"] == 341, "Client file count changed")
    check(
        metadata["client"]["required_markers"] == ["reasoning_effort", "effort"],
        "routing markers changed",
    )
    check(
        metadata["build_provenance"]["build_environment"] == "independent-build",
        "independent-build missing",
    )
    check(metadata["build_provenance"]["production_host"] is False, "build ran on production")

    deploy = (SCRIPTS / "deploy.sh").read_text(encoding="utf-8")
    apply = (SCRIPTS / "remote-apply.sh").read_text(encoding="utf-8")
    rollback = (SCRIPTS / "remote-rollback.sh").read_text(encoding="utf-8")
    transport = (SCRIPTS / "ssh-transport.sh").read_text(encoding="utf-8")
    collect = (SCRIPTS / "collect-preflight.sh").read_text(encoding="utf-8")
    preflight = (SCRIPTS / "remote-preflight.py").read_text(encoding="utf-8")

    check("release-governance:scoped-deployment" in deploy, "scoped marker missing")
    check("release-governance:targets=LibreChat-API" in deploy, "target marker missing")
    check("/app/client/dist" in apply, "Client mount contract missing")
    check("reasoning-intensity-session" in apply, "versioned Client destination missing")
    check(
        "--force-recreate api" in apply and "--force-recreate api" in rollback,
        "API-only recreate missing",
    )
    check("chat-mongodb" in preflight, "MongoDB identity is not protected")
    check("protected container changed" in apply, "protected service identities are not enforced")
    check(
        'read -r -s LIBRECHAT_SSH_PASSWORD </dev/tty' in transport,
        "SSH password input must use the control terminal",
    )
    check(
        "requires key authentication or an interactive control terminal" in transport,
        "SSH failure is not explicit",
    )
    check(
        "librechat-reasoning-intensity-session-runtime.XXXXXX" in collect,
        "preflight temp file is not versioned",
    )
    check("LibreChat-API" in (ROOT / "README.md").read_text(encoding="utf-8"), "release scope is undocumented")
    check(
        "up -d --no-deps --force-recreate api" in apply,
        "apply scope is not API-only",
    )
    check("mongosh" not in apply and "migrate.js" not in apply, "release must not mutate MongoDB")

    for script in (
        SCRIPTS / "ssh-transport.sh",
        SCRIPTS / "collect-preflight.sh",
        SCRIPTS / "deploy.sh",
        SCRIPTS / "remote-apply.sh",
        SCRIPTS / "remote-rollback.sh",
    ):
        subprocess.run(["bash", "-n", str(script)], check=True)
    for script in (
        SCRIPTS / "verify-artifact.py",
        SCRIPTS / "remote-preflight.py",
        SCRIPTS / "test-release.py",
    ):
        compile(script.read_text(encoding="utf-8"), str(script), "exec")

    if len(sys.argv) == 2:
        result = load_verifier().verify(Path(sys.argv[1]).resolve(), METADATA)
        check(result["status"] == "passed", "Client artifact verification failed")
        print(json.dumps(result, sort_keys=True))
    else:
        print("artifact_verification=deferred (pass the release ZIP as argv[1])")
    print("reasoning_intensity_client_release_contract=passed")


if __name__ == "__main__":
    main()

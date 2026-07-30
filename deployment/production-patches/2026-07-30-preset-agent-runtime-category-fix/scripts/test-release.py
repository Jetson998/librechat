#!/usr/bin/env python3
"""Release contracts for preset-Agent runtime identity and category de-duplication."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[2]
METADATA = ROOT / "client" / "artifact.json"
SCRIPTS = ROOT / "scripts"
MIGRATION = ROOT / "migration"
COMPILED = REPO / "workflow-templates" / "preset-agents" / "compiled-agents.json"


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_verifier():
    path = SCRIPTS / "verify-artifact.py"
    spec = importlib.util.spec_from_file_location("preset_runtime_category_verifier", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def main() -> None:
    metadata = json.loads(METADATA.read_text(encoding="utf-8"))
    compiled = json.loads(COMPILED.read_text(encoding="utf-8"))
    mapping = metadata["migration"]["id_mapping"]
    expected_mapping = [[agent["legacyId"], agent["id"]] for agent in compiled["agents"]]

    check(metadata["schema_version"] == 1, "metadata schema mismatch")
    check(
        metadata["component"] == "preset-agent-runtime-category-fix-client",
        "component identity mismatch",
    )
    check(metadata["artifact"]["origin"] == "independent-build-reproduction", "artifact origin changed")
    check(len(metadata["artifact"]["members"]) == 8, "artifact member contract changed")
    check(metadata["artifact"]["tar_members"] == 355, "Client tar member count changed")
    check(
        sorted(mapping) == sorted(expected_mapping),
        "migration mapping differs from compiled Agent source",
    )
    check(len(mapping) == 7, "migration must contain exactly seven Agents")
    check(
        all(legacy.startswith("workflow_") and next_id.startswith("agent_workflow_") for legacy, next_id in mapping),
        "Agent ID prefix contract changed",
    )
    check(
        sha256_file(COMPILED) == metadata["source"]["compiled_agents_sha256"],
        "compiled Agent artifact SHA-256 mismatch",
    )
    check(compiled["compiledDigest"] == metadata["source"]["compiled_digest"], "compiled Agent digest mismatch")
    check(metadata["github_actions"]["status"] == "completed", "CI run incomplete")
    check(metadata["github_actions"]["conclusion"] == "success", "CI run failed")
    check(
        metadata["github_actions"]["head_sha"] == metadata["source"]["repository_commit"],
        "CI source revision mismatch",
    )

    deploy = (SCRIPTS / "deploy.sh").read_text(encoding="utf-8")
    collect = (SCRIPTS / "collect-preflight.sh").read_text(encoding="utf-8")
    apply = (SCRIPTS / "remote-apply.py").read_text(encoding="utf-8")
    rollback = (SCRIPTS / "remote-rollback.py").read_text(encoding="utf-8")
    preflight = (SCRIPTS / "remote-preflight.py").read_text(encoding="utf-8")
    snapshot = (MIGRATION / "snapshot.js").read_text(encoding="utf-8")
    migrate = (MIGRATION / "migrate.js").read_text(encoding="utf-8")
    mongo_rollback = (MIGRATION / "rollback.js").read_text(encoding="utf-8")

    check("release-governance:scoped-deployment" in deploy, "scoped deployment marker missing")
    check(
        "release-governance:targets=LibreChat-API,chat-mongodb" in deploy,
        "combined deployment target marker missing",
    )
    check("release-governance:target-lock" in deploy, "enhanced target lock missing")
    check("--remove-orphans" not in "\n".join((deploy, apply, rollback)), "orphan removal is forbidden")
    check("remote-apply.py" in deploy and "migrate.js" in deploy, "migration runner is not staged")
    check("chat-mongodb" in preflight and "mongo_snapshot_sha256" in preflight, "Mongo preflight is incomplete")
    check("externalReferences" in snapshot and "getCollectionNames" in snapshot, "external reference scan missing")
    check("collectionName === 'agents'" in snapshot, "other Agent references are not scanned")
    check("$set: { id: nextId, versions }" in migrate, "migration write scope changed")
    check("deleteMany" not in migrate and "insertMany" not in migrate, "migration must preserve Agent resources")
    check("replaceOne" in mongo_rollback, "exact Agent document rollback is missing")
    check("ACL drift detected during rollback" in mongo_rollback, "ACL rollback guard missing")
    check("validate_migration" in apply, "post-migration equivalence check missing")
    check("remote-rollback.py" in apply and "mutation_started" in apply, "automatic combined rollback missing")
    check("/app/client/dist" in apply and "preset-agent-runtime-category-fix" in apply, "versioned Client mount missing")
    check(
        '"--force-recreate",\n                "api"' in apply
        and '"--force-recreate",\n            "api"' in rollback,
        "API-only recreation contract missing",
    )
    check(
        'librechat-preset-agent-runtime-category-runtime.XXXXXX"' in collect,
        "portable preflight temp-file template missing",
    )
    check("billable" not in migrate.lower(), "migration must not invoke a model")
    check("github_pat_" not in "\n".join((deploy, collect, apply, rollback)), "credential leaked into scripts")

    for shell_script in (
        SCRIPTS / "ssh-transport.sh",
        SCRIPTS / "collect-preflight.sh",
        SCRIPTS / "deploy.sh",
    ):
        subprocess.run(["bash", "-n", str(shell_script)], check=True)
    for python_script in (
        SCRIPTS / "verify-artifact.py",
        SCRIPTS / "remote-preflight.py",
        SCRIPTS / "remote-apply.py",
        SCRIPTS / "remote-rollback.py",
        SCRIPTS / "test-release.py",
    ):
        compile(python_script.read_text(encoding="utf-8"), str(python_script), "exec")
    for javascript in (
        MIGRATION / "snapshot.js",
        MIGRATION / "migrate.js",
        MIGRATION / "rollback.js",
        SCRIPTS / "test-migration.mjs",
    ):
        subprocess.run(["node", "--check", str(javascript)], check=True)
    subprocess.run(["node", str(SCRIPTS / "test-migration.mjs")], check=True)

    if len(sys.argv) == 2:
        result = load_verifier().verify(Path(sys.argv[1]).resolve(), METADATA)
        check(result["status"] == "passed", "Client artifact verification failed")
        check(
            result["hidden_contact_agent_ids"] == [next_id for _, next_id in mapping],
            "verified hidden Agent IDs changed",
        )
        print(json.dumps(result, sort_keys=True))
    else:
        print("artifact_verification=deferred (pass the release ZIP as argv[1])")
    print("preset_agent_runtime_category_release_contract=passed")


if __name__ == "__main__":
    main()

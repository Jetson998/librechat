#!/usr/bin/env python3

from __future__ import annotations

import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from runtime_common import (
    collect_target_snapshot,
    container_snapshot,
    load_json,
    public_checks,
    run_mongosh,
    snapshot_digest,
    validate_container_health,
    verify_compiled,
    write_json,
)


UNCHANGED_SNAPSHOT_KEYS = [
    "targetAgentIds",
    "targetCategoryValues",
    "ownerCandidates",
    "accessRoles",
    "aclEntries",
    "categories",
]


def assert_post_state(compiled: dict, before: dict, after: dict) -> None:
    expected = {agent["id"]: agent for agent in compiled["agents"]}
    agents = after.get("agents", [])
    if {agent.get("id") for agent in agents} != set(expected) or len(agents) != 7:
        raise RuntimeError("post-deploy Agent set is not the expected catalog")
    for agent in agents:
        if "support_contact" in agent:
            raise RuntimeError(f"{agent.get('id')} still has support_contact")
        compiled_agent = expected[agent["id"]]
        if agent.get("workflowTemplate", {}).get("sourceAgentDigest") != compiled_agent["agentDigest"]:
            raise RuntimeError(f"{agent.get('id')} has the wrong source Agent digest")
    for key in UNCHANGED_SNAPSHOT_KEYS:
        if before.get(key) != after.get(key):
            raise RuntimeError(f"non-Agent target state changed: {key}")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: remote-apply.py <stage-dir> <source-revision>")
    stage_dir = Path(sys.argv[1]).resolve()
    source_revision = sys.argv[2]
    compiled_path = stage_dir / "compiled-agents.json"
    preflight_path = stage_dir / "runtime-preflight.json"
    snapshot_script = stage_dir / "snapshot-targets.js"
    update_script = stage_dir / "remove-support-contact.js"
    rollback_script = stage_dir / "rollback-agents.js"

    compiled = load_json(compiled_path)
    preflight = load_json(preflight_path)
    verify_compiled(compiled)
    if preflight.get("status") != "passed":
        raise RuntimeError("runtime preflight did not pass")
    if preflight.get("source_revision") != source_revision:
        raise RuntimeError("runtime preflight source revision mismatch")
    if preflight.get("catalog", {}).get("compiled_digest") != compiled.get("compiledDigest"):
        raise RuntimeError("runtime preflight catalog mismatch")

    before = collect_target_snapshot(compiled, snapshot_script)
    if snapshot_digest(before) != preflight.get("data_snapshot_sha256"):
        raise RuntimeError("target Mongo state drifted after preflight")
    containers_before = container_snapshot()
    validate_container_health(containers_before)
    if containers_before != preflight.get("containers"):
        raise RuntimeError("protected container identity drifted after preflight")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    backup_dir = Path(
        f"/opt/librechat/backups/preset-agent-contact-removal-{source_revision[:12]}-{timestamp}"
    )
    backup_dir.mkdir(parents=True, mode=0o700)
    for path in [
        compiled_path,
        preflight_path,
        snapshot_script,
        update_script,
        rollback_script,
        stage_dir / "runtime_common.py",
        stage_dir / "remote-rollback.py",
    ]:
        shutil.copy2(path, backup_dir / path.name)
    write_json(backup_dir / "before-target-snapshot.json", before)

    update_result = None
    rollback_result = None
    try:
        update_result = run_mongosh(compiled, update_script)
        if update_result.get("status") != "passed":
            raise RuntimeError("contact removal script did not report success")
        if update_result.get("writes") != ["agents"]:
            raise RuntimeError("contact removal script reported an unexpected write scope")
        after = collect_target_snapshot(compiled, snapshot_script)
        assert_post_state(compiled, before, after)
        containers_after = container_snapshot()
        validate_container_health(containers_after)
        if containers_after != containers_before:
            raise RuntimeError("a protected container changed during the data-only release")
        checks = public_checks()
    except Exception:
        rollback_result = run_mongosh(compiled, rollback_script, backup=preflight["data_snapshot"])
        restored = collect_target_snapshot(compiled, snapshot_script)
        if snapshot_digest(restored) != preflight.get("data_snapshot_sha256"):
            raise RuntimeError("automatic rollback did not restore the target snapshot")
        failure = {
            "schema_version": 1,
            "status": "rolled_back",
            "source_revision": source_revision,
            "backup_dir": str(backup_dir),
            "update_result": update_result,
            "rollback_result": rollback_result,
        }
        write_json(stage_dir / "DEPLOY_RESULT.json", failure)
        write_json(backup_dir / "DEPLOY_RESULT.json", failure)
        raise

    result = {
        "schema_version": 1,
        "status": "passed",
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "source_revision": source_revision,
        "catalog_digest": compiled["compiledDigest"],
        "backup_dir": str(backup_dir),
        "before_snapshot_sha256": preflight["data_snapshot_sha256"],
        "after_snapshot_sha256": snapshot_digest(after),
        "update_result": update_result,
        "rollback_result": rollback_result,
        "containers_before": containers_before,
        "containers_after": containers_after,
        "public_checks": checks,
        "changed_services": ["chat-mongodb:data"],
        "restarted_services": [],
    }
    write_json(stage_dir / "DEPLOY_RESULT.json", result)
    write_json(backup_dir / "DEPLOY_RESULT.json", result)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()

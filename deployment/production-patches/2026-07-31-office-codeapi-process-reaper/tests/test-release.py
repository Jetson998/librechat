#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import py_compile
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
PATCH = ROOT / "deployment/production-patches/2026-07-31-office-codeapi-process-reaper"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


spec = importlib.util.spec_from_file_location("patch_compose", PATCH / "scripts/patch-compose.py")
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)
block = (PATCH / "config/codeapi-service.block").read_text(encoding="utf-8")
sample = "services:\n  api:\n    image: example/api\n"
patched = module.patch_override(sample, block)
require(patched.count("  codeapi:\n") == 1, "CodeAPI service was not inserted exactly once")
require(module.patch_override(patched, block) == patched, "patch is not idempotent")
require("    init: true\n" in block, "init reaper is missing")
require("    pids_limit: 256\n" in block, "PID guard changed")
require("      - ALL\n" in block and "no-new-privileges:true" in block, "security controls changed")

deploy = (PATCH / "scripts/deploy.sh").read_text(encoding="utf-8")
require("release-governance:scoped-deployment" in deploy, "scoped marker missing")
require("release-governance:targets=LibreChat-API,LibreChat-CodeAPI" in deploy, "target marker mismatch")
require("release-governance:target-lock" in deploy, "target lock marker missing")
apply_text = (PATCH / "scripts/remote-apply.py").read_text(encoding="utf-8")
require("--remove-orphans" not in apply_text, "runner must not remove orphans")
require('"--no-deps", "--force-recreate", "codeapi"' in apply_text, "runner is not CodeAPI-scoped")
require("remote-rollback.py" in apply_text, "automatic rollback is missing")
require("API-to-CodeAPI exec did not recover after DNS transition" in apply_text, "DNS transition retry is missing")

python_files = sorted((PATCH / "scripts").glob("*.py")) + [Path(__file__)]
with tempfile.TemporaryDirectory() as temp_dir:
    for index, source in enumerate(python_files):
        py_compile.compile(str(source), cfile=str(Path(temp_dir) / f"{index}.pyc"), doraise=True)
print("codeapi_process_reaper_contract=passed")

import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "skills/lightweight-release-governance/scripts/release_gate.py"


def run_gate(*args, cwd=ROOT):
    env = os.environ.copy()
    env["PYTHONPYCACHEPREFIX"] = "/tmp/librechat-release-gate-pycache"
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=str(cwd),
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


class ReleaseGateTests(unittest.TestCase):
    def test_project_config_validates(self):
        result = run_gate("validate-config", "--config", "release-governance.json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["project_id"], "librechat-self-host")

    def test_not_started_is_not_command_failure(self):
        result = run_gate("classify-failure", "--no-started", "--exit-code", "1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["category"], "execution_not_started")

    def test_started_authentication_error_is_classified_separately(self):
        result = run_gate(
            "classify-failure",
            "--started",
            "--exit-code",
            "1",
            "--message",
            "authentication failed",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["category"], "authentication_failed")

    def test_manifest_rejects_missing_required_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "release.tar.gz"
            with tarfile.open(artifact, "w:gz") as archive:
                source = root / "present.txt"
                source.write_text("present\n", encoding="utf-8")
                archive.add(source, arcname="present.txt")
            result = run_gate(
                "package-manifest",
                "--release-id",
                "fixture",
                "--source-revision",
                "revision-1",
                "--artifact",
                str(artifact),
                "--required",
                "missing.txt",
                "--output",
                str(root / "manifest.json"),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("missing required artifact paths", result.stderr)

    def test_manifest_records_required_artifact_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "release.tar.gz"
            source = root / "required.txt"
            source.write_text("required\n", encoding="utf-8")
            with tarfile.open(artifact, "w:gz") as archive:
                archive.add(source, arcname="required.txt")
            manifest = root / "manifest.json"
            result = run_gate(
                "package-manifest",
                "--release-id",
                "fixture",
                "--source-revision",
                "revision-1",
                "--artifact",
                str(artifact),
                "--required",
                "required.txt",
                "--output",
                str(manifest),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertEqual(payload["files"][0]["path"], "required.txt")
            self.assertEqual(len(payload["artifact"]["sha256"]), 64)

    def test_new_release_record_uses_provider_neutral_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            record = Path(directory) / "RELEASE.json"
            created = run_gate(
                "new-record",
                "--release-id",
                "fixture",
                "--project-id",
                "fixture-project",
                "--mode",
                "release",
                "--output",
                str(record),
            )
            self.assertEqual(created.returncode, 0, created.stderr)
            validated = run_gate("validate-record", "--record", str(record))
            self.assertEqual(validated.returncode, 0, validated.stderr)
            payload = json.loads(record.read_text(encoding="utf-8"))
            for key in (
                "source_revision",
                "release_plan",
                "build_attestation",
                "artifact_digest",
                "runtime_snapshot",
                "backup_reference",
                "acceptance_result",
            ):
                self.assertIn(key, payload)

    def test_checkpoint_invalidates_downstream_gates_when_inputs_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for command in ("prepare.sh", "verify.sh", "package.sh"):
                (root / command).write_text("#!/bin/sh\n", encoding="utf-8")
            config = {
                "schema_version": 1,
                "project": {"id": "fixture", "name": "Fixture"},
                "adapter": {
                    "prepare": "prepare.sh",
                    "preflight": "verify.sh",
                    "package": "package.sh",
                    "deploy": "verify.sh",
                    "acceptance": "verify.sh",
                },
                "evidence": {"state_root": ".state", "record_root": "records"},
                "risk_modes": {
                    "protected": {
                        "required_gates": [
                            "prepare",
                            "repository_gate",
                            "package_manifest",
                        ],
                        "not_applicable_allowed": [],
                    }
                },
            }
            config_path = root / "release-governance.json"
            config_path.write_text(json.dumps(config), encoding="utf-8")
            evidence = root / "evidence.json"
            evidence.write_text("{}", encoding="utf-8")
            first_inputs = root / "inputs-1.json"
            first_inputs.write_text('{"revision":"one"}', encoding="utf-8")
            second_inputs = root / "inputs-2.json"
            second_inputs.write_text('{"revision":"two"}', encoding="utf-8")

            common = ["--config", str(config_path), "--release-id", "fixture", "--mode", "protected"]
            for gate, inputs in (("prepare", first_inputs), ("repository_gate", first_inputs), ("package_manifest", first_inputs)):
                result = run_gate(
                    "checkpoint-set",
                    *common,
                    "--gate",
                    gate,
                    "--status",
                    "passed",
                    "--inputs",
                    str(inputs),
                    "--evidence",
                    str(evidence),
                )
                self.assertEqual(result.returncode, 0, result.stderr)

            result = run_gate(
                "checkpoint-set",
                *common,
                "--gate",
                "repository_gate",
                "--status",
                "passed",
                "--inputs",
                str(second_inputs),
                "--evidence",
                str(evidence),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            state = json.loads((root / ".state/fixture/checkpoint.json").read_text())
            self.assertEqual(state["gates"]["package_manifest"]["status"], "invalidated")

    def test_terminal_release_record_can_close_a_failed_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "adapter.sh").write_text("#!/bin/sh\n", encoding="utf-8")
            config = {
                "schema_version": 1,
                "project": {"id": "fixture", "name": "Fixture"},
                "adapter": {
                    "prepare": "adapter.sh",
                    "preflight": "adapter.sh",
                    "package": "adapter.sh",
                    "deploy": "adapter.sh",
                    "acceptance": "adapter.sh",
                },
                "evidence": {"state_root": ".state", "record_root": "records"},
                "risk_modes": {
                    "protected": {
                        "required_gates": [
                            "prepare",
                            "repository_gate",
                            "apply_gate",
                            "acceptance_gate",
                            "release_record",
                        ],
                        "not_applicable_allowed": [],
                    }
                },
            }
            config_path = root / "release-governance.json"
            config_path.write_text(json.dumps(config), encoding="utf-8")
            evidence = root / "evidence.json"
            evidence.write_text("{}", encoding="utf-8")
            inputs = root / "inputs.json"
            inputs.write_text("{}", encoding="utf-8")
            common = ["--config", str(config_path), "--release-id", "fixture", "--mode", "protected"]
            for gate in ("prepare", "repository_gate"):
                result = run_gate(
                    "checkpoint-set",
                    *common,
                    "--gate",
                    gate,
                    "--status",
                    "passed",
                    "--inputs",
                    str(inputs),
                    "--evidence",
                    str(evidence),
                )
                self.assertEqual(result.returncode, 0, result.stderr)
            failed = run_gate(
                "checkpoint-set",
                *common,
                "--gate",
                "apply_gate",
                "--status",
                "failed",
                "--inputs",
                str(inputs),
                "--evidence",
                str(evidence),
                "--reason",
                "deployment failed",
            )
            self.assertEqual(failed.returncode, 0, failed.stderr)
            closed = run_gate(
                "checkpoint-set",
                *common,
                "--gate",
                "release_record",
                "--status",
                "passed",
                "--inputs",
                str(inputs),
                "--evidence",
                str(evidence),
                "--terminal-record",
            )
            self.assertEqual(closed.returncode, 0, closed.stderr)

    def test_new_project_template_validates_and_fails_closed(self):
        template = ROOT / "skills/lightweight-release-governance/assets/project-adapter-template"
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            shutil.copytree(template, project, dirs_exist_ok=True)
            config_path = project / "release-governance.json"
            result = run_gate("validate-config", "--config", str(config_path), cwd=project)
            self.assertEqual(result.returncode, 0, result.stderr)

            config = json.loads(config_path.read_text(encoding="utf-8"))
            for name in ("prepare", "preflight", "package", "deploy", "acceptance"):
                command = project / config["adapter"][name]
                completed = subprocess.run(
                    ["sh", str(command)],
                    cwd=str(project),
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                self.assertNotEqual(completed.returncode, 0)
                self.assertIn("adapter_not_implemented", completed.stderr)

    def test_new_project_onboarding_is_linked_from_generic_skill(self):
        skill = (ROOT / "skills/lightweight-release-governance/SKILL.md").read_text(
            encoding="utf-8"
        )
        reference = ROOT / "skills/lightweight-release-governance/references/new-project-onboarding.md"
        self.assertTrue(reference.is_file())
        self.assertIn("references/new-project-onboarding.md", skill)

    def test_generic_skill_keeps_risk_adaptive_business_acceptance(self):
        skill = (ROOT / "skills/lightweight-release-governance/SKILL.md").read_text(
            encoding="utf-8"
        ).lower()
        for phrase in (
            "business acceptance",
            "light acceptance",
            "heavy acceptance",
            "reuse valid",
            "stop further rollout",
            "not business acceptance",
        ):
            self.assertIn(phrase, skill)

    def test_generic_skill_has_no_project_specific_provider_names(self):
        generic = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (ROOT / "skills/lightweight-release-governance").rglob("*")
            if path.is_file()
        )
        for forbidden in ("LibreChat", "OpenWebUI", "WebAI", "GitHub", "Docker", "Codex", "SSH"):
            self.assertNotIn(forbidden, generic)


if __name__ == "__main__":
    unittest.main()

import json
import importlib.util
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def load_adapter_module():
    path = ROOT / "scripts/librechat-release-adapter.py"
    spec = importlib.util.spec_from_file_location("librechat_release_adapter", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(cwd, *args):
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    ).stdout.strip()


class LibreChatContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = json.loads((ROOT / "release-governance.json").read_text(encoding="utf-8"))

    def test_adapter_entry_points_exist(self):
        for relative in self.config["adapter"].values():
            path = ROOT / relative
            self.assertTrue(path.is_file(), relative)

    def test_release_planning_config_is_valid(self):
        adapter = load_adapter_module()
        planning = adapter.validate_release_planning_config(self.config)
        self.assertTrue(planning["rules"])

    def test_protected_mode_contains_the_full_write_path(self):
        required = self.config["risk_modes"]["protected"]["required_gates"]
        self.assertEqual(
            required,
            [
                "prepare",
                "preflight_permissions",
                "repository_gate",
                "package_manifest",
                "ci_attestation_gate",
                "target_preflight",
                "apply_gate",
                "acceptance_gate",
                "release_record",
            ],
        )

    def test_protected_mode_requires_build_attestation(self):
        allowed = self.config["risk_modes"]["protected"]["not_applicable_allowed"]
        self.assertNotIn("ci_attestation_gate", allowed)

    def test_business_patch_push_does_not_start_heavy_release_workflow(self):
        workflow = (ROOT / ".github/workflows/librechat-release-governance.yml").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("deployment/production-patches/**", workflow)
        self.assertIn("workflow_dispatch", workflow)

    def test_new_wrappers_do_not_use_environment_bypass(self):
        for path in (ROOT / "scripts").glob("release-*.sh"):
            content = path.read_text(encoding="utf-8")
            self.assertNotIn("PREFLIGHT_ONLY", content, str(path))

    def test_adapter_packages_from_a_revision_without_rsync(self):
        adapter = (ROOT / "scripts/librechat-release-adapter.py").read_text(encoding="utf-8")
        self.assertIn('"archive"', adapter)
        self.assertNotIn("rsync", adapter)

    def test_index_and_guide_cover_the_adapter(self):
        index = (ROOT / "docs/RELEASE_GOVERNANCE_INDEX.md").read_text(encoding="utf-8")
        guide = (ROOT / "docs/LIGHTWEIGHT_RELEASE_GOVERNANCE_ZH_CN.md").read_text(encoding="utf-8")
        for name in (
            "release-governance.json",
            "release-verify.sh",
            "release-package.sh",
            "release-preflight.sh",
            "release-deploy.sh",
            "release-acceptance.sh",
            "validate-release-governance.sh",
            "RELEASE.json",
            ".release-state",
        ):
            self.assertIn(name, index)
            self.assertIn(name, guide)

    def test_governance_workflow_covers_new_project_guide(self):
        workflow = (ROOT / ".github/workflows/librechat-release-governance.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("docs/RELEASE_GOVERNANCE_NEW_PROJECT_ZH_CN.md", workflow)

    def test_librechat_contract_keeps_scope_specific_business_acceptance(self):
        contract = (
            ROOT / "skills/librechat-release-governance/references/project-contract.md"
        ).read_text(encoding="utf-8")
        guide = (ROOT / "docs/LIGHTWEIGHT_RELEASE_GOVERNANCE_ZH_CN.md").read_text(
            encoding="utf-8"
        )
        checklist = (ROOT / "docs/RELEASE_CHECKLIST.md").read_text(encoding="utf-8")
        for phrase in ("业务验收", "轻度验收", "重度验收", "模型路由", "Office"):
            self.assertIn(phrase, contract)
            self.assertIn(phrase, guide)
        self.assertIn("Business acceptance level", checklist)
        self.assertIn("Not Default Business Acceptance", checklist)

    def test_ui_patch_resolves_to_light_batch_release_plan(self):
        adapter = load_adapter_module()
        revision = git(ROOT, "rev-parse", "HEAD")
        record = {
            "mode": "protected",
            "source_revision": revision,
            "change_summary": {
                "scope": [
                    "deployment/production-patches/2026-07-18-search-favicon-fallback"
                ]
            },
        }
        plan = adapter.release_plan(record, "fixture-ui", persist=False)
        self.assertEqual(plan["minimum_mode"], "protected")
        self.assertEqual(plan["acceptance_level"], "light")
        self.assertIn("client-bundle", plan["build_requirements"])
        self.assertIn("browser-ui", plan["acceptance_checks"])
        self.assertEqual(plan["deployment_targets"], ["LibreChat-API"])
        self.assertEqual(plan["public_acceptance_checks"], ["api-config", "main-root"])
        self.assertNotIn("admin-root", plan["public_acceptance_checks"])
        self.assertNotIn("office-auth-boundary", plan["public_acceptance_checks"])

    def test_usage_api_path_adds_performance_evidence_without_upgrading_mode(self):
        adapter = load_adapter_module()
        revision = git(ROOT, "rev-parse", "HEAD")
        record = {
            "mode": "protected",
            "source_revision": revision,
            "change_summary": {
                "scope": [
                    "deployment/production-patches/2026-07-17-user-usage-dashboard/api/usage-dashboard.js"
                ]
            },
        }
        plan = adapter.release_plan(record, "fixture-usage", persist=False)
        self.assertEqual(plan["minimum_mode"], "protected")
        self.assertIn("performance-test", plan["test_requirements"])

    def test_data_patch_requires_enhanced_mode_and_backup(self):
        adapter = load_adapter_module()
        revision = git(ROOT, "rev-parse", "HEAD")
        scope = [
            "deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/scripts/backfill-generated-attachment-files.js"
        ]
        protected = {
            "mode": "protected",
            "source_revision": revision,
            "change_summary": {"scope": scope},
        }
        with self.assertRaises(adapter.AdapterError):
            adapter.release_plan(protected, "fixture-data-protected", persist=False)

        enhanced = dict(protected)
        enhanced["mode"] = "enhanced"
        plan = adapter.release_plan(enhanced, "fixture-data-enhanced", persist=False)
        self.assertEqual(plan["minimum_mode"], "enhanced")
        self.assertEqual(plan["acceptance_level"], "heavy")
        self.assertTrue(plan["data_backup_required"])
        self.assertIn("chat-mongodb", plan["deployment_targets"])

    def test_major_batch_requires_enhanced_acceptance_reference(self):
        adapter = load_adapter_module()
        revision = git(ROOT, "rev-parse", "HEAD")
        record = {
            "mode": "enhanced",
            "source_revision": revision,
            "change_summary": {
                "scope": [
                    "deployment/production-patches/2026-07-18-search-favicon-fallback"
                ]
            },
            "project_adapter": {"release_kind": "major-release"},
        }
        plan = adapter.release_plan(record, "fixture-major", persist=False)
        self.assertEqual(plan["minimum_mode"], "enhanced")
        self.assertEqual(plan["acceptance_level"], "heavy")
        self.assertIn(
            "full-business-acceptance-reference", plan["acceptance_checks"]
        )

    def test_runtime_evidence_enforces_resource_thresholds(self):
        adapter = load_adapter_module()
        revision = git(ROOT, "rev-parse", "HEAD")
        record = {
            "mode": "protected",
            "source_revision": revision,
            "change_summary": {
                "scope": [
                    "deployment/production-patches/2026-07-18-search-favicon-fallback"
                ]
            },
        }
        plan = adapter.release_plan(record, "fixture-runtime", persist=False)
        evidence = {
            "status": "passed",
            "source_revision": revision,
            "release_plan_sha256": plan["release_plan_sha256"],
            "checks": [
                {"id": check, "status": "passed"}
                for check in plan["preflight_checks"]
            ],
            "checked_services": plan["affected_services"],
            "host_resources": {
                "memory_available_mb": 2048,
                "disk_free_mb": 8192,
            },
            "rollback_available": True,
        }
        adapter.validate_runtime_evidence(evidence, record, plan)
        evidence["host_resources"]["disk_free_mb"] = 128
        with self.assertRaises(adapter.AdapterError):
            adapter.validate_runtime_evidence(evidence, record, plan)

    def test_production_attestation_proves_build_ran_off_target(self):
        adapter = load_adapter_module()
        record = {
            "source_revision": "revision-one",
            "artifact_digest": {"details": {"value": "artifact-one"}},
        }
        plan = {
            "release_plan_sha256": "plan-one",
            "production_release": True,
            "build_requirements": ["deployable-artifact"],
            "test_requirements": ["release-scope-tests"],
        }
        attestation = {
            "status": "passed",
            "source_revision": "revision-one",
            "artifact_sha256": "artifact-one",
            "release_plan_sha256": "plan-one",
            "completed_requirements": [
                "deployable-artifact",
                "release-scope-tests",
            ],
            "build_environment": "ci",
            "production_host": False,
        }
        adapter.validate_build_attestation(attestation, record, plan)
        attestation["production_host"] = True
        with self.assertRaises(adapter.AdapterError):
            adapter.validate_build_attestation(attestation, record, plan)

    def test_deploy_runner_targets_must_match_release_plan(self):
        adapter = load_adapter_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = root / "deployment/production-patches/fixture/scripts/deploy.sh"
            runner.parent.mkdir(parents=True)
            runner.write_text(
                "#!/bin/sh\n"
                "# release-governance:scoped-deployment\n"
                "# release-governance:targets=LibreChat-API\n",
                encoding="utf-8",
            )
            record = {
                "mode": "protected",
                "project_adapter": {
                    "deploy_runner": "deployment/production-patches/fixture/scripts/deploy.sh"
                },
            }
            plan = {"deployment_targets": ["LibreChat-API"]}
            adapter.validate_runner(self.config, record, root, plan)
            plan["deployment_targets"] = ["LibreChat-Admin-Panel"]
            with self.assertRaises(adapter.AdapterError):
                adapter.validate_runner(self.config, record, root, plan)

    def test_repository_gate_allows_out_of_scope_remote_change_and_blocks_scope_change(self):
        adapter = load_adapter_module()
        original_root = adapter.ROOT
        original_config = adapter.CONFIG_PATH
        try:
            with tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                remote = base / "remote.git"
                repo = base / "repo"
                remote.mkdir()
                repo.mkdir()
                git(remote, "init", "--bare")
                git(repo, "init", "-b", "main")
                git(repo, "config", "user.name", "Release Test")
                git(repo, "config", "user.email", "release-test@example.local")
                (repo / "feature.txt").write_text("version one\n", encoding="utf-8")
                (repo / "other.txt").write_text("other one\n", encoding="utf-8")
                (repo / ".gitignore").write_text(".release-state/\n", encoding="utf-8")
                (repo / "deployment/release-records/fixture").mkdir(parents=True)
                (repo / "deployment/release-records/fixture/RELEASE.json").write_text(
                    "{}\n", encoding="utf-8"
                )
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
                    "evidence": {
                        "state_root": ".release-state",
                        "record_root": "deployment/release-records",
                    },
                    "risk_modes": {
                        "protected": {
                            "required_gates": ["prepare", "repository_gate"],
                            "not_applicable_allowed": [],
                        }
                    },
                    "repository": {
                        "remote": "origin",
                        "default_branch": "main",
                        "expected_remote": str(remote),
                        "allow_dirty_outside_scope": True,
                        "governance_paths": ["release-governance.json"],
                    },
                }
                (repo / "adapter.sh").write_text("#!/bin/sh\n", encoding="utf-8")
                config_path = repo / "release-governance.json"
                config_path.write_text(json.dumps(config), encoding="utf-8")
                git(repo, "add", ".")
                git(repo, "commit", "-m", "Initial")
                source_revision = git(repo, "rev-parse", "HEAD")
                git(repo, "remote", "add", "origin", str(remote))
                git(repo, "push", "-u", "origin", "main")

                adapter.ROOT = repo.resolve()
                adapter.CONFIG_PATH = config_path.resolve()
                record = {
                    "source_revision": source_revision,
                    "change_summary": {"scope": ["feature.txt"]},
                    "mode": "protected",
                }
                evidence, _ = adapter.repository_evidence(record, "fixture")
                self.assertEqual(evidence["status"], "passed")

                (repo / "feature.txt").write_text("dirty\n", encoding="utf-8")
                with self.assertRaises(adapter.AdapterError):
                    adapter.repository_evidence(record, "fixture")
                git(repo, "restore", "feature.txt")

                (repo / "other.txt").write_text("other two\n", encoding="utf-8")
                git(repo, "add", "other.txt")
                git(repo, "commit", "-m", "Change outside scope")
                git(repo, "push", "origin", "main")
                evidence, _ = adapter.repository_evidence(record, "fixture")
                self.assertEqual(evidence["status"], "passed")

                (repo / "feature.txt").write_text("version two\n", encoding="utf-8")
                git(repo, "add", "feature.txt")
                git(repo, "commit", "-m", "Change release scope")
                git(repo, "push", "origin", "main")
                with self.assertRaises(adapter.AdapterError):
                    adapter.repository_evidence(record, "fixture")
        finally:
            adapter.ROOT = original_root
            adapter.CONFIG_PATH = original_config

    def test_deploy_extraction_rejects_links(self):
        adapter = load_adapter_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "unsafe.tar.gz"
            with tarfile.open(archive, "w:gz") as handle:
                member = tarfile.TarInfo("unsafe-link")
                member.type = tarfile.SYMTYPE
                member.linkname = "/tmp/outside"
                handle.addfile(member)
            with self.assertRaises(adapter.AdapterError):
                adapter.safe_extract(archive, root / "output")


if __name__ == "__main__":
    unittest.main()

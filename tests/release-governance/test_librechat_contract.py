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

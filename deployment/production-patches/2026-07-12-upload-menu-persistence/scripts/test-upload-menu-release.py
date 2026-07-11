#!/usr/bin/env python3

from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

import yaml


PATCH_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[4]
MOUNT = "/opt/librechat/ui-label-patch/client-dist:/app/client/dist:ro"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def read(path):
    return path.read_text(encoding="utf-8")


def load_yaml(path):
    return yaml.safe_load(read(path))


def test_builder():
    with tempfile.TemporaryDirectory() as directory:
        dist = Path(directory) / "dist"
        assets = dist / "assets"
        assets.mkdir(parents=True)
        (assets / "index.js").write_text("console.log('fixture');", encoding="utf-8")
        (assets / "index.css").write_text("body {}", encoding="utf-8")
        (dist / "manifest.webmanifest").write_text("{}", encoding="utf-8")
        (dist / "registerSW.js").write_text("", encoding="utf-8")
        (dist / "index.html").write_text(
            """<!doctype html>
<html><head>
<link rel="stylesheet" href="./assets/index.css">
<link rel="manifest" href="./manifest.webmanifest">
</head><body><div id="root"></div>
<script type="module" src="./assets/index.js"></script>
<script id="business-upload-label-patch">window.oldPatch = true;</script>
<script src="./registerSW.js"></script>
</body></html>
""",
            encoding="utf-8",
        )

        command = [
            sys.executable,
            str(PATCH_ROOT / "scripts" / "build-upload-menu-client.py"),
            "--dist",
            str(dist),
        ]
        subprocess.run(command, check=True, capture_output=True, text=True)
        subprocess.run(command, check=True, capture_output=True, text=True)

        html = read(dist / "index.html")
        require(html.count("business-upload-label-patch") == 1, "builder is not idempotent")
        require(
            'src="/business-upload-menu.js"' in html,
            "external upload-menu script tag is missing",
        )
        require((dist / "business-upload-menu.js").is_file(), "patch source was not copied")


def test_script_contract():
    script_path = PATCH_ROOT / "client" / "business-upload-menu.js"
    script = read(script_path)
    required = (
        "图片上传",
        "Office文件上传",
        "文件提取文字上传",
        "仅图片；用于截图、照片、图像识别",
        "Word/Excel/PPT 原文件；可读写并返回文件",
        "转成文本给模型分析；适合审阅总结",
        "Upload to Provider",
        "Upload as Text",
        "Upload to Code Environment",
        "image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg,.heic,.heif,.avif",
        ".docx,.xlsx,.xlsm,.ppt,.pptx,.csv,.tsv,.ods,.odp",
        ".pdf,.doc,.docx,.xls,.xlsx,.xlsm,.ppt,.pptx,.txt,.md,.csv,.tsv,.json,.html,.htm,.rtf,.odt,.ods,.odp",
    )
    for value in required:
        require(value in script, f"missing upload-menu contract value: {value}")
    require(script.count("__businessUploadMenuPatchInstalled") >= 2, "install guard missing")
    require("event.stopImmediatePropagation" in script, "invalid upload guard missing")
    require("input.value = ''" in script, "invalid file reset missing")

    node = shutil.which("node")
    if node:
        subprocess.run([node, "--check", str(script_path)], check=True, capture_output=True, text=True)
        subprocess.run(
            [
                node,
                "--check",
                str(PATCH_ROOT / "scripts" / "merge-compose-upload-menu.cjs"),
            ],
            check=True,
            capture_output=True,
            text=True,
        )


def test_compose_and_release_guards():
    override_paths = (
        REPO_ROOT / "deployment/production-patches/2026-07-11-admin-panel/compose.override.yaml",
        REPO_ROOT
        / "deployment/production-patches/2026-07-11-admin-panel-zh-cn/compose.override.yaml",
    )
    for path in override_paths:
        document = load_yaml(path)
        volumes = document["services"]["api"]["volumes"]
        require(MOUNT in volumes, f"upload-menu mount missing from {path}")

    guarded_deploys = (
        REPO_ROOT
        / "deployment/production-patches/2026-07-11-admin-panel/scripts/deploy-admin-panel.sh",
        REPO_ROOT
        / "deployment/production-patches/2026-07-11-admin-panel-zh-cn/scripts/deploy.sh",
    )
    for path in guarded_deploys:
        deploy = read(path)
        for marker in (
            "business-upload-label-patch",
            "business-upload-menu.js",
            "Office文件上传",
            "/opt/librechat/ui-label-patch/client-dist",
        ):
            require(marker in deploy, f"release guard {marker!r} missing from {path}")

    deployment = read(PATCH_ROOT / "scripts" / "deploy-upload-menu.sh")
    for marker in (
        "PREFLIGHT_ONLY",
        "rollback",
        "--force-recreate api",
        "DEPLOY_RESULT.txt",
        "LibreChat-CodeAPI",
        "/office/",
    ):
        require(marker in deployment, f"upload-menu deployment guard missing: {marker}")


def test_secret_scan():
    combined = "\n".join(read(path) for path in PATCH_ROOT.rglob("*") if path.is_file())
    patterns = (
        r"github_pat_[A-Za-z0-9_]+",
        r"sk-[A-Za-z0-9_-]{12,}",
        r"password\s*[:=]\s*['\"][^$][^'\"]{6,}",
    )
    for pattern in patterns:
        require(re.search(pattern, combined, re.IGNORECASE) is None, f"possible secret: {pattern}")


def main():
    test_builder()
    test_script_contract()
    test_compose_and_release_guards()
    test_secret_scan()
    print("upload_menu_release: ok")


if __name__ == "__main__":
    main()

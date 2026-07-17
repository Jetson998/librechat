#!/usr/bin/env python3

from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


PATCH_ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def read(path):
    return path.read_text(encoding="utf-8")


def test_builder_idempotence_and_coexistence():
    with tempfile.TemporaryDirectory() as directory:
        dist = Path(directory) / "dist"
        assets = dist / "assets"
        assets.mkdir(parents=True)
        (assets / "index.js").write_text("console.log('fixture');", encoding="utf-8")
        (assets / "index.css").write_text("body {}", encoding="utf-8")
        (dist / "manifest.webmanifest").write_text("{}", encoding="utf-8")
        (dist / "registerSW.js").write_text("", encoding="utf-8")
        (dist / "business-upload-menu.js").write_text(
            "window.__businessUploadMenuPatchInstalled = true;",
            encoding="utf-8",
        )
        (dist / "index.html").write_text(
            """<!doctype html>
<html><head>
<link rel="stylesheet" href="./assets/index.css">
<link rel="manifest" href="./manifest.webmanifest">
</head><body><div id="root"></div>
<script type="module" src="./assets/index.js"></script>
<script id="business-upload-label-patch" src="/business-upload-menu.js"></script>
<script id="odysseia-login-page-patch">window.oldPatch = true;</script>
<script src="./registerSW.js"></script>
</body></html>
""",
            encoding="utf-8",
        )

        command = [
            sys.executable,
            str(PATCH_ROOT / "scripts" / "build-odysseia-login-client.py"),
            "--dist",
            str(dist),
        ]
        subprocess.run(command, check=True, capture_output=True, text=True)
        subprocess.run(command, check=True, capture_output=True, text=True)

        html = read(dist / "index.html")
        require(html.count("odysseia-login-page-patch") == 1, "builder is not idempotent")
        require(html.count("business-upload-label-patch") == 1, "upload patch marker was changed")
        require(
            re.search(r'src="/odysseia-login\.js\?v=[0-9a-f]{12}"', html) is not None,
            "versioned external odysseia script tag is missing",
        )
        require((dist / "odysseia-login.js").is_file(), "patch source was not copied")
        require((dist / "business-upload-menu.js").is_file(), "upload patch script was not preserved")


def test_script_contract():
    script_path = PATCH_ROOT / "client" / "odysseia-login.js"
    script = read(script_path)
    required = (
        "Odýsseia",
        "Start your Agent Studio.",
        "odysseia-wordmark",
        "font-size: clamp(28px, 2.7vw, 38px)",
        "localizeLoginFields(panel)",
        "localizeSubmitButton(panel)",
        "submit.value = 'Continue'",
        "label.textContent = 'Continue'",
        "['password', 'Password']",
        "odysseia-field-label",
        "linear-gradient(135deg, #a5e4ff, #58c7f3 52%, #38bdf8)",
        "font-weight: 400",
        "odysseia-login-active",
        "odysseia-login-panel",
        "odysseia-panel-mythic",
        "clearPanelDecorations(panel)",
        "const card = form.parentElement",
        "flex-direction: row !important",
        '[data-odysseia-login-shell="true"] > :not(main)',
        '[data-odysseia-login-shell="true"] > main',
        "odysseia-login-page-patch",
        "__odysseiaLoginPatchInstalled",
        "https://image01.vidu.zone/vidu/landing-page/login-bg.c7293340.mp4",
        "input[type=\"password\"]",
        "MutationObserver",
        "version: '2026-07-17.4'",
    )
    for value in required:
        require(value in script, f"missing login patch contract value: {value}")

    node = shutil.which("node")
    if node:
        subprocess.run([node, "--check", str(script_path)], check=True, capture_output=True, text=True)


def test_deployment_guards():
    deployment = read(PATCH_ROOT / "scripts" / "deploy-odysseia-login.sh")
    for marker in (
        "PREFLIGHT_ONLY",
        "rollback",
        "--force-recreate api",
        "DEPLOY_RESULT.txt",
        "LibreChat-CodeAPI",
        "/office/",
        "business-upload-label-patch",
        "odysseia-login-page-patch",
        "/opt/librechat/ui-label-patch/client-dist:/app/client/dist:ro",
    ):
        require(marker in deployment, f"deployment guard missing: {marker}")

    remote_release = read(PATCH_ROOT / "scripts" / "run-remote-release.sh")
    for marker in (
        "https://github.com/Jetson998/librechat.git",
        "test-odysseia-login-release.py",
        "PREFLIGHT_ONLY=true",
        "deploy-odysseia-login.sh",
        "release_commit=\"${1:?usage:",
    ):
        require(marker in remote_release, f"remote release guard missing: {marker}")


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
    test_builder_idempotence_and_coexistence()
    test_script_contract()
    test_deployment_guards()
    test_secret_scan()
    print("odysseia_login_release: ok")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3

import hashlib
import json
import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[2]
ADMIN_SOURCE = Path(
    os.environ.get(
        "ADMIN_PANEL_SOURCE",
        REPO / "deployment/production-patches/2026-07-11-admin-panel-zh-cn/source",
    )
)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    api_bundle = ROOT / "api-patch/api-index.cjs"
    route = ROOT / "api-patch/users.js"
    subprocess.run(["node", "--check", str(api_bundle)], check=True)
    subprocess.run(["node", "--check", str(route)], check=True)

    bundle = api_bundle.read_text(encoding="utf-8")
    route_text = route.read_text(encoding="utf-8")
    server_users = (ADMIN_SOURCE / "src/server/users.ts").read_text(encoding="utf-8")
    dialog = (ADMIN_SOURCE / "src/components/users/CreateUserDialog.tsx").read_text(
        encoding="utf-8"
    )

    for marker in (
        "async function createUserHandler",
        "Object.defineProperties(registrationInput",
        "enumerable: false",
        "A user with that email or username already exists",
        "createUser: createUserHandler",
    ):
        require(marker in bundle, f"API bundle marker missing: {marker}")

    for marker in (
        "requireCapability(SystemCapabilities.MANAGE_USERS)",
        "router.post('/', requireManageUsers, handlers.createUser)",
        "registerUser,",
    ):
        require(marker in route_text, f"admin route marker missing: {marker}")

    require("Not implemented: createUserFn" not in server_users, "Admin Panel create stub remains")
    require("/api/admin/users" in server_users, "Admin Panel create API path missing")
    for marker in ("confirmPassword", "emailVerified", "user-username", "user-password"):
        require(marker in dialog, f"create dialog field missing: {marker}")

    for locale in ("en", "zh-Hans"):
        data = json.loads(
            (ADMIN_SOURCE / f"src/locales/{locale}/translation.json").read_text(encoding="utf-8")
        )
        for key in (
            "com_toast_user_created",
            "com_users_username_label",
            "com_users_password_label",
            "com_users_password_mismatch",
            "com_users_email_verified_label",
        ):
            require(data.get(key), f"{locale} locale missing: {key}")

    baseline = (ROOT / "BASELINE_SHA256").read_text(encoding="utf-8")
    require("2eff0d333af8f058455932a0d077f732d48d16175ebed32cf7ed79193f19dd2d" in baseline,
            "API baseline hash missing")
    require("69c8e49b22a188fc222c21aaa927a4e05946afe8e08c4b1d4428cc35966cd469" in baseline,
            "route baseline hash missing")
    require(sha256(api_bundle) != "2eff0d333af8f058455932a0d077f732d48d16175ebed32cf7ed79193f19dd2d",
            "API bundle was not modified")
    require(sha256(route) != "69c8e49b22a188fc222c21aaa927a4e05946afe8e08c4b1d4428cc35966cd469",
            "admin users route was not modified")
    print("admin_user_creation_release: ok")


if __name__ == "__main__":
    main()

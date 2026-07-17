#!/usr/bin/env python3

import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADMIN_SOURCE = Path(os.environ.get("ADMIN_PANEL_SOURCE", ROOT / "admin-panel-source"))


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    users_route = (ADMIN_SOURCE / "src/routes/_app/users.tsx").read_text(encoding="utf-8")
    sidebar = (ADMIN_SOURCE / "src/components/Sidebar.tsx").read_text(encoding="utf-8")
    dialog = (ADMIN_SOURCE / "src/components/users/CreateUserDialog.tsx").read_text(
        encoding="utf-8"
    )
    users_page = (ADMIN_SOURCE / "src/components/users/UsersPage.tsx").read_text(
        encoding="utf-8"
    )
    server_users = (ADMIN_SOURCE / "src/server/users.ts").read_text(encoding="utf-8")
    require("component: UsersRoute" in users_route, "users route is not active")
    require("SystemCapabilities.READ_USERS" in users_route, "READ_USERS guard missing")
    require("redirect({ to: '/' })" not in users_route, "users route redirects home")
    require("path: '/users'" in sidebar, "users sidebar item missing")
    require("TODO: re-enable once user management is ready" not in sidebar,
            "users sidebar item is still disabled")
    require("createUserFn" in dialog, "create user form is not wired")
    require("admin-user-ui-activation" in users_page, "release marker missing")
    require("Not implemented: createUserFn" not in server_users, "create user stub remains")
    require("/api/admin/users" in server_users, "create user API path missing")
    for marker in ("confirmPassword", "emailVerified", "user-username", "user-password"):
        require(marker in dialog, f"create dialog field missing: {marker}")
    for locale in ("en", "zh-Hans"):
        data = json.loads(
            (ADMIN_SOURCE / f"src/locales/{locale}/translation.json").read_text(
                encoding="utf-8"
            )
        )
        for key in (
            "com_toast_user_created",
            "com_users_username_label",
            "com_users_password_label",
            "com_users_password_mismatch",
        ):
            require(data.get(key), f"{locale} locale missing: {key}")
    print("admin_user_ui_activation_release: ok")


if __name__ == "__main__":
    main()

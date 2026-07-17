#!/usr/bin/env python3

import os
from pathlib import Path
import subprocess


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
    subprocess.run(
        [
            "python3",
            str(ROOT.parents[0] / "2026-07-17-admin-user-creation/scripts/test-release.py"),
        ],
        check=True,
        env={**os.environ, "ADMIN_PANEL_SOURCE": str(ADMIN_SOURCE)},
    )
    require("component: UsersRoute" in users_route, "users route is not active")
    require("SystemCapabilities.READ_USERS" in users_route, "READ_USERS guard missing")
    require("redirect({ to: '/' })" not in users_route, "users route redirects home")
    require("path: '/users'" in sidebar, "users sidebar item missing")
    require("TODO: re-enable once user management is ready" not in sidebar,
            "users sidebar item is still disabled")
    require("createUserFn" in dialog, "create user form is not wired")
    require("admin-user-ui-activation" in users_page, "release marker missing")
    print("admin_user_ui_activation_release: ok")


if __name__ == "__main__":
    main()

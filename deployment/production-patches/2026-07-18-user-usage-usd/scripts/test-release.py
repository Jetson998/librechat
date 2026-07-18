#!/usr/bin/env python3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def main() -> None:
    deploy = (ROOT / "scripts/deploy.sh").read_text(encoding="utf-8")

    require('"USER_USAGE_CURRENCY": "USD"' in deploy, "USD runtime currency missing")
    require('"USER_USAGE_USD_RATE": "1"' in deploy, "USD runtime rate missing")
    require("force-recreate api" in deploy, "API reload missing")
    require("force-recreate admin-panel" not in deploy, "Admin Panel must not restart")
    print("user_usage_usd_release: ok")


if __name__ == "__main__":
    main()

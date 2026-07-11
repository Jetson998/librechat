#!/usr/bin/env python3

from pathlib import Path
import re
import sys

import yaml


ROOT = Path(__file__).resolve().parents[1]
ADMIN_HOST = "admin.152.32.172.162.sslip.io"
ADMIN_IMAGE = (
    "registry.librechat.ai/clickhouse/librechat-admin-panel@"
    "sha256:1d3916ae84439e83da83507afd4aae14a99bd81ff2e1890079f57d8d377eb8e9"
)


class StrictLoader(yaml.SafeLoader):
    pass


def construct_mapping(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise AssertionError(f"duplicate YAML key: {key}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


StrictLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    construct_mapping,
)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def load_yaml(path):
    return yaml.load(read(path), Loader=StrictLoader)


def environment_map(values):
    result = {}
    for item in values:
        key, value = item.split("=", 1)
        result[key] = value
    return result


def main():
    config = load_yaml("librechat.yaml")
    specs = config["modelSpecs"]["list"]
    by_name = {item["name"]: item for item in specs}
    require(list(by_name) == ["gpt-5.6-sol", "claude-fable-5"], "unexpected model specs")
    require(
        [item["name"] for item in specs if item.get("default") is True]
        == ["gpt-5.6-sol"],
        "GPT must be the sole default",
    )
    require(by_name["gpt-5.6-sol"].get("iconURL") == "/assets/openai.svg", "GPT icon missing")
    require(
        by_name["gpt-5.6-sol"]["preset"].get("modelLabel") == "GPT-5.6-SOL",
        "GPT message sender label missing",
    )
    require(by_name["claude-fable-5"].get("default") is False, "Fable must remain non-default")

    compose = load_yaml("compose.override.yaml")
    services = compose["services"]
    admin = services["admin-panel"]
    require(admin["image"] == ADMIN_IMAGE, "Admin Panel image is not pinned to the approved digest")
    require("ports" not in admin, "Admin Panel must not publish a host port")
    require(admin["restart"] == "always", "Admin Panel restart policy changed")
    require(admin["depends_on"] == ["api"], "Admin Panel dependency changed")
    env = environment_map(admin["environment"])
    require(env["PORT"] == "3000", "unexpected Admin Panel port")
    require(env["SESSION_SECRET"] == "${ADMIN_PANEL_SESSION_SECRET}", "session secret must stay in env")
    require(env["API_SERVER_URL"] == "http://api:3080", "Admin Panel API URL changed")
    require(env["SESSION_COOKIE_SECURE"] == "true", "secure session cookie is required")
    require("152.32.172.162.sslip.io" in env["VITE_API_BASE_URL"], "public LibreChat API URL changed")
    require(services["client"]["depends_on"] == ["api", "admin-panel"], "client dependency changed")

    client_nginx = read("client-nginx.conf")
    require(f"server_name {ADMIN_HOST};" in client_nginx, "inner Admin hostname missing")
    require("set $admin_panel_upstream http://admin-panel:3000;" in client_nginx, "inner proxy missing")
    require("resolver 127.0.0.11" in client_nginx, "Docker DNS resolver missing")
    require("listen 80 default_server;" in client_nginx, "main LibreChat server changed")

    host_http = read("host-nginx-http.conf")
    host_https = read("host-nginx.conf")
    require(f"server_name {ADMIN_HOST};" in host_http, "ACME Admin hostname missing")
    require("/.well-known/acme-challenge/" in host_http, "ACME route missing")
    require(f"server_name {ADMIN_HOST};" in host_https, "HTTPS Admin hostname missing")
    require("proxy_pass http://127.0.0.1:3081;" in host_https, "host proxy target changed")
    require(f"/live/{ADMIN_HOST}/fullchain.pem" in host_https, "Admin certificate path missing")

    deploy = read("scripts/deploy-admin-panel.sh")
    for marker in (
        "configs.countDocuments({})",
        "certbot certonly --webroot",
        "docker compose pull admin-panel",
        "docker compose up -d --force-recreate client",
        "Admin hostname is serving the main LibreChat client",
        "PREFLIGHT_ONLY",
        "rollback",
        "LibreChat-CodeAPI",
        "/office/",
    ):
        require(marker in deploy, f"deployment guard missing: {marker}")

    combined = "\n".join(
        read(path)
        for path in (
            "librechat.yaml",
            "compose.override.yaml",
            "client-nginx.conf",
            "host-nginx-http.conf",
            "host-nginx.conf",
            "scripts/deploy-admin-panel.sh",
        )
    )
    secret_patterns = (
        r"github_pat_[A-Za-z0-9_]+",
        r"sk-[A-Za-z0-9_-]{12,}",
        r"SESSION_SECRET=[A-Za-z0-9_-]{16,}",
        r"apiKey:\s*[\"']?(?!\$\{)[A-Za-z0-9_-]{16,}",
    )
    for pattern in secret_patterns:
        require(re.search(pattern, combined, re.IGNORECASE) is None, f"possible committed secret: {pattern}")

    print("admin_panel_release: ok")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"admin_panel_release: failed: {error}", file=sys.stderr)
        raise

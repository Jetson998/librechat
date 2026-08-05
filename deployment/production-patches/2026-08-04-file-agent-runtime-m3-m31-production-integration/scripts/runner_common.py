"""Pure validation and Compose transformation helpers for the dual-service runner."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import tarfile
from pathlib import Path
from urllib.parse import urlparse


API_SERVICE = "api"
RUNTIME_SERVICE = "file-agent-runtime"
CODEAPI_SERVICE = "codeapi"
CONNECTOR_TARGET = "/opt/librechat/file-agent-runtime/connector"
RUNTIME_DATA_VOLUME = "file-agent-runtime-data"
SECRET_NAMES = {
    "service_scope": "file-agent-service-scope",
    "allowlist": "file-agent-allowlist",
    "model_api_key": "file-agent-model-api-key",
}
USER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def normalized_environment(value: object) -> dict[str, str]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return {str(key): "" if item is None else str(item) for key, item in value.items()}
    if isinstance(value, list):
        result: dict[str, str] = {}
        for item in value:
            require(isinstance(item, str) and "=" in item, "unsupported Compose environment entry")
            key, item_value = item.split("=", 1)
            require(key != "", "empty Compose environment name")
            result[key] = item_value
        return result
    raise RuntimeError("unsupported Compose environment representation")


def normalized_dependencies(value: object) -> dict[str, object]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, list):
        return {str(item): {"condition": "service_started"} for item in value}
    raise RuntimeError("unsupported Compose depends_on representation")


def normalized_secret_names(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        result = []
        for item in value:
            if isinstance(item, str):
                result.append(item)
            elif isinstance(item, dict) and isinstance(item.get("source"), str):
                result.append(item["source"])
            else:
                raise RuntimeError("unsupported Compose secret entry")
        return result
    if isinstance(value, dict):
        return list(value.keys())
    raise RuntimeError("unsupported Compose secrets representation")


def compose_target(entry: object) -> str:
    if isinstance(entry, dict):
        return str(entry.get("target", ""))
    if isinstance(entry, str):
        parts = entry.rsplit(":", 2)
        return parts[-2] if len(parts) >= 2 else ""
    return ""


def add_unique(items: list[str], value: str) -> None:
    if value not in items:
        items.append(value)


def validate_handoff(handoff: dict, stage: Path) -> dict:
    require(handoff.get("schema_version") == 1, "unsupported dual-service handoff schema")
    require(handoff.get("status") == "packaged_for_deployment", "handoff is not deployable")
    source_revision = handoff.get("source_revision")
    require(isinstance(source_revision, str) and re.fullmatch(r"[0-9a-f]{40}", source_revision), "invalid source revision")
    require(isinstance(handoff.get("artifact_sha256"), str) and re.fullmatch(r"[0-9a-f]{64}", handoff["artifact_sha256"]), "invalid artifact digest")
    require(isinstance(handoff.get("release_plan_sha256"), str) and re.fullmatch(r"[0-9a-f]{64}", handoff["release_plan_sha256"]), "invalid release plan digest")

    deployment = handoff.get("deployment")
    require(isinstance(deployment, dict), "deployment inputs are missing")
    require(deployment.get("enable_runtime") is True, "production handoff must explicitly enable Runtime")
    image = deployment.get("runtime_image")
    require(isinstance(image, str) and "@sha256:" in image, "Runtime image must be pinned by digest")
    image_digest = image.rsplit("@sha256:", 1)[-1]
    require(bool(re.fullmatch(r"[0-9a-f]{64}", image_digest)), "Runtime image digest is invalid")

    model_base_url = deployment.get("model_base_url")
    parsed = urlparse(model_base_url) if isinstance(model_base_url, str) else None
    require(
        parsed is not None
        and parsed.scheme in {"http", "https"}
        and bool(parsed.hostname)
        and parsed.username is None
        and parsed.password is None,
        "model_base_url must be an authenticated-free HTTP(S) URL",
    )
    model = deployment.get("model")
    require(isinstance(model, str) and model.strip() != "", "model is required")

    secret_host_files = deployment.get("secret_host_files")
    require(isinstance(secret_host_files, dict), "secret host files are missing")
    for key in SECRET_NAMES:
        value = secret_host_files.get(key)
        require(isinstance(value, str) and Path(value).is_absolute(), f"absolute secret host file is required: {key}")
        secret_path = Path(value)
        require(secret_path.is_file() and secret_path.stat().st_size > 0, f"secret host file is missing: {key}")
        require(secret_path.is_symlink() is False, f"secret host file must not be a symlink: {key}")
    allowlist = Path(secret_host_files["allowlist"])
    ids = [line.strip() for line in allowlist.read_text(encoding="utf-8").splitlines()]
    ids = [line for line in ids if line and not line.startswith("#")]
    require(ids and all(USER_ID.fullmatch(value) for value in ids), "allowlist contains no valid user IDs")

    connector_archive = handoff.get("connector_archive")
    require(isinstance(connector_archive, dict), "Connector archive metadata is missing")
    filename = connector_archive.get("filename")
    require(isinstance(filename, str) and Path(filename).name == filename, "invalid Connector archive filename")
    archive = stage / filename
    require(archive.is_file(), "Connector archive is missing")
    require(sha256(archive) == connector_archive.get("sha256"), "Connector archive digest mismatch")
    require(isinstance(connector_archive.get("files"), list) and connector_archive["files"], "Connector archive file manifest is missing")
    return deployment


def safe_extract_connector(archive_path: Path, destination: Path, files: list[dict]) -> None:
    expected = {}
    for item in files:
        relative = Path(item.get("path", ""))
        require(not relative.is_absolute() and ".." not in relative.parts and str(relative) != ".", "unsafe Connector archive path")
        require(str(relative) not in expected, f"duplicate Connector archive path: {relative}")
        expected[str(relative)] = item

    destination = destination.resolve()
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        require({member.name for member in members} == set(expected), "Connector archive file set mismatch")
        for member in members:
            require(member.isfile() and not member.issym() and not member.islnk(), f"unsafe Connector archive member: {member.name}")
            target = (destination / member.name).resolve()
            try:
                target.relative_to(destination)
            except ValueError as error:
                raise RuntimeError(f"Connector archive path escapes release directory: {member.name}") from error
            stream = archive.extractfile(member)
            require(stream is not None, f"cannot read Connector archive member: {member.name}")
            payload = stream.read()
            item = expected[member.name]
            require(len(payload) == item.get("bytes"), f"Connector archive byte count mismatch: {member.name}")
            require(hashlib.sha256(payload).hexdigest() == item.get("sha256"), f"Connector archive digest mismatch: {member.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
            target.chmod(0o444)


NATIVE_FALLBACK_PROBE = r'''
const { pathToFileURL } = require('node:url');

(async () => {
  const connectorRoot = '/opt/librechat/file-agent-runtime/connector';
  const { resolveOfficeTaskIntent } = await import(
    pathToFileURL(`${connectorRoot}/src/office-task-intent.js`).href
  );
  const { createProductionOfficePreflight } = await import(
    pathToFileURL(`${connectorRoot}/src/production-host-integration.js`).href
  );
  const baseContext = {
    req: { body: { files: [] } },
    client: { options: { attachments: [] } },
    conversationId: 'native-probe-conversation',
    userMessageId: 'native-probe-message',
    assistantMessageId: 'native-probe-assistant',
    streamId: 'native-probe-stream',
  };
  if (resolveOfficeTaskIntent({ files: [], instruction: 'Hello' }) !== null) {
    throw new Error('ordinary chat was classified as an Office task');
  }
  const preflight = createProductionOfficePreflight({
    allowlistedUserIds: new Set(['native-probe-allowlisted']),
  });
  const ordinary = await preflight({
    ...baseContext,
    userId: 'native-probe-allowlisted',
    text: 'Hello',
  });
  if (ordinary?.route !== 'native' || ordinary.reason !== 'not_complex_file_intent') {
    throw new Error(`ordinary chat did not stay native: ${JSON.stringify(ordinary)}`);
  }
  const unauthorized = await preflight({
    ...baseContext,
    userId: 'native-probe-not-allowlisted',
    text: '根据这个 Excel 生成一页 API 模型来源说明 PPT',
  });
  if (unauthorized?.route !== 'native' || unauthorized.reason !== 'user_not_allowlisted') {
    throw new Error(`unauthorized Office request did not stay native: ${JSON.stringify(unauthorized)}`);
  }
  const before = await fetch('http://file-agent-runtime:8790/healthz').then(async (response) => {
    if (!response.ok) throw new Error('Runtime health probe failed');
    return (await response.json()).runtime_request_count;
  });
  if (before !== 0) throw new Error(`Runtime already received task requests: ${before}`);
  const after = await fetch('http://file-agent-runtime:8790/healthz').then(async (response) => {
    if (!response.ok) throw new Error('Runtime health probe failed');
    return (await response.json()).runtime_request_count;
  });
  if (after !== before) throw new Error(`native fallback probe changed Runtime task count: ${before} -> ${after}`);
})().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
'''


def native_fallback_probe(*, api_container: str, run_command=subprocess.run) -> None:
    result = run_command(
        ["docker", "exec", api_container, "node", "-e", NATIVE_FALLBACK_PROBE],
        check=False,
    )
    require(result.returncode == 0, "native fallback probe failed")


def compose_with_runtime(payload: dict, release_dir: Path, deployment: dict) -> dict:
    services = payload.get("services")
    require(isinstance(services, dict), "Compose services are missing")
    require(isinstance(services.get(API_SERVICE), dict), "API Compose service is missing")
    require(isinstance(services.get(CODEAPI_SERVICE), dict), "CodeAPI Compose service is missing")

    api = services[API_SERVICE]
    api_environment = normalized_environment(api.get("environment"))
    api_environment.update({
        "FILE_AGENT_RUNTIME_ENABLED": "true",
        "FILE_AGENT_CONNECTOR_ROOT": CONNECTOR_TARGET,
        "FILE_AGENT_RUNTIME_BASE_URL": "http://file-agent-runtime:8790",
        "FILE_AGENT_SERVICE_SCOPE_SECRET_FILE": "/run/secrets/file-agent-service-scope",
        "FILE_AGENT_RUNTIME_ALLOWLIST_FILE": "/run/secrets/file-agent-allowlist",
        "FILE_AGENT_RUNTIME_MODEL_ROUTE_ID": "file-agent-primary",
    })
    api["environment"] = api_environment
    api_volumes = list(api.get("volumes", []))
    api_volumes = [entry for entry in api_volumes if compose_target(entry) != CONNECTOR_TARGET]
    api_volumes.append(f"{(release_dir / 'connector').resolve()}:{CONNECTOR_TARGET}:ro")
    api["volumes"] = api_volumes
    api_secrets = normalized_secret_names(api.get("secrets"))
    for secret in (SECRET_NAMES["service_scope"], SECRET_NAMES["allowlist"]):
        add_unique(api_secrets, secret)
    api["secrets"] = api_secrets
    dependencies = normalized_dependencies(api.get("depends_on"))
    dependencies[RUNTIME_SERVICE] = {"condition": "service_healthy"}
    api["depends_on"] = dependencies

    service_scope = "/run/secrets/file-agent-service-scope"
    runtime = {
        "image": deployment["runtime_image"],
        "restart": "unless-stopped",
        "expose": ["8790"],
        "environment": {
            "FILE_AGENT_HOST": "0.0.0.0",
            "FILE_AGENT_PORT": "8790",
            "FILE_AGENT_CODEAPI_BASE_URL": "http://codeapi:8000",
            "FILE_AGENT_SERVICE_SCOPE_SECRET_FILE": service_scope,
            "FILE_AGENT_MODEL_API_KEY_FILE": "/run/secrets/file-agent-model-api-key",
            "FILE_AGENT_MODEL_BASE_URL": deployment["model_base_url"],
            "FILE_AGENT_MODEL": deployment["model"],
            "FILE_AGENT_DATA_DIR": "/var/lib/file-agent-runtime",
            "FILE_AGENT_MAX_CONCURRENT_TASKS": "1",
            "FILE_AGENT_MAX_CONTEXT_CHARS": "12000",
        },
        "secrets": [
            SECRET_NAMES["service_scope"],
            SECRET_NAMES["model_api_key"],
        ],
        "volumes": [f"{RUNTIME_DATA_VOLUME}:/var/lib/file-agent-runtime"],
        "tmpfs": ["/tmp"],
        "security_opt": ["no-new-privileges:true"],
        "cpus": "1.0",
        "mem_limit": "1g",
        "depends_on": {CODEAPI_SERVICE: {"condition": "service_started"}},
        "healthcheck": {
            "test": [
                "CMD",
                "node",
                "-e",
                "fetch('http://127.0.0.1:8790/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))",
            ],
            "interval": "30s",
            "timeout": "5s",
            "start_period": "20s",
            "retries": 3,
        },
    }
    require("ports" not in runtime, "Runtime must not publish a host port")
    services[RUNTIME_SERVICE] = runtime

    top_secrets = payload.setdefault("secrets", {})
    require(isinstance(top_secrets, dict), "Compose top-level secrets must be a mapping")
    host_files = deployment["secret_host_files"]
    for key, secret_name in SECRET_NAMES.items():
        top_secrets[secret_name] = {"file": host_files[key]}
    top_volumes = payload.setdefault("volumes", {})
    require(isinstance(top_volumes, dict), "Compose top-level volumes must be a mapping")
    top_volumes.setdefault(RUNTIME_DATA_VOLUME, {})
    return payload


def validate_runtime_compose(payload: dict, release_dir: Path, deployment: dict) -> None:
    services = payload.get("services", {})
    runtime = services.get(RUNTIME_SERVICE, {})
    api = services.get(API_SERVICE, {})
    require(runtime.get("image") == deployment["runtime_image"], "Runtime image changed during Compose resolution")
    require("ports" not in runtime or runtime.get("ports") in (None, []), "Runtime must not publish host ports")
    require(runtime.get("expose") == ["8790"], "Runtime internal port contract changed")
    require(runtime.get("volumes") == [f"{RUNTIME_DATA_VOLUME}:/var/lib/file-agent-runtime"], "Runtime data volume contract changed")
    require(runtime.get("environment", {}).get("FILE_AGENT_CODEAPI_BASE_URL") == "http://codeapi:8000", "Runtime CodeAPI endpoint changed")
    require(runtime.get("healthcheck", {}).get("test", [None])[0] == "CMD", "Runtime healthcheck is missing")
    require(api.get("environment", {}).get("FILE_AGENT_RUNTIME_ENABLED") == "true", "API Runtime flag is not enabled")
    require(api.get("environment", {}).get("FILE_AGENT_CONNECTOR_ROOT") == CONNECTOR_TARGET, "API Connector root changed")
    expected_mount = f"{(release_dir / 'connector').resolve()}:{CONNECTOR_TARGET}:ro"
    require(expected_mount in api.get("volumes", []), "API Connector source mount is missing")
    require(api.get("depends_on", {}).get(RUNTIME_SERVICE, {}).get("condition") == "service_healthy", "API does not wait for Runtime health")
    require(set(SECRET_NAMES.values()).issubset(set(payload.get("secrets", {}).keys())), "Compose secret contract is incomplete")

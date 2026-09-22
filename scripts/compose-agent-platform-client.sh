#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_DIST="${1:?usage: compose-agent-platform-client.sh BASE_DIST OUTPUT_DIST [MANIFEST]}"
OUTPUT_DIST="${2:?usage: compose-agent-platform-client.sh BASE_DIST OUTPUT_DIST [MANIFEST]}"
MANIFEST="${3:-$ROOT_DIR/integrations/librechat-upstream/8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9/client-overlay-manifest.json}"

python3 - "$ROOT_DIR" "$BASE_DIST" "$OUTPUT_DIST" "$MANIFEST" <<'PY'
from __future__ import annotations

import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import urlsplit


root, base_dist, output_dist, manifest_path = map(Path, sys.argv[1:])
root = root.resolve()
base_dist = base_dist.resolve()
output_dist = output_dist.resolve()
manifest_path = manifest_path.resolve()


def fail(message: str) -> None:
    raise SystemExit(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_repo_path(path: Path) -> None:
    try:
        path.relative_to(root)
    except ValueError as error:
        raise SystemExit(f"asset escapes repository root: {path}") from error


class LocalAssetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.references: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        attribute = "href" if tag == "link" else "src" if tag == "script" else None
        if attribute and values.get(attribute):
            self.references.append(values[attribute] or "")


def verify_local_references(dist: Path, html: str) -> None:
    parser = LocalAssetParser()
    parser.feed(html)
    missing: list[str] = []
    for reference in parser.references:
        parsed = urlsplit(reference)
        if parsed.scheme or parsed.netloc or reference.startswith(("data:", "#")):
            continue
        relative = parsed.path.lstrip("/")
        if relative and not (dist / relative).is_file():
            missing.append(reference)
    if missing:
        fail(f"missing local assets: {', '.join(sorted(set(missing)))}")


if not (base_dist / "index.html").is_file():
    fail(f"missing base Client index: {base_dist / 'index.html'}")
if output_dist.exists():
    fail(f"output directory already exists: {output_dist}")
if not manifest_path.is_file():
    fail(f"missing overlay manifest: {manifest_path}")

manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
if manifest.get("schema_version") != 1:
    fail("unsupported client overlay manifest schema")

base_html = (base_dist / "index.html").read_text(encoding="utf-8")
for marker in manifest.get("base_index_markers", []):
    if marker not in base_html:
        fail(f"base Client is missing built-in recovery marker: {marker}")

assets = manifest.get("assets", [])
assets_by_id = {asset["id"]: asset for asset in assets}
if len(assets_by_id) != len(assets):
    fail("duplicate asset ids in client overlay manifest")

for order_key in ("head_order", "body_order"):
    for asset_id in manifest.get(order_key, []):
        if asset_id not in assets_by_id:
            fail(f"{order_key} references unknown asset: {asset_id}")

validated: dict[str, dict[str, str]] = {}
for asset in assets:
    source = (root / asset["source"]).resolve()
    ensure_repo_path(source)
    if not source.is_file():
        fail(f"missing protected Client asset: {source}")
    actual_sha = sha256(source)
    if actual_sha != asset["sha256"]:
        fail(
            f"protected Client asset hash mismatch: {asset['source']} "
            f"expected={asset['sha256']} actual={actual_sha}"
        )
    body = source.read_text(encoding="utf-8")
    missing_markers = [marker for marker in asset.get("required_markers", []) if marker not in body]
    if missing_markers:
        fail(f"{asset['source']} is missing contract markers: {missing_markers}")
    if asset["kind"] == "script":
        subprocess.run(["node", "--check", str(source)], check=True)
    if asset["injection"] == "inline-body" and re.search(r"</script", body, re.I):
        fail(f"unsafe inline script asset: {asset['source']}")
    if asset["injection"] == "inline-head" and re.search(r"</style", body, re.I):
        fail(f"unsafe inline style asset: {asset['source']}")
    validated[asset["id"]] = {"source": str(source), "sha256": actual_sha, "body": body}

shutil.copytree(base_dist, output_dist, symlinks=True)
index_path = output_dist / "index.html"
html = index_path.read_text(encoding="utf-8")

for asset in assets:
    marker = re.escape(asset["id"])
    patterns = [
        re.compile(
            rf"\s*<script\b[^>]*\bid=[\"']{marker}[\"'][^>]*>.*?</script>",
            re.I | re.S,
        ),
        re.compile(
            rf"\s*<style\b[^>]*\bid=[\"']{marker}[\"'][^>]*>.*?</style>",
            re.I | re.S,
        ),
        re.compile(rf"\s*<link\b[^>]*\bid=[\"']{marker}[\"'][^>]*>", re.I),
    ]
    for pattern in patterns:
        html = pattern.sub("", html)

    output = asset["output"]
    stem = re.escape(Path(output).stem)
    suffix = re.escape(Path(output).suffix)
    if asset["kind"] == "script":
        html = re.sub(
            rf"\s*<script\b[^>]*\bsrc=[\"']/({stem})(?:-[A-Za-z0-9]+)?{suffix}(?:\?[^\"']*)?[\"'][^>]*>.*?</script>",
            "",
            html,
            flags=re.I | re.S,
        )
    elif asset["kind"] == "style":
        html = re.sub(
            rf"\s*<link\b[^>]*\bhref=[\"']/({stem})(?:-[A-Za-z0-9]+)?{suffix}(?:\?[^\"']*)?[\"'][^>]*>",
            "",
            html,
            flags=re.I,
        )

    destination = output_dist / output
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(validated[asset["id"]]["source"], destination)
    if sha256(destination) != asset["sha256"]:
        fail(f"copied asset hash mismatch: {output}")

    output_path = Path(output)
    for stale in output_dist.glob(f"{output_path.stem}-*{output_path.suffix}"):
        if stale.name != output_path.name:
            stale.unlink()


def render(asset_id: str) -> str:
    asset = assets_by_id[asset_id]
    body = validated[asset_id]["body"]
    version = asset["sha256"][:12]
    url = f"/{asset['output']}?v={version}"
    mode = asset["injection"]
    if mode == "external-head":
        return f'<link id="{asset_id}" rel="stylesheet" href="{url}" />'
    if mode == "external-body":
        return f'<script id="{asset_id}" src="{url}"></script>'
    if mode == "inline-head":
        return f'<style id="{asset_id}" data-asset="{url}">\n{body}\n</style>'
    if mode == "inline-body":
        return f'<script id="{asset_id}" data-asset="{url}">\n{body}\n</script>'
    fail(f"asset cannot be rendered: {asset_id} mode={mode}")


head_tags = "\n    ".join(render(asset_id) for asset_id in manifest["head_order"])
body_tags = "\n    ".join(render(asset_id) for asset_id in manifest["body_order"])
if html.lower().count("</head>") != 1 or html.lower().count("</body>") != 1:
    fail("base Client index must contain exactly one closing head and body tag")
html = re.sub(
    r"</head>",
    lambda _match: f"    {head_tags}\n  </head>",
    html,
    count=1,
    flags=re.I,
)
html = re.sub(
    r"</body>",
    lambda _match: f"    {body_tags}\n  </body>",
    html,
    count=1,
    flags=re.I,
)

for asset_id in manifest["head_order"] + manifest["body_order"]:
    marker_count = len(re.findall(rf'id=[\"\']{re.escape(asset_id)}[\"\']', html))
    if marker_count != 1:
        fail(f"unexpected marker count for {asset_id}: {marker_count}")

positions = [html.index(f'id="{asset_id}"') for asset_id in manifest["head_order"]]
if positions != sorted(positions):
    fail("protected head asset order drifted")
positions = [html.index(f'id="{asset_id}"') for asset_id in manifest["body_order"]]
if positions != sorted(positions):
    fail("protected body asset order drifted")

for marker in manifest.get("base_index_markers", []):
    if marker not in html:
        fail(f"composed Client lost built-in recovery marker: {marker}")

index_path.write_text(html, encoding="utf-8")
verify_local_references(output_dist, html)

result = {
    "schema_version": 1,
    "overlay_id": manifest["overlay_id"],
    "upstream_commit": manifest["upstream_commit"],
    "base_index_sha256": sha256(base_dist / "index.html"),
    "composed_index_sha256": sha256(index_path),
    "assets": [
        {
            "id": asset["id"],
            "output": asset["output"],
            "sha256": asset["sha256"],
            "injection": asset["injection"],
        }
        for asset in assets
    ],
}
(output_dist / "agent-platform-client-overlay.json").write_text(
    json.dumps(result, ensure_ascii=True, indent=2) + "\n",
    encoding="utf-8",
)

print(f"overlay_id={manifest['overlay_id']}")
print(f"base_index_sha256={result['base_index_sha256']}")
print(f"composed_index_sha256={result['composed_index_sha256']}")
print(f"protected_assets={len(assets)}")
print("client_overlay_check=passed")
PY

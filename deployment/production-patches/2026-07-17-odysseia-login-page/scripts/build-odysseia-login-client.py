#!/usr/bin/env python3

import argparse
import hashlib
from html.parser import HTMLParser
from pathlib import Path
import re
import shutil
import tempfile
from urllib.parse import urlsplit


PATCH_ID = "odysseia-login-page-patch"
PATCH_FILE = "odysseia-login.js"
PATCH_TAG = f'<script id="{PATCH_ID}" src="/{PATCH_FILE}"></script>'
SCRIPT_PATTERN = re.compile(
    rf"\s*<script\b[^>]*\bid=[\"']{re.escape(PATCH_ID)}[\"'][^>]*>.*?</script>",
    re.IGNORECASE | re.DOTALL,
)


class LocalAssetParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.references = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        attribute = "href" if tag == "link" else "src" if tag == "script" else None
        if attribute and values.get(attribute):
            self.references.append(values[attribute])


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write(path, content):
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    temporary.replace(path)


def local_asset_path(dist, reference):
    parsed = urlsplit(reference)
    if parsed.scheme or parsed.netloc or reference.startswith(("data:", "#")):
        return None
    path = parsed.path.lstrip("./")
    if path.startswith("/"):
        path = path[1:]
    if not path:
        return None
    return dist / path


def verify_assets(dist, html):
    parser = LocalAssetParser()
    parser.feed(html)
    missing = []
    for reference in parser.references:
        path = local_asset_path(dist, reference)
        if path is not None and not path.is_file():
            missing.append(reference)
    if missing:
        raise RuntimeError(f"missing local assets: {', '.join(sorted(set(missing)))}")


def build(dist, source):
    index = dist / "index.html"
    if not index.is_file():
        raise RuntimeError(f"missing frontend index: {index}")
    if not source.is_file():
        raise RuntimeError(f"missing patch source: {source}")

    html = index.read_text(encoding="utf-8")
    html = SCRIPT_PATTERN.sub("", html)
    if html.lower().count("</body>") != 1:
        raise RuntimeError("frontend index must contain exactly one closing body tag")
    html = re.sub(r"</body>", f"    {PATCH_TAG}\n  </body>", html, count=1, flags=re.I)
    if html.count(PATCH_ID) != 1:
        raise RuntimeError("odysseia patch marker must occur exactly once")

    shutil.copyfile(source, dist / PATCH_FILE)
    atomic_write(index, html)
    verify_assets(dist, html)

    required = (
        "Odýsseia Studio",
        "Start your Agent Studio.",
        "font-weight: 400",
        "https://image01.vidu.zone/vidu/landing-page/login-bg.c7293340.mp4",
        "__odysseiaLoginPatchInstalled",
    )
    script = (dist / PATCH_FILE).read_text(encoding="utf-8")
    missing = [value for value in required if value not in script]
    if missing:
        raise RuntimeError(f"patch source is missing required contract values: {missing}")

    print(f"index_sha256={sha256(index)}")
    print(f"script_sha256={sha256(dist / PATCH_FILE)}")
    print(f"patch_marker_count={html.count(PATCH_ID)}")


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", type=Path, required=True)
    parser.add_argument(
        "--source",
        type=Path,
        default=root / "client" / PATCH_FILE,
    )
    args = parser.parse_args()
    build(args.dist.resolve(), args.source.resolve())


if __name__ == "__main__":
    main()

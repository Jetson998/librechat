#!/usr/bin/env python3
from __future__ import annotations

import pathlib
import re
import sys


STYLE_MARKER = 'id="context-safety-stage-b-style"'
SCRIPT_MARKER = 'id="context-safety-stage-b"'


def read_asset(path: pathlib.Path, kind: str) -> str:
    body = path.read_text(encoding="utf-8")
    if re.search(rf"</{kind}", body, flags=re.IGNORECASE):
        raise SystemExit(f"unsafe inline {kind} asset: {path}")
    return body


def inline_style(asset_name: str, body: str) -> str:
    return (
        f'<style id="context-safety-stage-b-style" data-asset="/{asset_name}">\n'
        f'{body}\n'
        '</style>'
    )


def inline_script(asset_name: str, body: str) -> str:
    return (
        f'<script id="context-safety-stage-b" data-asset="/{asset_name}">\n'
        f'{body}\n'
        '</script>'
    )


def replace_one(text: str, pattern: re.Pattern[str], replacement: str, label: str) -> str:
    text, count = pattern.subn(lambda _: replacement, text, count=1)
    if count != 1:
        raise SystemExit(f"unexpected {label} marker count: {count}")
    return text


def update_index(
    path: pathlib.Path,
    style_asset: str,
    script_asset: str,
    style_body: str,
    script_body: str,
) -> None:
    text = path.read_text(encoding="utf-8")
    style = inline_style(style_asset, style_body)
    script = inline_script(script_asset, script_body)
    style_pattern = re.compile(
        r'<link\s+id="context-safety-stage-b-style"[^>]*>'
        r'|<style\s+id="context-safety-stage-b-style"[^>]*>.*?</style>',
        flags=re.IGNORECASE | re.DOTALL,
    )
    script_pattern = re.compile(
        r'<script\s+id="context-safety-stage-b"[^>]*>.*?</script>',
        flags=re.IGNORECASE | re.DOTALL,
    )
    style_count = len(style_pattern.findall(text))
    script_count = len(script_pattern.findall(text))

    if style_count == 0 and script_count == 0:
        if text.count("</head>") != 1 or text.count("</body>") != 1:
            raise SystemExit("unexpected index.html structure")
        text = text.replace("</head>", f"{style}</head>", 1)
        text = text.replace("</body>", f"{script}</body>", 1)
    elif style_count == 1 and script_count == 1:
        text = replace_one(text, style_pattern, style, "style")
        text = replace_one(text, script_pattern, script, "script")
    else:
        raise SystemExit(
            f"mismatched Stage B markers: style={style_count} script={script_count}"
        )

    path.write_text(text, encoding="utf-8")


def update_fixture(
    path: pathlib.Path,
    style_asset: str,
    script_asset: str,
    style_body: str,
    script_body: str,
) -> None:
    text = path.read_text(encoding="utf-8")
    style = inline_style(style_asset, style_body)
    script = inline_script(script_asset, script_body)
    style_pattern = re.compile(
        r'<link\b[^>]*href="/context-safety-ui(?:-[A-Za-z0-9]+)?\.css(?:\?[^" ]*)?"[^>]*>'
        r'|<style\s+id="context-safety-stage-b-style"[^>]*>.*?</style>',
        flags=re.IGNORECASE | re.DOTALL,
    )
    script_pattern = re.compile(
        r'<script\b[^>]*(?:id="context-safety-stage-b"|src="/context-safety-ui(?:-[A-Za-z0-9]+)?\.js(?:\?[^" ]*)?")[^>]*>.*?</script>',
        flags=re.IGNORECASE | re.DOTALL,
    )
    text = replace_one(text, style_pattern, style, "fixture style")
    text = replace_one(text, script_pattern, script, "fixture script")
    path.write_text(text, encoding="utf-8")


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit(
            "usage: build-client.py INDEX FIXTURE STYLE_ASSET SCRIPT_ASSET"
        )
    index_path = pathlib.Path(sys.argv[1])
    fixture_path = pathlib.Path(sys.argv[2])
    style_asset = sys.argv[3]
    script_asset = sys.argv[4]
    style_body = read_asset(index_path.parent / style_asset, "style")
    script_body = read_asset(index_path.parent / script_asset, "script")
    update_index(index_path, style_asset, script_asset, style_body, script_body)
    update_fixture(fixture_path, style_asset, script_asset, style_body, script_body)


if __name__ == "__main__":
    main()

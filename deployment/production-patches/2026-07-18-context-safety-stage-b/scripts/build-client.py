#!/usr/bin/env python3
from __future__ import annotations

import pathlib
import re
import sys


STYLE_MARKER = 'id="context-safety-stage-b-style"'
SCRIPT_MARKER = 'id="context-safety-stage-b"'


def update_index(path: pathlib.Path, style_asset: str, script_asset: str) -> None:
    text = path.read_text(encoding="utf-8")
    style = (
        f'<link id="context-safety-stage-b-style" rel="stylesheet" '
        f'href="/{style_asset}">'
    )
    script = (
        f'<script id="context-safety-stage-b" defer '
        f'src="/{script_asset}"></script>'
    )
    style_count = text.count(STYLE_MARKER)
    script_count = text.count(SCRIPT_MARKER)

    if style_count == 0 and script_count == 0:
        if text.count("</head>") != 1 or text.count("</body>") != 1:
            raise SystemExit("unexpected index.html structure")
        text = text.replace("</head>", f"{style}</head>", 1)
        text = text.replace("</body>", f"{script}</body>", 1)
    elif style_count == 1 and script_count == 1:
        text, css_count = re.subn(
            r'(<link id="context-safety-stage-b-style"[^>]*href=")[^"]+("[^>]*>)',
            rf'\1/{style_asset}\2',
            text,
        )
        text, js_count = re.subn(
            r'(<script id="context-safety-stage-b"[^>]*src=")[^"]+("[^>]*>)',
            rf'\1/{script_asset}\2',
            text,
        )
        if css_count != 1 or js_count != 1:
            raise SystemExit(
                f"unexpected Stage B references: css={css_count} js={js_count}"
            )
    else:
        raise SystemExit(
            f"mismatched Stage B markers: style={style_count} script={script_count}"
        )

    path.write_text(text, encoding="utf-8")


def update_fixture(path: pathlib.Path, style_asset: str, script_asset: str) -> None:
    text = path.read_text(encoding="utf-8")
    text, css_count = re.subn(
        r'/context-safety-ui(?:-[A-Za-z0-9]+)?\.css(?:\?v=[^"\']+)?',
        f'/{style_asset}',
        text,
    )
    text, js_count = re.subn(
        r'/context-safety-ui(?:-[A-Za-z0-9]+)?\.js(?:\?v=[^"\']+)?',
        f'/{script_asset}',
        text,
    )
    if css_count != 1 or js_count != 1:
        raise SystemExit(
            f"unexpected smoke references: css={css_count} js={js_count}"
        )
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
    update_index(index_path, style_asset, script_asset)
    update_fixture(fixture_path, style_asset, script_asset)


if __name__ == "__main__":
    main()

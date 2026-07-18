#!/usr/bin/env python3
from __future__ import annotations

import pathlib
import re
import sys


MARKER = 'id="search-favicon-fallback"'


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: build-client.py INDEX SCRIPT_ASSET")
    index_path = pathlib.Path(sys.argv[1])
    script_asset = sys.argv[2]
    script_path = index_path.parent / script_asset
    text = index_path.read_text(encoding="utf-8")
    body = script_path.read_text(encoding="utf-8")
    if re.search(r"</script", body, flags=re.IGNORECASE):
        raise SystemExit(f"unsafe inline script asset: {script_path}")
    tag = (
        f'<script id="search-favicon-fallback" data-asset="/{script_asset}">\n'
        f'{body}\n'
        '</script>'
    )
    pattern = re.compile(
        r'<script\s+id="search-favicon-fallback"[^>]*>.*?</script>',
        flags=re.IGNORECASE | re.DOTALL,
    )
    count = len(pattern.findall(text))
    if count == 0:
        if text.count("</body>") != 1:
            raise SystemExit("unexpected index.html structure")
        text = text.replace("</body>", f"{tag}</body>", 1)
    elif count == 1:
        text, replaced = pattern.subn(lambda _: tag, text, count=1)
        if replaced != 1:
            raise SystemExit(f"unexpected fallback marker count: {replaced}")
    else:
        raise SystemExit(f"duplicate fallback markers: {count}")
    index_path.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()

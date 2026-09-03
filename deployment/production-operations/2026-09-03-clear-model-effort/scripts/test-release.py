from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
SCRIPT = ROOT / 'deployment/production-operations/2026-09-03-clear-model-effort/scripts/mongo-config.js'


def main() -> None:
    text = SCRIPT.read_text(encoding='utf-8')
    assert "'claude-opus-5'" in text
    assert "delete spec.preset.effort" in text
    assert "delete spec.preset.reasoning_effort" in text
    assert 'codexConfigBackups.insertOne' in text
    assert 'configVersion' in text
    assert "TARGET_MODELS = [" in text
    subprocess.run(['node', '--check', str(SCRIPT)], check=True)
    print(json.dumps({'status': 'passed', 'checks': 6}))


if __name__ == '__main__':
    main()

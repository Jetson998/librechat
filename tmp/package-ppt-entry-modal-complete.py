from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone


repo = Path(__file__).resolve().parents[1]
release_id = '20260922-ppt-entry-modal-client-candidate'
archive_name = 'ppt-entry-modal-client-candidate-20260922.tar.gz'
snapshot = Path(tempfile.mkdtemp(prefix=release_id + '-', dir='/private/tmp'))

source_files = [
    'client/package.json',
    'client/tsconfig.json',
    'client/ppt-entry/index.html',
    'client/ppt-entry/main.tsx',
    'client/src/ppt-entry/routing.ts',
    'client/src/ppt-entry/__tests__/routing.spec.ts',
    'client/vite.ppt-entry.config.ts',
    'client/scripts/validate-ppt-entry-build.mjs',
    'client/src/routes/PptMaterialsHome.tsx',
    'client/src/routes/PptMaterialsHome.css',
    'client/src/routes/__tests__/PptMaterialsHome.spec.tsx',
    'client/src/hooks/AuthContext.tsx',
    'client/src/hooks/__tests__/AuthContext.spec.tsx',
    'client/src/components/Auth/TwoFactorScreen.tsx',
    'client/src/components/Auth/__tests__/Login.spec.tsx',
    'client/src/components/Auth/__tests__/LoginForm.spec.tsx',
    'client/src/components/Auth/__tests__/Registration.spec.tsx',
    'client/src/routes/__tests__/StartupLayout.spec.tsx',
    'client/src/routes/__tests__/useAuthRedirect.spec.tsx',
    'client/src/utils/__tests__/redirect.test.ts',
    'PPT_ENTRY_MODAL_HANDOFF.md',
    'PPT_ENTRY_MODAL_ACCEPTANCE.md',
    'PPT_ENTRY_MODAL_NGINX.conf.example',
]
source_files += sorted(
    str(p.relative_to(repo)) for p in (repo / 'client/src/assets/ppt-materials').glob('*.jpg')
)

for rel in source_files:
    target = snapshot / 'source' / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(repo / rel, target)

shutil.copytree(repo / 'client/dist', snapshot / 'librechat-client' / 'dist')
shutil.copytree(repo / 'client/dist-ppt-entry', snapshot / 'ppt-entry' / 'dist-ppt-entry')

candidate_revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
overlay_revision = '5daeb14ca495d97acb5c069c055ec6ebbc4923b3'
production_client_baseline = '8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9'
created_utc = datetime.now(timezone.utc).isoformat()

(snapshot / 'BUILD_REVISION.json').write_text(
    json.dumps(
        {
            'release_id': release_id,
            'candidate_revision': candidate_revision,
            'candidate_base': candidate_revision,
            'production_client_baseline_observed': production_client_baseline,
            'preserved_overlay_revision': overlay_revision,
            'built_artifacts': {
                'original_librechat_client': 'librechat-client/dist',
                'ppt_static_entry': 'ppt-entry/dist-ppt-entry',
            },
            'entry_origin': 'https://ppt.152.32.172.162.sslip.io',
            'authentication_origin': 'https://152.32.172.162.sslip.io',
            'post_login_url': 'https://152.32.172.162.sslip.io/c/new',
            'production_contacted': False,
            'production_deployed': False,
            'created_utc': created_utc,
        },
        ensure_ascii=False,
        indent=2,
    )
    + '\n'
)

(snapshot / 'LOCAL_VALIDATION.txt').write_text(
    '''Local validation, 2026-09-22
- TypeScript typecheck: PASS.
- PPT routing and modal tests: PASS (13 tests for strict message validation and modal routing).
- Authentication, login, registration, startup and redirect regressions: PASS (87 tests).
- PPT independent production build: PASS.
- Complete LibreChat Client production build: PASS.
- git diff --check: PASS.
- Complete client artifact and independent PPT artifact are both included.
- Completion message requires the original origin, the exact iframe source, fixed type, and a live iframe.
- Wrong origin, wrong source, null source and missing iframe are rejected.
- No production connection, deployment, restart, push, or real-account acceptance performed.
'''
)

paths = sorted(p for p in snapshot.rglob('*') if p.is_file())
manifest = {
    str(p.relative_to(snapshot)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths
}
(snapshot / 'MANIFEST.sha256').write_text(
    ''.join(f'{digest}  {path}\n' for path, digest in manifest.items())
)

archive = repo / archive_name
with tarfile.open(archive, 'w:gz') as tf:
    for p in sorted(snapshot.rglob('*')):
        if p.is_file():
            tf.add(p, arcname=f'{release_id}/{p.relative_to(snapshot)}')

with tarfile.open(archive, 'r:gz') as tf:
    names = {m.name[len(release_id) + 1:] for m in tf.getmembers() if m.isfile()}
    expected = set(manifest) | {'MANIFEST.sha256'}
    assert names == expected, (names ^ expected)
    for rel, digest in manifest.items():
        data = tf.extractfile(f'{release_id}/{rel}').read()
        assert hashlib.sha256(data).hexdigest() == digest, rel

archive_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
(repo / f'{archive_name}.sha256').write_text(f'{archive_sha}  {archive.name}\n')

record = {
    'release_id': release_id,
    'archive': str(archive),
    'sha256': archive_sha,
    'candidate_revision': candidate_revision,
    'production_client_baseline_observed': production_client_baseline,
    'files': len(manifest) + 1,
    'archive_bytes': archive.stat().st_size,
    'created_utc': created_utc,
    'verified_manifest': True,
    'artifacts': {
        'original_librechat_client': 'librechat-client/dist',
        'ppt_static_entry': 'ppt-entry/dist-ppt-entry',
    },
    'deployment_status': 'not deployed',
}
(repo / f'{release_id}.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(record, ensure_ascii=False, indent=2))

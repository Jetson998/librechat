import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const overlayRoot = path.join(directory, '../production-overlay');

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

test('production API overlay manifest replays the exact captured baseline and result files', async () => {
  const manifest = JSON.parse(await readFile(path.join(overlayRoot, 'SOURCE_MANIFEST.json'), 'utf8'));
  assert.equal(manifest.schema_version, 1);
  for (const entry of manifest.captured_production_api.files) {
    const baselinePath = path.join(overlayRoot, entry.baseline);
    const overlayPath = path.join(overlayRoot, entry.overlay);
    assert.equal(await sha256(baselinePath), entry.baseline_sha256, entry.path);
    assert.equal((await stat(baselinePath)).size, entry.baseline_bytes, entry.path);
    assert.equal(await sha256(overlayPath), entry.overlay_sha256, entry.path);
    assert.equal((await stat(overlayPath)).size, entry.overlay_bytes, entry.path);
  }
  const added = manifest.new_api_file;
  const addedPath = path.join(overlayRoot, added.source);
  assert.equal(await sha256(addedPath), added.sha256, added.path);
  assert.equal((await stat(addedPath)).size, added.bytes, added.path);
});

test('production API overlay retains current Office recovery and native fallback boundaries', async () => {
  const request = await readFile(
    path.join(overlayRoot, 'api/overlay/api/server/controllers/agents/request.js'),
    'utf8',
  );
  const index = await readFile(path.join(overlayRoot, 'api/overlay/api/server/index.js'), 'utf8');
  const route = await readFile(path.join(overlayRoot, 'api/overlay/api/server/routes/agents/chat.js'), 'utf8');

  assert.match(request, /req\.officePreparseSignal = job\.abortController\.signal/);
  assert.match(request, /delete req\.officePreparseSignal/);
  assert.match(request, /persistInitializationFailure\(\{/);
  assert.match(request, /fileAgentRuntimeBridge = null/);
  assert.match(request, /runtimeHandoff\?\.suppressNativeAgent === true/);
  assert.match(index, /await installFileAgentRuntimeHost\(\{ app, appConfig \}\)/);
  assert.match(route, /req\.app\?\.locals\?\.fileAgentRuntimeBridge/);
});

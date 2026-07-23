import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { IsolatedCodeApiServer } from './isolated-codeapi.js';

test('isolated CodeAPI supports LibreChat upload and generated artifact download', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'isolated-codeapi-contract-'));
  const server = await new IsolatedCodeApiServer(rootDir).start();
  t.after(async () => {
    await server.stop();
    await rm(rootDir, { recursive: true, force: true });
  });

  const form = new FormData();
  form.append('kind', 'user');
  form.append('id', 'user-1');
  form.append('file', new Blob(['source-data']), 'source.xlsx');
  const uploadResponse = await fetch(`${server.baseUrl}/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(uploadResponse.status, 200);
  const upload = await uploadResponse.json();
  assert.equal(upload.message, 'success');
  assert.equal(server.uploads.length, 1);

  const inputResponse = await fetch(
    `${server.baseUrl}/download/${upload.storage_session_id}/${upload.files[0].fileId}`,
  );
  assert.equal(inputResponse.status, 200);
  assert.equal(await inputResponse.text(), 'source-data');

  const executionResponse = await fetch(`${server.baseUrl}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      item_id: 'contract-execution-1',
      session_id: upload.storage_session_id,
      injected_files: [{ file_id: upload.files[0].fileId, name: 'source.xlsx' }],
      command: "cp /mnt/data/source.xlsx /mnt/data/result.xlsx",
      artifact_paths: ['/mnt/data/result.xlsx'],
    }),
  });
  assert.equal(executionResponse.status, 200);
  const execution = await executionResponse.json();
  assert.equal(execution.status, 'success');
  assert.equal(execution.artifacts.length, 1);

  const artifactResponse = await fetch(
    `${server.baseUrl}/download/${upload.storage_session_id}/${execution.artifacts[0].codeEnvRef.file_id}`,
  );
  assert.equal(artifactResponse.status, 200);
  assert.equal(await artifactResponse.text(), 'source-data');
});

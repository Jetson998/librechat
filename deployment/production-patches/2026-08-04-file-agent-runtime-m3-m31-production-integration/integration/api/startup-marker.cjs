const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const markerPath = process.env.FILE_AGENT_INTEGRATION_API_MARKER || '/tmp/file-agent-integration-api-overlay.json';
const overlayManifestPath = process.env.FILE_AGENT_INTEGRATION_API_OVERLAY_MANIFEST
  || '/opt/file-agent-integration/api-overlay-manifest.json';
const files = [
  '/app/api/server/index.js',
  '/app/api/server/controllers/agents/request.js',
  '/app/api/server/routes/agents/chat.js',
  '/app/api/server/services/FileAgentRuntime.js',
];

const hashes = Object.fromEntries(files.map((file) => [
  file,
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
]));

let overlayManifest = null;
try {
  overlayManifest = JSON.parse(fs.readFileSync(overlayManifestPath, 'utf8'));
} catch {
  overlayManifest = null;
}

fs.mkdirSync(path.dirname(markerPath), { recursive: true });
fs.writeFileSync(markerPath, JSON.stringify({
  schemaVersion: 1,
  marker: 'file-agent-api-overlay-loaded',
  pid: process.pid,
  hashes,
  apiOverlay: overlayManifest
    ? {
        sourceRevision: overlayManifest.sourceRevision ?? null,
        files: overlayManifest.files ?? [],
      }
    : null,
  runtimeSourceRevision: process.env.FILE_AGENT_INTEGRATION_RUNTIME_SOURCE_REVISION || null,
  integrationHarnessRevision: process.env.FILE_AGENT_INTEGRATION_HARNESS_REVISION || null,
  occurredAt: new Date().toISOString(),
}) + '\n', { mode: 0o600 });

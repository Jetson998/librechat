const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const auditFile = process.env.FILE_AGENT_INTEGRATION_CODEAPI_AUDIT_FILE
  || '/var/lib/file-agent-runtime/integration-audit/codeapi.ndjson';
const originalFetch = globalThis.fetch;

function append(record) {
  fs.mkdirSync(path.dirname(auditFile), { recursive: true });
  // The parent is private integration state; the redacted audit itself must
  // also be readable by the host-side E2E process when container and host UIDs
  // differ on a clean Linux machine.
  fs.appendFileSync(auditFile, `${JSON.stringify(record)}\n`, { mode: 0o644 });
}

function safeRequestBody(init) {
  if (typeof init?.body !== 'string') return { bodyType: typeof init?.body };
  try {
    const value = JSON.parse(init.body);
    const code = typeof value.code === 'string' ? value.code : null;
    return {
      fields: Object.keys(value).sort(),
      lang: value.lang ?? null,
      session_id: value.session_id ?? null,
      files: Array.isArray(value.files) ? value.files.map((file) => ({
        id: file?.id ?? file?.file_id ?? null,
        source_file_id: file?.source_file_id ?? null,
        resource_id: file?.resource_id ?? null,
        storage_session_id: file?.storage_session_id ?? null,
        name: file?.name ?? null,
        kind: file?.kind ?? null,
      })) : null,
      codeSha256: code ? crypto.createHash('sha256').update(code).digest('hex') : null,
      codeLength: code?.length ?? 0,
      legacyFields: ['item_id', 'command', 'injected_files', 'artifact_paths', 'timeout_ms']
        .filter((field) => Object.hasOwn(value, field)),
    };
  } catch {
    return { bodyType: 'non-json-string' };
  }
}

async function safeResponseBody(response) {
  try {
    const value = await response.clone().json();
    return {
      responseFields: Object.keys(value && typeof value === 'object' ? value : {}).sort(),
      responseSessionId: value?.session_id ?? null,
      responseFiles: Array.isArray(value?.files)
        ? value.files.map((file) => ({
            id: file?.id ?? file?.file_id ?? file?.fileId ?? null,
            name: file?.name ?? null,
            storage_session_id: file?.storage_session_id ?? file?.session_id ?? null,
            resource_id: file?.resource_id ?? file?.resourceId ?? null,
          }))
        : [],
    };
  } catch {
    return {
      responseFields: [],
      responseSessionId: null,
      responseFiles: [],
      responseBodyType: 'unreadable-or-non-json',
    };
  }
}

globalThis.fetch = async function auditedFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input?.url;
  const isCodeApi = typeof url === 'string' && /\/exec(?:\?|$)/u.test(url);
  if (!isCodeApi) return originalFetch(input, init);
  const record = {
    occurredAt: new Date().toISOString(),
    url,
    method: init.method || 'GET',
    request: safeRequestBody(init),
  };
  try {
    const response = await originalFetch(input, init);
    append({
      ...record,
      responseStatus: response.status,
      ok: response.ok,
      ...(await safeResponseBody(response)),
    });
    return response;
  } catch (error) {
    append({ ...record, error: { name: error.name, message: error.message } });
    throw error;
  }
};

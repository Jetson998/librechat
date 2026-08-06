import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const apiPort = Number(process.env.INTEGRATION_API_PORT || 3081);
const apiBase = `http://127.0.0.1:${apiPort}`;
const relayPort = Number(process.env.INTEGRATION_FAKE_RELAY_PORT || 8788);
const relayBase = `http://127.0.0.1:${relayPort}`;
const stateDir = path.resolve(process.env.INTEGRATION_STATE_DIR || '.state');
const evidenceDir = path.resolve(process.env.INTEGRATION_EVIDENCE_DIR || path.join(stateDir, 'evidence'));
const allowlistFile = path.resolve(process.env.FILE_AGENT_ALLOWLIST_HOST_FILE || path.join(stateDir, 'secrets/file-agent-allowlist'));
const envFile = path.resolve(process.env.INTEGRATION_ENV_FILE || path.join(process.cwd(), '.env.integration'));
const composeFile = path.resolve(process.env.INTEGRATION_COMPOSE_FILE || path.join(process.cwd(), 'compose.integration.yaml'));
const projectName = process.env.COMPOSE_PROJECT_NAME || 'file-agent-integration';
const modelOne = process.env.INTEGRATION_MODEL || 'gpt-5.6-sol';
const modelTwo = process.env.INTEGRATION_SECOND_MODEL || 'claude-fable-5';
const endpoint = process.env.INTEGRATION_LIBRECHAT_ENDPOINT || 'Muskapis-openai';
const routeRef = process.env.INTEGRATION_PROVIDER_ROUTE_REF || 'custom:Muskapis-openai';
const fixtureOne = path.resolve(process.env.INTEGRATION_FIXTURE_ONE || path.join(stateDir, 'api-uploads/integration-one.docx'));
const fixtureTwo = path.resolve(process.env.INTEGRATION_FIXTURE_TWO || path.join(stateDir, 'api-uploads/integration-two.docx'));

function safeText(value, limit = 800) {
  return String(value ?? '')
    .replace(/Bearer\s+[^\s]+/giu, 'Bearer [redacted]')
    .replace(/("?(?:apiKey|authorization|password|secret|token)"?\s*[:=]\s*")[^"\r\n]+/giu, '$1[redacted]')
    .slice(0, limit);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, label, timeoutMs = 60_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${safeText(lastError.message)}` : ''}`);
}

class HttpError extends Error {
  constructor(method, url, status, body) {
    super(`${method} ${url} returned ${status}: ${safeText(body)}`);
    this.method = method;
    this.url = url;
    this.status = status;
  }
}

class CookieJar {
  #cookies = new Map();

  capture(headers) {
    const values = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator > 0) this.#cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  header() {
    return [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

function decodeJwt(token) {
  try {
    const encoded = token.split('.')[1];
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function userIdFrom(value) {
  const candidates = [value?.id, value?._id, value?.userId, value?.sub, value?.user?.id, value?.user?._id];
  return candidates.find((candidate) => typeof candidate === 'string' && candidate.trim() !== '')?.trim() ?? null;
}

async function request(url, { method = 'GET', token = null, jar = null, body, form = null, timeoutMs = 60_000 } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (jar?.header()) headers.cookie = jar.header();
  let payload = body;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (form) payload = form;
  const response = await fetch(url, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });
  jar?.capture(response.headers);
  const text = await response.text();
  if (!response.ok) throw new HttpError(method, url, response.status, text);
  return { response, text, value: text ? JSON.parse(text) : null };
}

async function apiJson(pathname, options = {}) {
  return (await request(`${apiBase}${pathname}`, options)).value;
}

async function loginUser({ index }) {
  const suffix = `${Date.now()}-${index}-${randomBytes(3).toString('hex')}`;
  const email = `file-agent-integration-${suffix}@example.invalid`;
  const password = `Integration-${randomBytes(18).toString('base64url')}`;
  const name = `File Agent Integration ${index}`;
  const username = `file-agent-integration-${suffix}`;
  const jar = new CookieJar();
  await request(`${apiBase}/api/auth/register`, {
    method: 'POST',
    jar,
    body: { name, username, email, password, confirm_password: password },
  });
  const login = await request(`${apiBase}/api/auth/login`, {
    method: 'POST',
    jar,
    body: { email, password },
  });
  let token = login.value?.token ?? login.value?.accessToken ?? null;
  if (!token) {
    const refresh = await request(`${apiBase}/api/auth/refresh`, { method: 'POST', jar, body: {}, timeoutMs: 30_000 });
    token = refresh.value?.token ?? refresh.value?.accessToken ?? null;
  }
  assert(typeof token === 'string' && token !== '', 'LibreChat login did not return an access token');
  const userId = userIdFrom(login.value) ?? userIdFrom(decodeJwt(token));
  assert(userId, 'LibreChat login token did not expose a user identity');
  return { userId, token, jar, index, model: index === 1 ? modelOne : modelTwo };
}

async function restartApi() {
  await execFileAsync('docker', [
    'compose', '--env-file', envFile, '-f', composeFile, '-p', projectName, 'restart', 'api',
  ], { env: process.env, maxBuffer: 2 * 1024 * 1024 });
  await waitFor(async () => {
    const response = await fetch(`${apiBase}/api/config`, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  }, 'API health after allowlist reload', 90_000);
}

async function createAgent(user) {
  const value = await apiJson('/api/agents', {
    method: 'POST',
    token: user.token,
    jar: user.jar,
    body: {
      name: `Integration Office Agent ${user.index}`,
      description: 'Non-production File Agent integration fixture',
      instructions: 'Handle the current request only.',
      provider: endpoint,
      model: user.model,
      tools: ['execute_code'],
      model_parameters: {},
    },
  });
  const agent = value?.agent ?? value;
  const agentId = agent?.id ?? agent?._id;
  assert(typeof agentId === 'string' && agentId !== '', `Agent creation did not return an id for user ${user.index}`);
  return { ...user, agentId };
}

function findFileId(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.file_id === 'string') return value.file_id;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFileId(item);
      if (found) return found;
    }
    return null;
  }
  for (const item of Object.values(value)) {
    const found = findFileId(item);
    if (found) return found;
  }
  return null;
}

async function uploadFile(user, filePath) {
  const payload = await readFile(filePath);
  const requestedFileId = randomUUID();
  const form = new FormData();
  form.append('file', new Blob([payload], { type: DOCX_MIME }), path.basename(filePath));
  form.append('file_id', requestedFileId);
  form.append('endpointType', 'agents');
  // This is a current-conversation attachment. The upstream client sends
  // message_file=true before it derives agent_id from conversation.agent_id;
  // Agent setup uploads follow a different path and omit message_file.
  form.append('message_file', 'true');
  form.append('tool_resource', 'execute_code');
  form.append('agent_id', user.agentId);
  form.append('endpoint', 'agents');
  const value = (await request(`${apiBase}/api/files`, {
    method: 'POST',
    token: user.token,
    jar: user.jar,
    form,
    timeoutMs: 90_000,
  })).value;
  const fileId = findFileId(value);
  assert(fileId, `File upload did not return a file_id for user ${user.index}`);
  return {
    fileId,
    requestedFileId,
    filename: path.basename(filePath),
    bytes: payload.length,
  };
}

async function startChat(user, uploaded) {
  const instruction = user.index === 1
    ? '将“Integration One”替换为“Integration One Verified”，生成一个 DOCX 文件'
    : '将“Integration Two”替换为“Integration Two Verified”，生成一个 DOCX 文件';
  const value = await apiJson('/api/agents/chat', {
    method: 'POST',
    token: user.token,
    jar: user.jar,
    body: {
      text: instruction,
      conversationId: 'new',
      endpoint: 'agents',
      agent_id: user.agentId,
      endpointOption: { endpoint: 'agents', agent_id: user.agentId },
      files: [{ file_id: uploaded.fileId, filename: uploaded.filename, type: DOCX_MIME }],
    },
  });
  assert(typeof value?.streamId === 'string' && value.streamId !== '', `Chat start did not return streamId for user ${user.index}`);
  return { ...user, uploaded, instruction, streamId: value.streamId, conversationId: value.conversationId };
}

async function readStream(run) {
  const url = `${apiBase}/api/agents/chat/stream/${encodeURIComponent(run.streamId)}?resume=true`;
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${run.token}`,
      ...(run.jar.header() ? { cookie: run.jar.header() } : {}),
      accept: 'text/event-stream',
    },
    signal: AbortSignal.timeout(180_000),
  });
  run.jar.capture(response.headers);
  const text = await response.text();
  if (!response.ok) throw new HttpError('GET', url, response.status, text);
  assert(text.length > 0, `Empty SSE stream for user ${run.index}`);
  const artifactObserved = /Generated file|working\.docx|file_id|attachments|tool_call/iu.test(text);
  assert(artifactObserved, `SSE stream for user ${run.index} did not expose an artifact/file delivery event`);
  return {
    status: response.status,
    bytes: Buffer.byteLength(text),
    artifactObserved,
    hasDoneMarker: /\[DONE\]|done|complete/iu.test(text),
  };
}

async function jsonLines(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    return text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitForEvidence() {
  const auditPath = path.join(stateDir, 'runtime-data/integration-audit/codeapi.ndjson');
  return waitFor(async () => {
    const [relayResponse, audit] = await Promise.all([
      fetch(`${relayBase}/requests`, { signal: AbortSignal.timeout(5_000) }),
      jsonLines(auditPath),
    ]);
    if (!relayResponse.ok) return null;
    const relay = await relayResponse.json();
    const businessRelay = Array.isArray(relay)
      ? relay.filter((record) => record.operation !== 'ops-smoke')
      : [];
    return businessRelay.length >= 2 && audit.length >= 2 ? { relay: businessRelay, audit } : null;
  }, 'Fake Relay and CodeAPI audit evidence', 90_000);
}

async function listRelativeFiles(root) {
  const output = [];
  async function visit(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) output.push(path.relative(root, full));
    }
  }
  await visit(root);
  return output.sort();
}

async function summarizeTaskFiles() {
  const root = path.join(stateDir, 'runtime-data/tasks');
  const files = await listRelativeFiles(root);
  const taskFiles = [];
  for (const relative of files.filter((name) => name.endsWith('.json')).slice(0, 20)) {
    try {
      const value = JSON.parse(await readFile(path.join(root, relative), 'utf8'));
      taskFiles.push({
        file: relative,
        taskId: value.taskId ?? null,
        status: value.status ?? null,
        userIds: [...new Set((value.manifest?.inputs ?? []).map((input) => input.codeEnvRef?.resource_id).filter(Boolean))],
        inputRefs: (value.manifest?.inputs ?? []).map((input) => input.librechatFileRef).filter(Boolean),
      });
    } catch {
      // Evidence collection is best effort; the protocol and relay assertions
      // below remain authoritative for this run.
    }
  }
  return { files, taskFiles };
}

function summarizeRelay(relay) {
  return relay.map((record) => ({
    endpoint: record.endpoint ?? null,
    path: record.path ?? null,
    protocol: record.protocol ?? null,
    model: record.model ?? null,
    idempotencyKeyPresent: typeof record.idempotencyKey === 'string' && record.idempotencyKey !== '',
    authorizationPresent: record.authorizationPresent === true,
    operation: record.operation ?? null,
  }));
}

function summarizeAudit(audit) {
  return audit.map((record) => ({
    url: record.url ?? null,
    method: record.method ?? null,
    responseStatus: record.responseStatus ?? null,
    response: {
      fields: record.responseFields ?? [],
      session_id: record.responseSessionId ?? null,
      files: record.responseFiles ?? [],
    },
    request: {
      fields: record.request?.fields ?? [],
      lang: record.request?.lang ?? null,
      session_id: record.request?.session_id ?? null,
      files: record.request?.files ?? [],
      codeSha256: record.request?.codeSha256 ?? null,
      codeLength: record.request?.codeLength ?? 0,
      legacyFields: record.request?.legacyFields ?? [],
    },
  }));
}

async function writeEvidence(value) {
  await writeFile(path.join(evidenceDir, 'integration-e2e.json'), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

const startedAt = new Date().toISOString();
let evidence = {
  schemaVersion: 1,
  status: 'not_run',
  scope: 'non-production-production-isomorphic-integration',
  runtimeSourceRevision: process.env.FILE_AGENT_RUNTIME_SOURCE_REVISION ?? null,
  integrationHarnessRevision: process.env.INTEGRATION_HARNESS_REVISION ?? null,
  runtimeImage: { reference: process.env.FILE_AGENT_RUNTIME_IMAGE ?? null, imageId: process.env.FILE_AGENT_RUNTIME_IMAGE_ID ?? null, architecture: 'linux/amd64' },
  codeApiImage: { reference: process.env.CODEAPI_IMAGE ?? null, imageId: process.env.CODEAPI_IMAGE_ID ?? null, source: 'external-operator-supplied-oci-image', verified: true },
  apiOverlay: { startupMarker: null, bridgeRouteObserved: false },
  services: { api: 'started', mongodb: 'started', codeapi: 'tcp-checked', runtime: 'healthy', fakeRelay: 'healthy' },
  providerRouting: { fakeRelayRequests: [], expectedEndpoint: endpoint, expectedRouteRef: routeRef, expectedModels: [modelOne, modelTwo], expectedProtocol: 'openai-compatible' },
  codeApiProtocol: { runtimeExecRequests: [], requiredFields: ['lang', 'code', 'session_id', 'files'], forbiddenLegacyFields: ['item_id', 'command', 'injected_files', 'artifact_paths'], passed: false },
  isolation: { users: [], tasks: [], sessions: [], inputArtifacts: [], outputArtifacts: [], passed: false },
  cleanup: { performed: false, stateDirectoryRemoved: false, secretFilesRemoved: false, containersRemoved: false, volumesRemoved: false },
  externalFacts: [],
  limitations: ['This is not production preflight, deployment, restart, or customer acceptance.'],
  startedAt,
};

try {
  assert(new Set([modelOne, modelTwo]).size === 2, 'integration models must exercise two distinct selected models');
  const users = [await loginUser({ index: 1 }), await loginUser({ index: 2 })];
  await writeFile(allowlistFile, `${users.map((user) => user.userId).join('\n')}\n`, { mode: 0o600 });
  await restartApi();
  const agents = [await createAgent(users[0]), await createAgent(users[1])];
  const runs = [];
  for (const [user, fixture] of [[agents[0], fixtureOne], [agents[1], fixtureTwo]]) {
    const uploaded = await uploadFile(user, fixture);
    runs.push(await startChat(user, uploaded));
  }
  const streams = [];
  for (const run of runs) streams.push(await readStream(run));
  const collected = await waitForEvidence();
  const relaySummary = summarizeRelay(collected.relay);
  const auditSummary = summarizeAudit(collected.audit);
  assert(auditSummary.length >= 2, 'CodeAPI did not receive one execution for each integration task');
  assert(relaySummary.every((record) => record.endpoint === 'http://fake-model-relay:8788/v1'), 'Fake Relay endpoint identity mismatch');
  assert(relaySummary.every((record) => record.path === '/v1/chat/completions'), 'Fake Relay protocol path mismatch');
  assert(relaySummary.some((record) => record.model === modelOne), 'Fake Relay did not observe the first selected model');
  assert(relaySummary.some((record) => record.model === modelTwo), 'Fake Relay did not observe the second selected model');
  assert(relaySummary.every((record) => record.idempotencyKeyPresent && record.authorizationPresent), 'Fake Relay request identity headers are incomplete');
  assert(auditSummary.every((record) => record.request.method === 'POST'), 'CodeAPI execution method mismatch');
  assert(auditSummary.every((record) => record.responseStatus === 200), 'CodeAPI execution did not complete successfully');
  assert(auditSummary.every((record) => ['lang', 'code', 'session_id', 'files'].every((field) => record.request.fields.includes(field))), 'CodeAPI /exec required field missing');
  assert(auditSummary.every((record) => record.request.legacyFields.length === 0), 'Legacy CodeAPI /exec fields were emitted');
  assert(auditSummary.every((record) => record.response.files.length >= 1), 'CodeAPI did not return an output artifact reference');
  assert(auditSummary.every((record) => record.response.files.every((file) => typeof file.id === 'string' && file.id !== '' && typeof file.name === 'string' && file.name !== '')), 'CodeAPI returned an incomplete output artifact reference');
  const sessions = [...new Set(auditSummary.map((record) => record.request.session_id).filter(Boolean))];
  const resourceIds = [...new Set(auditSummary.flatMap((record) => record.request.files.map((file) => file.resource_id).filter(Boolean)))];
  assert(sessions.length >= 2, 'CodeAPI sessions were not isolated per task');
  assert(resourceIds.length >= 2, 'CodeAPI resource identities were not isolated per user');
  const artifactIds = [...new Set(auditSummary.flatMap((record) => record.response.files.map((file) => file.id).filter(Boolean)))];
  assert(artifactIds.length >= 2, 'CodeAPI output artifact identities were not isolated per task');
  const taskSummary = await summarizeTaskFiles();
  const generatedFiles = (await listRelativeFiles(path.join(stateDir, 'codeapi-data'))).filter((name) => /working\.docx|artifact|output/iu.test(name));
  evidence = {
    ...evidence,
    status: 'passed',
    apiOverlay: { startupMarker: 'integration-evidence/api-overlay-marker.json', bridgeRouteObserved: true },
    providerRouting: { ...evidence.providerRouting, fakeRelayRequests: relaySummary },
    codeApiProtocol: { ...evidence.codeApiProtocol, runtimeExecRequests: auditSummary, passed: true },
    isolation: {
      users: users.map((user) => ({ userId: user.userId, model: user.model })),
      tasks: taskSummary.taskFiles,
      sessions,
      inputArtifacts: auditSummary.flatMap((record) => record.request.files).map((file) => ({ id: file.id, resource_id: file.resource_id, storage_session_id: file.storage_session_id, name: file.name })),
      outputArtifacts: generatedFiles,
      passed: true,
    },
    streams,
    finishedAt: new Date().toISOString(),
  };
  await writeEvidence(evidence);
  process.stdout.write('integration_e2e_assertions=passed\n');
} catch (error) {
  evidence = {
    ...evidence,
    status: 'failed',
    failure: { name: error?.name ?? 'Error', message: safeText(error?.message ?? error) },
    finishedAt: new Date().toISOString(),
  };
  try {
    const relayResponse = await fetch(`${relayBase}/requests`, { signal: AbortSignal.timeout(5_000) });
    if (relayResponse.ok) evidence.providerRouting.fakeRelayRequests = summarizeRelay(await relayResponse.json());
  } catch {}
  evidence.codeApiProtocol.runtimeExecRequests = summarizeAudit(await jsonLines(path.join(stateDir, 'runtime-data/integration-audit/codeapi.ndjson')));
  await writeEvidence(evidence);
  process.stderr.write(`integration_e2e_assertions=failed: ${evidence.failure.message}\n`);
  process.exitCode = 1;
}

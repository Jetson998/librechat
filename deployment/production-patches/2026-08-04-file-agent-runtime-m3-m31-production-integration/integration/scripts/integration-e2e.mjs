import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const apiPort = Number(process.env.INTEGRATION_API_PORT || 3081);
const apiBase = `http://127.0.0.1:${apiPort}`;
const codeApiPort = Number(process.env.INTEGRATION_CODEAPI_PORT || 8001);
const codeApiBase = `http://127.0.0.1:${codeApiPort}`;
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
const faultControlFile = path.join(stateDir, 'runtime-data/fault-control.json');
const expectedReplacementByIndex = new Map([
  [1, 'Integration One Verified'],
  [2, 'Integration Two Verified'],
]);

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

async function createAgent(user, { model = user.model } = {}) {
  const value = await apiJson('/api/agents', {
    method: 'POST',
    token: user.token,
    jar: user.jar,
    body: {
      name: `Integration Office Agent ${user.index}`,
      description: 'Non-production File Agent integration fixture',
      instructions: 'Handle the current request only.',
      provider: endpoint,
      model,
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

async function startChat(user, uploaded, { includeFiles = true, bodyOverrides = {}, instruction = null } = {}) {
  const messageId = randomUUID();
  const resolvedInstruction = instruction ?? (user.index === 1
    ? '将“Integration One”替换为“Integration One Verified”，生成一个 DOCX 文件'
    : '将“Integration Two”替换为“Integration Two Verified”，生成一个 DOCX 文件');
  const body = {
    ...bodyOverrides,
    text: resolvedInstruction,
    messageId,
    conversationId: 'new',
    endpoint: 'agents',
    agent_id: user.agentId,
    endpointOption: { endpoint: 'agents', agent_id: user.agentId },
    ...(includeFiles
      ? { files: [{ file_id: uploaded.fileId, filename: uploaded.filename, type: DOCX_MIME }] }
      : {}),
  };
  const value = await apiJson('/api/agents/chat', {
    method: 'POST',
    token: user.token,
    jar: user.jar,
    body,
  });
  assert(typeof value?.streamId === 'string' && value.streamId !== '', `Chat start did not return streamId for user ${user.index}`);
  assert(typeof value?.conversationId === 'string' && value.conversationId !== '', `Chat start did not return conversationId for user ${user.index}`);
  return {
    ...user,
    uploaded,
    instruction: resolvedInstruction,
    streamId: value.streamId,
    conversationId: value.conversationId,
    userMessageId: messageId,
    assistantMessageId: `${messageId}_`,
    expectedReplacement: expectedReplacementByIndex.get(user.index) ?? null,
  };
}

async function readStream(run, { requireArtifact = true } = {}) {
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
  const hasFinalEvent = /"final"\s*:\s*true/iu.test(text);
  const hasDoneMarker = /data:\s*\[DONE\]/iu.test(text) || hasFinalEvent;
  assert(hasDoneMarker, `SSE stream for user ${run.index} did not expose an explicit terminal event`);
  if (requireArtifact) {
    assert(artifactObserved, `SSE stream for user ${run.index} did not expose an artifact delivery event`);
  }
  return {
    status: response.status,
    bytes: Buffer.byteLength(text),
    artifactObserved,
    hasDoneMarker,
    hasFinalEvent,
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

function opaqueRef(kind, value) {
  return `${kind}_${createHash('sha256').update(`${kind}:${value}`).digest('hex').slice(0, 32)}`;
}

function taskMatchesRun(task, run) {
  const identity = task?.manifest?.identity;
  return identity?.userScope === opaqueRef('user', run.userId)
    && identity?.conversationRef === opaqueRef('conversation', run.conversationId)
    && identity?.messageRef === opaqueRef('message', run.userMessageId);
}

function findTaskForRun(tasks, run) {
  const matches = tasks.filter((task) => taskMatchesRun(task, run));
  assert(matches.length === 1, `Expected exactly one Runtime task for user ${run.index}, found ${matches.length}`);
  return matches[0];
}

function fileIdFrom(value) {
  const fileId = value?.file_id ?? value?.fileId ?? value?.id;
  return typeof fileId === 'string' && fileId.trim() !== '' ? fileId.trim() : null;
}

function fileRefsFromMessage(message) {
  const refs = [];
  for (const field of ['files', 'attachments']) {
    if (!Array.isArray(message?.[field])) continue;
    for (const file of message[field]) {
      const fileId = fileIdFrom(file);
      if (fileId) refs.push({ field, fileId, file });
    }
  }
  return refs;
}

async function loadConversationMessages(run) {
  const value = await apiJson(`/api/messages/${encodeURIComponent(run.conversationId)}`, {
    token: run.token,
    jar: run.jar,
  });
  const messages = Array.isArray(value)
    ? value
    : value?.messages ?? value?.data ?? [];
  assert(Array.isArray(messages), `Conversation ${run.conversationId} did not return a message list`);
  return messages;
}

function findAssistantMessage(messages, run) {
  const message = messages.find((candidate) => candidate?.messageId === run.assistantMessageId);
  assert(message, `Assistant message ${run.assistantMessageId} was not persisted`);
  assert(message.conversationId === run.conversationId, 'Assistant message conversation identity mismatch');
  // GET /api/messages/:conversationId authorizes by the bearer user and
  // intentionally projects the persisted `user` field out of the response.
  // If a deployment exposes it, still verify it; otherwise the authenticated
  // conversation query is the user-scope evidence.
  const exposedUser = message.user ?? message.userId;
  if (exposedUser != null) {
    assert(String(exposedUser) === String(run.userId), 'Assistant message user identity mismatch');
  }
  assert(message.unfinished !== true, 'Assistant message remained unfinished');
  assert(!message.error, 'Assistant message is marked as an error');
  return message;
}

function downloadPathForFile(file) {
  const candidate = file?.filepath ?? file?.path ?? file?.url;
  if (typeof candidate === 'string' && candidate.startsWith('/api/files/')) {
    return candidate;
  }
  const fileId = fileIdFrom(file);
  assert(fileId, 'Download card has no file_id');
  return `/api/files/${encodeURIComponent(fileId)}`;
}

async function downloadAndValidateDocx(run, file, artifact, task) {
  const pathname = downloadPathForFile(file);
  const response = await fetch(`${apiBase}${pathname}`, {
    headers: {
      authorization: `Bearer ${run.token}`,
      ...(run.jar.header() ? { cookie: run.jar.header() } : {}),
    },
    signal: AbortSignal.timeout(90_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(response.ok, `Generated file download returned ${response.status}`);
  assert(bytes.length > 0, 'Generated file download was empty');
  assert(response.headers.get('content-type')?.split(';', 1)[0] === DOCX_MIME, 'Generated file MIME type is not DOCX');
  assert(String(file.filename ?? file.name ?? '').toLowerCase().endsWith('.docx'), 'Visible artifact filename is not DOCX');
  assert(String(file.filename ?? file.name) === artifact.name, 'Visible artifact filename does not match Runtime artifact');

  const downloadedPath = path.join(evidenceDir, `downloaded-${run.index}.docx`);
  await writeFile(downloadedPath, bytes, { mode: 0o600 });
  const digest = createHash('sha256').update(bytes).digest('hex');
  await execFileAsync('unzip', ['-t', downloadedPath], { maxBuffer: 2 * 1024 * 1024 });
  const { stdout: documentXml } = await execFileAsync('unzip', ['-p', downloadedPath, 'word/document.xml'], {
    maxBuffer: 4 * 1024 * 1024,
  });
  assert(documentXml.includes(run.expectedReplacement), `Downloaded DOCX does not contain ${run.expectedReplacement}`);

  const codeApiRef = artifact?.codeEnvRef;
  const visibleCodeApiArtifactId = file?.metadata?.codeEnvRef?.file_id ?? file?.codeEnvRef?.file_id ?? null;
  assert(visibleCodeApiArtifactId === codeApiRef?.file_id,
    'Visible LibreChat attachment does not reference the Runtime CodeAPI artifact');
  assert(codeApiRef?.storage_session_id === task.execution?.sessionId, 'Output artifact storage session mismatch');
  if (codeApiRef?.resource_id != null) {
    assert(codeApiRef.resource_id === run.userId, 'Output artifact user identity mismatch');
  }
  return {
    pathname,
    librechatFileId: fileIdFrom(file),
    codeApiArtifactId: codeApiRef?.file_id ?? null,
    filename: file.filename ?? file.name,
    mimeType: response.headers.get('content-type')?.split(';', 1)[0] ?? null,
    bytes: bytes.length,
    sha256: digest,
    contentVerified: true,
  };
}

async function waitForEvidence(minimumCount = 2) {
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
    const businessAudit = businessCodeApiAudit(audit);
    return businessRelay.length >= minimumCount && businessAudit.length >= minimumCount
      ? { relay: businessRelay, audit: businessAudit }
      : null;
  }, 'Fake Relay and CodeAPI audit evidence', 90_000);
}

function businessCodeApiAudit(audit) {
  return audit.filter((record) => record.request?.session_id !== 'integration-ops-smoke');
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
        phase: value.phase ?? null,
        identity: value.manifest?.identity ?? null,
        model: value.manifest?.model
          ? {
              providerRouteRef: value.manifest.model.providerRouteRef ?? null,
              providerEndpoint: value.manifest.model.providerEndpoint ?? null,
              providerModel: value.manifest.model.providerModel ?? null,
              providerProtocol: value.manifest.model.providerProtocol ?? null,
              routeConfigDigest: value.manifest.model.routeConfigDigest ?? null,
              capabilityProfile: value.manifest.model.capabilityProfile ?? null,
            }
          : null,
        execution: value.manifest?.execution
          ? { sessionId: value.manifest.execution.sessionId ?? null }
          : null,
        userIds: [...new Set((value.manifest?.inputs ?? []).map((input) => input.codeEnvRef?.resource_id).filter(Boolean))],
        inputRefs: (value.manifest?.inputs ?? []).map((input) => input.librechatFileRef).filter(Boolean),
        inputCodeApiRefs: (value.manifest?.inputs ?? []).map((input) => ({
          resource_id: input.codeEnvRef?.resource_id ?? null,
          storage_session_id: input.codeEnvRef?.storage_session_id ?? null,
          file_id: input.codeEnvRef?.file_id ?? null,
        })),
        verification: value.verification
          ? {
              passed: value.verification.passed === true,
              profile: value.verification.profile ?? null,
              fingerprint: value.verification.fingerprint ?? null,
              artifact: value.verification.artifact
                ? {
                    logicalId: value.verification.artifact.logicalId ?? null,
                    sha256: value.verification.artifact.sha256 ?? null,
                  }
                : null,
            }
          : null,
        result: {
          artifacts: (value.result?.artifacts ?? []).map((artifact) => ({
            name: artifact.name ?? null,
            mimeType: artifact.mimeType ?? null,
            size: artifact.size ?? null,
            codeEnvRef: artifact.codeEnvRef
              ? {
                  resource_id: artifact.codeEnvRef.resource_id ?? null,
                  id: artifact.codeEnvRef.id ?? null,
                  storage_session_id: artifact.codeEnvRef.storage_session_id ?? null,
                  file_id: artifact.codeEnvRef.file_id ?? null,
                }
              : null,
          })),
        },
        usageRecords: (value.usageRecords ?? []).map((record) => ({
          providerRouteRef: record.providerRouteRef ?? null,
          providerEndpoint: record.providerEndpoint ?? null,
          providerModel: record.providerModel ?? null,
          providerProtocol: record.providerProtocol ?? null,
          routeConfigDigest: record.routeConfigDigest ?? null,
          requestedModel: record.requestedModel ?? null,
          actualModel: record.actualModel ?? null,
        })),
      });
    } catch {
      // Evidence collection is best effort; the protocol and relay assertions
      // below remain authoritative for this run.
    }
  }
  return { files, taskFiles };
}

async function assertNativeFallback(user, uploaded, { instruction, label }) {
  const before = await summarizeTaskFiles();
  try {
    const run = await startChat(user, uploaded, {
      includeFiles: uploaded != null,
      instruction,
    });
    const stream = await readStream(run, { requireArtifact: false });
    const after = await summarizeTaskFiles();
    assert(!after.taskFiles.some((task) => taskMatchesRun(task, run)), `${label} unexpectedly created a Runtime task`);
    return {
      status: 'passed',
      label,
      route: 'native',
      conversationId: run.conversationId,
      userId: run.userId,
      stream,
      runtimeTaskCountBefore: before.taskFiles.length,
      runtimeTaskCountAfter: after.taskFiles.length,
    };
  } catch (error) {
    // The production contract permits either native fallback or fail-closed
    // rejection for a request outside the File Agent route.
    assert(error instanceof HttpError, `${label} failed unexpectedly: ${safeText(error?.message ?? error)}`);
    assert([400, 401, 403, 404, 409, 422].includes(error.status), `${label} returned unexpected HTTP ${error.status}`);
    return { status: 'passed', label, route: 'rejected', httpStatus: error.status };
  }
}

async function assertMalformedCodeApiBody() {
  const response = await fetch(`${codeApiBase}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      item_id: 'forged-item',
      command: 'printf should-not-run',
      injected_files: [],
      artifact_paths: ['/tmp/forged.docx'],
      session_id: 'integration-malformed-body',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  assert(response.status >= 400 && response.status < 500, `Malformed CodeAPI body was not rejected: HTTP ${response.status} ${safeText(text)}`);
  return { status: 'passed', httpStatus: response.status };
}

async function assertUnsupportedModel(user, fixture) {
  let unsupportedAgent;
  try {
    unsupportedAgent = await createAgent(user, { model: 'unsupported-integration-model' });
  } catch (error) {
    // Rejecting the unsupported model while creating the Agent is also a
    // valid fail-closed boundary; do not turn that expected 4xx into a runner
    // failure.
    assert(error instanceof HttpError, `unsupported_model failed unexpectedly: ${safeText(error?.message ?? error)}`);
    assert([400, 401, 403, 404, 409, 422].includes(error.status), `unsupported_model returned unexpected HTTP ${error.status}`);
    return { status: 'passed', label: 'unsupported_model', route: 'rejected-at-agent-create', httpStatus: error.status };
  }
  const run = { ...user, ...unsupportedAgent };
  const uploaded = await uploadFile(run, fixture);
  return assertNativeFallback(run, uploaded, {
    label: 'unsupported_model',
    instruction: '将“Integration One”替换为“Integration One Unsupported”，生成一个 DOCX 文件',
  });
}

async function assertForeignFileRejected(user, foreignFile) {
  const before = await summarizeTaskFiles();
  try {
    const run = await startChat(user, foreignFile, {
      instruction: '将外部用户文件替换并生成一个 DOCX 文件',
    });
    await readStream(run, { requireArtifact: false });
    const after = await summarizeTaskFiles();
    assert(!after.taskFiles.some((task) => taskMatchesRun(task, run)), 'Foreign file reference unexpectedly created a Runtime task');
    return {
      status: 'passed',
      route: 'native-or-rejected',
      conversationId: run.conversationId,
      runtimeTaskCountBefore: before.taskFiles.length,
      runtimeTaskCountAfter: after.taskFiles.length,
    };
  } catch (error) {
    assert(error instanceof HttpError, `Foreign file rejection failed unexpectedly: ${safeText(error?.message ?? error)}`);
    assert([400, 401, 403, 404, 409, 422].includes(error.status), `Foreign file reference returned unexpected HTTP ${error.status}`);
    return { status: 'passed', route: 'rejected', httpStatus: error.status };
  }
}

function taskFilesKey(summary) {
  return summary.taskFiles.map((task) => task.file).sort().join('\n');
}

async function assertBridgeMissing() {
  const before = await summarizeTaskFiles();
  let exitCode = 0;
  let output = '';
  try {
    await execFileAsync('docker', [
      'compose', '--env-file', envFile, '-f', composeFile, '-p', projectName,
      'run', '--rm', '--no-deps',
      '-e', 'FILE_AGENT_RUNTIME_ENABLED=true',
      // The API implementation consumes FILE_AGENT_CONNECTOR_ROOT. Keep the
      // review spelling too so this probe cannot accidentally pass because a
      // stale variable name was silently ignored.
      '-e', 'FILE_AGENT_RUNTIME_CONNECTOR_ROOT=/nonexistent',
      '-e', 'FILE_AGENT_CONNECTOR_ROOT=/nonexistent',
      'api',
    ], { env: process.env, maxBuffer: 4 * 1024 * 1024, timeout: 90_000 });
  } catch (error) {
    exitCode = typeof error.code === 'number' ? error.code : -1;
    output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  }
  assert(exitCode !== 0, 'bridge-missing probe unexpectedly started the API successfully');
  assert(/\/nonexistent|Cannot find module|ENOENT/iu.test(output),
    'bridge-missing probe did not fail while loading the missing connector root');
  const normalApiReady = await fetch(`${apiBase}/readyz`, { signal: AbortSignal.timeout(5_000) });
  assert(normalApiReady.ok, 'normal five-service API was not ready after bridge-missing probe');
  const after = await summarizeTaskFiles();
  assert(taskFilesKey(after) === taskFilesKey(before), 'bridge-missing probe created a Runtime task');
  return {
    label: 'bridge_missing',
    status: 'passed',
    faultInjected: true,
    effectiveConnectorRoot: '/nonexistent',
    processExitCode: exitCode,
    ready: false,
    bridgeSuccessMarkerObserved: false,
    normalEnvironmentUnaffected: true,
    runtimeTaskCreated: false,
    errorClass: /Cannot find module|ENOENT/iu.test(output) ? 'connector_root_load_failure' : 'startup_failure',
  };
}

async function waitForTaskForRun(run) {
  return waitFor(async () => {
    const summary = await summarizeTaskFiles();
    const matches = summary.taskFiles.filter((task) => taskMatchesRun(task, run));
    return matches.length === 1 ? matches[0] : null;
  }, `Runtime task for user ${run.index}`, 30_000, 250);
}

async function removeFaultControl() {
  try {
    await unlink(faultControlFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function assertArtifactIdentityMismatch(user, fixture) {
  await removeFaultControl();
  const uploaded = await uploadFile(user, fixture);
  const run = await startChat(user, uploaded, {
    instruction: '将“Integration One”替换为“Integration One Fault”，生成一个 DOCX 文件',
  });
  const taskBeforeFault = await waitForTaskForRun(run);
  assert(taskBeforeFault.execution?.sessionId, 'artifact identity fault task has no session identity');
  await mkdir(path.dirname(faultControlFile), { recursive: true, mode: 0o777 });
  await writeFile(faultControlFile, `${JSON.stringify({
    schemaVersion: 1,
    mode: 'artifact-identity-mismatch',
    targetSessionId: taskBeforeFault.execution.sessionId,
    mutation: 'storage_session_id',
    once: true,
  })}\n`, { mode: 0o644 });

  let stream;
  let controlClearedByShim = false;
  try {
    stream = await readStream(run, { requireArtifact: false });
  } finally {
    try {
      await stat(faultControlFile);
    } catch (error) {
      if (error.code === 'ENOENT') controlClearedByShim = true;
      else throw error;
    }
    // The shim must consume the control itself. This cleanup only prevents a
    // failed probe from leaking a future fault into another task.
    await removeFaultControl();
  }
  const faultAudit = await waitFor(async () => {
    const records = await jsonLines(path.join(stateDir, 'runtime-data/integration-audit/codeapi.ndjson'));
    return records.find((record) => record.request?.session_id === taskBeforeFault.execution.sessionId
      && record.faultInjected === true) ?? null;
  }, 'artifact identity fault audit', 30_000, 250);
  const faultTask = await waitForTaskForRun(run);
  assert(faultTask.status !== 'completed', 'artifact identity mismatch task was marked completed');
  assert(faultTask.verification?.passed !== true, 'Verifier accepted an artifact with mismatched identity');
  assert((faultTask.result?.artifacts ?? []).length === 0, 'artifact identity mismatch task retained a delivered artifact');

  const messages = await loadConversationMessages(run);
  const assistant = messages.find((message) => message?.messageId === run.assistantMessageId);
  const visibleRefs = assistant ? fileRefsFromMessage(assistant) : [];
  assert(visibleRefs.length === 0, 'artifact identity mismatch conversation exposed a downloadable attachment');
  assert(controlClearedByShim, 'artifact identity fault control file was not consumed and cleared');
  return {
    label: 'artifact_identity_mismatch',
    status: 'passed',
    faultInjected: true,
    mutation: 'storage_session_id',
    taskId: faultTask.taskId,
    sessionId: taskBeforeFault.execution.sessionId,
    stream,
    runtimeStatus: faultTask.status,
    verifierPassed: faultTask.verification?.passed === true,
    visibleAttachmentCount: visibleRefs.length,
    auditFaultInjected: faultAudit.faultInjected === true,
    controlFileCleared: controlClearedByShim,
  };
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
    faultInjected: record.faultInjected === true,
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
  const positiveUploads = [];
  for (const [user, fixture] of [[agents[0], fixtureOne], [agents[1], fixtureTwo]]) {
    const uploaded = await uploadFile(user, fixture);
    positiveUploads.push(uploaded);
    runs.push(await startChat(user, uploaded));
  }
  const forgedRouteUpload = await uploadFile(agents[1], fixtureTwo);
  runs.push(await startChat(agents[1], forgedRouteUpload, {
    bodyOverrides: {
      providerRouteRef: 'custom:forged-client-route',
      providerEndpoint: 'https://attacker.invalid/v1',
      baseURL: 'https://attacker.invalid/v1',
      apiKey: 'forged-client-secret',
    },
  }));

  const negativePaths = {
    nonAllowlisted: 'not_run',
    ordinaryChatNativeFallback: 'not_run',
    unsupportedModel: 'not_run',
    forgedRouteRef: 'passed',
    bridgeMissing: 'not_run',
    malformedCodeApiBody: 'not_run',
    artifactIdentityMismatch: 'not_run',
    foreignInputIdentity: 'not_run',
  };
  const negativeEvidence = [];
  const nativeUser = await loginUser({ index: 3 });
  const nativeAgent = await createAgent(nativeUser);
  const nativeRun = { ...nativeUser, ...nativeAgent };
  const nativeUpload = await uploadFile(nativeRun, fixtureOne);
  negativeEvidence.push(await assertNativeFallback(nativeRun, nativeUpload, {
    label: 'non_allowlisted_user',
    instruction: '将“Integration One”替换为“Integration One Native”，生成一个 DOCX 文件',
  }));
  negativePaths.nonAllowlisted = 'passed';

  negativeEvidence.push(await assertNativeFallback(agents[0], null, {
    label: 'ordinary_chat',
    instruction: '请只回复 integration-native-pong，不要读取或生成文件',
  }));
  negativePaths.ordinaryChatNativeFallback = 'passed';

  negativeEvidence.push(await assertUnsupportedModel(users[0], fixtureOne));
  negativePaths.unsupportedModel = 'passed';
  negativeEvidence.push(await assertBridgeMissing());
  negativePaths.bridgeMissing = 'passed';
  negativeEvidence.push({ label: 'malformed_codeapi_body', ...(await assertMalformedCodeApiBody()) });
  negativePaths.malformedCodeApiBody = 'passed';
  negativeEvidence.push({
    label: 'foreign_file_identity',
    ...(await assertForeignFileRejected(agents[1], positiveUploads[0])),
  });
  negativePaths.foreignInputIdentity = 'passed';

  negativeEvidence.push(await assertArtifactIdentityMismatch(agents[0], fixtureOne));
  negativePaths.artifactIdentityMismatch = 'passed';

  const streams = [];
  for (const run of runs) streams.push(await readStream(run));
  const collected = await waitForEvidence(runs.length + 1);
  const relaySummary = summarizeRelay(collected.relay);
  const auditSummary = summarizeAudit(collected.audit);
  const taskSummary = await summarizeTaskFiles();
  const runtimeTasks = runs.map((run) => findTaskForRun(taskSummary.taskFiles, run));
  assert(auditSummary.length >= 2, 'CodeAPI did not receive one execution for each integration task');
  assert(relaySummary.every((record) => record.endpoint === 'http://fake-model-relay:8788/v1'), 'Fake Relay endpoint identity mismatch');
  assert(relaySummary.every((record) => record.path === '/v1/chat/completions'), 'Fake Relay protocol path mismatch');
  assert(relaySummary.some((record) => record.model === modelOne), 'Fake Relay did not observe the first selected model');
  assert(relaySummary.some((record) => record.model === modelTwo), 'Fake Relay did not observe the second selected model');
  assert(relaySummary.every((record) => record.idempotencyKeyPresent && record.authorizationPresent), 'Fake Relay request identity headers are incomplete');
  assert(auditSummary.every((record) => record.method === 'POST'), 'CodeAPI execution method mismatch');
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
  for (const [index, task] of runtimeTasks.entries()) {
    const run = runs[index];
    assert(task.taskId, `Runtime task ${index + 1} has no taskId`);
    assert(task.status === 'completed', `Runtime task ${task.taskId} did not reach completed status`);
    assert(task.verification?.passed === true, `Runtime task ${task.taskId} does not have Verifier passed=true`);
    assert(task.result?.artifacts?.length === 1, `Runtime task ${task.taskId} did not produce exactly one artifact`);
    const artifact = task.result.artifacts[0];
    assert(artifact.mimeType === DOCX_MIME, `Runtime task ${task.taskId} artifact MIME is not DOCX`);
    assert(artifact.name === 'working.docx', `Runtime task ${task.taskId} artifact name is not working.docx`);
    assert(task.model?.providerRouteRef === routeRef, `Runtime task ${task.taskId} routeRef mismatch`);
    assert(task.model?.providerEndpoint === endpoint, `Runtime task ${task.taskId} provider endpoint mismatch`);
    assert(task.model?.providerModel === run.model, `Runtime task ${task.taskId} selected model mismatch`);
    assert(task.model?.providerProtocol === 'openai-compatible', `Runtime task ${task.taskId} protocol mismatch`);
    assert(typeof task.model?.routeConfigDigest === 'string' && task.model.routeConfigDigest !== '', `Runtime task ${task.taskId} routeConfigDigest is missing`);
    assert(task.execution?.sessionId, `Runtime task ${task.taskId} session identity is missing`);
    assert(task.userIds.length === 1 && task.userIds[0] === run.userId, `Runtime task ${task.taskId} user identity mismatch`);
    assert(task.usageRecords.length >= 1, `Runtime task ${task.taskId} has no provider usage record`);
    assert(task.usageRecords.every((record) => record.providerRouteRef === routeRef
      && record.providerEndpoint === endpoint
      && record.providerModel === run.model
      && record.providerProtocol === 'openai-compatible'
      && record.requestedModel === run.model
      && record.actualModel === run.model
      && record.routeConfigDigest === task.model.routeConfigDigest), `Runtime task ${task.taskId} usage route identity does not reconcile`);
    const matchingAudits = auditSummary.filter((record) => record.request.session_id === task.execution.sessionId);
    assert(matchingAudits.length >= 1, `Runtime task ${task.taskId} has no CodeAPI audit for its session`);
    assert(matchingAudits.every((record) => record.request.files.every((file) => file.resource_id === run.userId)), `Runtime task ${task.taskId} CodeAPI input user identity mismatch`);
    assert(matchingAudits.every((record) => record.response.files.some((file) => file.id === artifact.codeEnvRef.file_id)), `Runtime task ${task.taskId} audit artifact does not match task result`);
  }
  const forgedTaskEvidence = JSON.stringify(runtimeTasks[2]);
  assert(!forgedTaskEvidence.includes('attacker.invalid') && !forgedTaskEvidence.includes('forged-client-secret'), 'Forged client route data leaked into Runtime task evidence');
  const forgedAuditEvidence = JSON.stringify(auditSummary.filter((record) => record.request.session_id === runtimeTasks[2].execution.sessionId));
  assert(!forgedAuditEvidence.includes('attacker.invalid') && !forgedAuditEvidence.includes('forged-client-secret'), 'Forged client route data leaked into CodeAPI audit evidence');

  const deliveryEvidence = [];
  for (const [index, run] of runs.entries()) {
    const messages = await loadConversationMessages(run);
    const assistant = findAssistantMessage(messages, run);
    const visibleRefs = fileRefsFromMessage(assistant);
    const uniqueVisibleFileIds = [...new Set(visibleRefs.map((entry) => entry.fileId))];
    // LibreChat stores code-execution outputs on assistant `attachments`;
    // this repository's message builder mirrors the same output in `files`
    // for compatibility. Require both mirrors to contain exactly one equal
    // reference so a second logical attachment cannot hide in either field.
    assert(Array.isArray(assistant.attachments) && assistant.attachments.length === 1,
      `Conversation ${run.conversationId} did not expose exactly one assistant attachment`);
    assert(Array.isArray(assistant.files) && assistant.files.length === 1,
      `Conversation ${run.conversationId} did not expose the mirrored assistant file reference`);
    assert(uniqueVisibleFileIds.length === 1, `Conversation ${run.conversationId} exposed more than one visible attachment`);
    assert(fileIdFrom(assistant.attachments[0]), `Conversation ${run.conversationId} downloadable attachment has no file_id`);
    assert(fileIdFrom(assistant.files[0]) === fileIdFrom(assistant.attachments[0]),
      `Conversation ${run.conversationId} attachment fields disagree`);
    const task = runtimeTasks[index];
    const downloaded = await downloadAndValidateDocx(run, assistant.attachments[0], task.result.artifacts[0], task);
    deliveryEvidence.push({
      conversationId: run.conversationId,
      userId: run.userId,
      userMessageId: run.userMessageId,
      assistantMessageId: run.assistantMessageId,
      taskId: task.taskId,
      sessionId: task.execution.sessionId,
      requestedModel: task.model.providerModel,
      actualModel: [...new Set(task.usageRecords.map((record) => record.actualModel))],
      routeConfigDigest: task.model.routeConfigDigest,
      artifactId: task.result.artifacts[0].codeEnvRef.file_id,
      verifier: task.verification,
      visibleAttachmentCount: uniqueVisibleFileIds.length,
      visibleAttachmentField: 'attachments',
      downloaded,
    });
  }
  const generatedFiles = (await listRelativeFiles(path.join(stateDir, 'codeapi-data'))).filter((name) => /working\.docx|artifact|output/iu.test(name));
  const allNegativePathsPassed = Object.values(negativePaths).every((status) => status === 'passed');
  evidence = {
    ...evidence,
    status: allNegativePathsPassed ? 'passed' : 'partial',
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
    businessE2E: {
      status: allNegativePathsPassed ? 'passed' : 'partial',
      streams,
      deliveries: deliveryEvidence,
      negativePaths,
      negativeEvidence,
    },
    finishedAt: new Date().toISOString(),
  };
  await writeEvidence(evidence);
  process.stdout.write(`integration_e2e_assertions=${evidence.status}\n`);
  if (!allNegativePathsPassed) {
    process.stderr.write('integration_e2e_assertions=partial: fault-injection negative paths remain not_run\n');
    process.exitCode = 2;
  }
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
  evidence.codeApiProtocol.runtimeExecRequests = summarizeAudit(
    businessCodeApiAudit(await jsonLines(path.join(stateDir, 'runtime-data/integration-audit/codeapi.ndjson'))),
  );
  await writeEvidence(evidence);
  process.stderr.write(`integration_e2e_assertions=failed: ${evidence.failure.message}\n`);
  process.exitCode = 1;
}

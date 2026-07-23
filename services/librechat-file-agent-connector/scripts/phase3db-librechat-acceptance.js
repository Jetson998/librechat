import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { CodeApiHttpTransport } from '../../file-agent-runtime/src/codeapi-transport.js';
import { ContextProjector } from '../../file-agent-runtime/src/context-projector.js';
import { CodeApiXlsxExecutor } from '../../file-agent-runtime/src/deterministic-xlsx.js';
import { createRuntimeHttpServer } from '../../file-agent-runtime/src/http-server.js';
import { FileModelCallJournal } from '../../file-agent-runtime/src/model-call-journal.js';
import {
  OpenAiChatTransport,
  SingleModelAgentProvider,
} from '../../file-agent-runtime/src/openai-compatible-provider.js';
import { FileAgentRuntime } from '../../file-agent-runtime/src/runtime.js';
import { FileTaskStore } from '../../file-agent-runtime/src/task-store.js';
import { IsolatedCodeApiServer } from '../../file-agent-runtime/test/isolated-codeapi.js';
import { IsolatedModelRelay } from '../../file-agent-runtime/test/isolated-model-relay.js';

const execFileAsync = promisify(execFile);
const CONFIRMATION = 'FULL_ISOLATED_LIBRECHAT_ACCEPTANCE';
const UPSTREAM_PIN = '60eba76375213dafc1874d943e41371201c300ab';
const AGENT_NAME = 'Phase 3D-B File Agent';
const MOCK_ENDPOINT = 'Mock Provider A';
const MOCK_MODEL = 'mock-model-a';
const OUTPUT_NAME = 'phase1-output.xlsx';

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, message, timeoutMs = 30_000, intervalMs = 50) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${message}`, { cause: lastError });
}

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeServer(server) {
  if (!server?.listening) {
    return;
  }
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function boundedLogCollector(stream, prefix) {
  const lines = [];
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) {
        continue;
      }
      lines.push(`${prefix}${line}`);
      if (lines.length > 240) {
        lines.shift();
      }
    }
  });
  return lines;
}

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) {
    return;
  }
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(20_000).then(() => false),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

async function createWorkbook(filePath, marker) {
  const source = [
    'from openpyxl import Workbook',
    'import sys',
    'wb=Workbook()',
    'ws=wb.active',
    'ws.title="Source"',
    'ws.append(["Channel","Model","Marker"])',
    `ws.append(["non-production","${MOCK_MODEL}",${JSON.stringify(marker)}])`,
    'wb.save(sys.argv[1])',
  ].join('\n');
  await execFileAsync('python3', ['-c', source, filePath]);
}

function runtimePlan(operation) {
  if (operation === 'repair') {
    return {
      schemaVersion: '1.0',
      summary: 'Patch the persisted workbook worker',
      needsInput: false,
      actions: [{ kind: 'xlsx_patch_and_transform', summary: 'Apply one bounded worker patch' }],
    };
  }
  return {
    schemaVersion: '1.0',
    summary: 'Run the persisted workbook worker',
    needsInput: false,
    actions: [{ kind: 'xlsx_transform', summary: 'Run the stable workbook transform' }],
  };
}

function createRuntimeFactory({ rootDir, relay, codeApi, runtimePort, requestCounts }) {
  const storePath = path.join(rootDir, 'runtime-store');
  const journalPath = path.join(rootDir, 'provider-journal');
  let runtime = null;
  let server = null;

  const start = async () => {
    runtime = new FileAgentRuntime({
      store: new FileTaskStore(storePath),
      provider: new SingleModelAgentProvider({
        routes: {
          'file-agent-primary': {
            baseUrl: relay.baseUrl,
            model: 'recorded-office-planner',
            apiKey: 'isolated-non-production-key',
            capabilityProfile: 'office-planner-v1',
            supportsIdempotency: true,
            outputBudgetTokens: 500,
          },
        },
        transport: new OpenAiChatTransport(),
        journal: new FileModelCallJournal(journalPath),
        projector: new ContextProjector({ maxChars: 8_000 }),
      }),
      executor: new CodeApiXlsxExecutor({
        transport: new CodeApiHttpTransport({ baseUrl: codeApi.baseUrl }),
      }),
      maxConcurrentTasks: 1,
    });
    await runtime.start();
    server = createRuntimeHttpServer(runtime);
    server.on('request', (request) => {
      const key = `${request.method} ${new URL(request.url, 'http://runtime.local').pathname}`;
      requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
    });
    await listen(server, runtimePort);
    return runtime;
  };

  const stop = async () => {
    await closeServer(server).catch(() => {});
    await runtime?.stop().catch(() => {});
    server = null;
    runtime = null;
  };

  return {
    start,
    stop,
    current: () => runtime,
    async restart() {
      await stop();
      return start();
    },
  };
}

function apiEnvironment({ upstreamRoot, configPath, mongoUri, codeApiBaseUrl, apiPort }) {
  const passthrough = ['HOME', 'PATH', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'USER'];
  const env = Object.fromEntries(
    passthrough.flatMap((key) => (process.env[key] == null ? [] : [[key, process.env[key]]])),
  );
  return {
    ...env,
    NODE_ENV: 'CI',
    HOST: '127.0.0.1',
    PORT: String(apiPort),
    MONGO_URI: mongoUri,
    DOMAIN_CLIENT: `http://127.0.0.1:${apiPort}`,
    DOMAIN_SERVER: `http://127.0.0.1:${apiPort}`,
    CONFIG_PATH: configPath,
    LIBRECHAT_CODE_BASEURL: codeApiBaseUrl,
    LIBRECHAT_TEST_RUN_HOOK: path.join(upstreamRoot, 'e2e/setup/fake-model.js'),
    MOCK_LLM_REPLY: 'E2E mock reply: pong',
    CREDS_KEY: randomBytes(32).toString('hex'),
    CREDS_IV: randomBytes(16).toString('hex'),
    JWT_SECRET: randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    ALLOW_REGISTRATION: 'true',
    EMAIL_HOST: '',
    SEARCH: 'false',
    TITLE_CONVO: 'false',
    NO_INDEX: 'true',
    SESSION_EXPIRY: '3600000',
    REFRESH_TOKEN_EXPIRY: '3600000',
    LOGIN_VIOLATION_SCORE: '0',
    REGISTRATION_VIOLATION_SCORE: '0',
    CONCURRENT_VIOLATION_SCORE: '0',
    MESSAGE_VIOLATION_SCORE: '0',
    NON_BROWSER_VIOLATION_SCORE: '0',
    FILE_UPLOAD_VIOLATION_SCORE: '0',
    LIMIT_CONCURRENT_MESSAGES: 'false',
    LIMIT_MESSAGE_IP: 'false',
    LIMIT_MESSAGE_USER: 'false',
    USE_REDIS: 'false',
    USE_REDIS_STREAMS: 'false',
  };
}

function createApiController({ repositoryRoot, upstreamRoot, environment, runtimeBaseUrl }) {
  let child = null;
  let stdoutLogs = [];
  let stderrLogs = [];
  let ipcMessages = [];
  const launcherPath = path.join(
    repositoryRoot,
    'services/librechat-file-agent-connector/scripts/phase3db-librechat-host-launcher.cjs',
  );

  const start = async ({ bridge, allowlistedUserIds = [] }) => {
    assert.equal(child, null, 'API child is already running');
    const entrypoint = bridge ? launcherPath : path.join(upstreamRoot, 'api/server/index.js');
    child = spawn(process.execPath, [entrypoint], {
      cwd: upstreamRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    stdoutLogs = boundedLogCollector(child.stdout, '[stdout] ');
    stderrLogs = boundedLogCollector(child.stderr, '[stderr] ');
    ipcMessages = [];
    let hostReady = !bridge;
    child.on('message', (message) => {
      ipcMessages.push(message);
      if (ipcMessages.length > 100) {
        ipcMessages.shift();
      }
      if (message?.type === 'file-agent-host-ready') {
        hostReady = true;
      }
    });
    if (bridge) {
      child.send({
        upstreamRoot,
        repositoryRoot,
        runtimeBaseUrl,
        serviceScopeSecret: randomBytes(32).toString('hex'),
        deliveryCollectionName: 'file_agent_phase3db_deliveries',
        billingSnapshotCollectionName: 'file_agent_phase3db_billing_snapshots',
        allowlistedUserIds,
        reconcilerId: `phase3db-api-${randomUUID()}`,
        reconcileIntervalMs: 250,
        modelRouteId: 'file-agent-primary',
        limits: { maxVisibleArtifacts: 3 },
      });
    }

    const baseUrl = environment.DOMAIN_SERVER;
    try {
      await waitFor(async () => {
        if (child.exitCode != null || child.signalCode != null) {
          throw new Error(`LibreChat API exited early\n${[...stdoutLogs, ...stderrLogs].join('\n')}`);
        }
        const response = await fetch(`${baseUrl}/api/config`).catch(() => null);
        return response?.ok;
      }, bridge ? 'LibreChat API with File Agent host' : 'native LibreChat API', 90_000, 100);
    } catch (error) {
      throw new Error(`${error.message}\n${[...stdoutLogs, ...stderrLogs].join('\n')}`, {
        cause: error,
      });
    }
  };

  const stop = async () => {
    await stopChild(child);
    child = null;
  };

  return {
    start,
    stop,
    logs: () => [...stdoutLogs, ...stderrLogs],
    messages: () => [...ipcMessages],
  };
}

async function registerAndLogin(page, baseUrl, user) {
  await page.goto(baseUrl, { timeout: 30_000 });
  await page.getByRole('link', { name: 'Sign up' }).click();
  await page.getByLabel('Full name').fill(user.name);
  await page.getByLabel('Email').fill(user.email);
  await page.getByTestId('password').fill(user.password);
  await page.getByTestId('confirm_password').fill(user.password);
  await page.getByLabel('Submit registration').click();
  await page.waitForURL(/\/c\/new$/, { timeout: 30_000 });
  await page.goto(`${baseUrl}/login`, { timeout: 30_000 });
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByTestId('login-button').click();
  await page.waitForURL(/\/c\/new$/, { timeout: 30_000 });
}

async function getAccessToken(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = await response.json();
    if (!response.ok || !body.token) {
      throw new Error(`Unable to refresh browser token: ${response.status}`);
    }
    return body.token;
  });
}

async function requestJson(page, { path: urlPath, token, method = 'GET', body }) {
  const result = await page.evaluate(async ({ accessToken, bodyValue, requestMethod, pathValue }) => {
    const headers = { Authorization: `Bearer ${accessToken}` };
    const init = { method: requestMethod, credentials: 'include', headers };
    if (bodyValue !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(bodyValue);
    }
    const response = await fetch(pathValue, init);
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  }, {
    accessToken: token,
    bodyValue: body,
    requestMethod: method,
    pathValue: urlPath,
  });
  if (!result.ok) {
    throw new Error(`${method} ${urlPath} failed with ${result.status}: ${result.text}`);
  }
  return result.text ? JSON.parse(result.text) : null;
}

async function createAgent(page, token) {
  return requestJson(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: AGENT_NAME,
      description: 'Isolated Phase 3D-B acceptance agent',
      instructions: 'Handle the current request only.',
      provider: MOCK_ENDPOINT,
      model: MOCK_MODEL,
      tools: ['execute_code'],
      model_parameters: {},
    },
  });
}

async function selectMockEndpoint(page) {
  const trigger = page.getByRole('button', { name: 'Select a model' }).first();
  await trigger.click();
  await page.getByRole('option', { name: MOCK_ENDPOINT }).click();
  const model = page.getByRole('option', { name: MOCK_MODEL, exact: true });
  if (await model.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await model.click();
  }
}

function isGenerationStart(response) {
  const url = new URL(response.url());
  return response.request().method() === 'POST' &&
    url.pathname.startsWith('/api/agents/chat') &&
    !url.pathname.endsWith('/abort') &&
    response.status() === 200;
}

async function sendMessage(page, text) {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.fill(text);
  const [response] = await Promise.all([
    page.waitForResponse(isGenerationStart, { timeout: 30_000 }),
    input.press('Enter'),
  ]);
  return { response, body: await response.json() };
}

async function uploadWorkbook(page, filePath) {
  await page.getByRole('button', { name: 'Attach File Options' }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByText('Upload to Code Environment', { exact: true }).click();
  const chooser = await fileChooserPromise;
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/files' &&
      response.status() === 200,
    { timeout: 60_000 },
  );
  await chooser.setFiles(filePath);
  const response = await responsePromise;
  await page.getByText(path.basename(filePath), { exact: true }).waitFor({ timeout: 30_000 });
  return response.json();
}

async function waitForOutputCard(page, apiController, timeoutMs = 60_000) {
  const output = page.getByRole('button', { name: OUTPUT_NAME, exact: true }).last();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await output.isVisible({ timeout: 100 }).catch(() => false)) {
      return;
    }
    const reconcileError = apiController
      .messages()
      .find((message) => message?.type === 'file-agent-reconcile-error');
    if (reconcileError) {
      throw new Error(`File Agent reconcile failed: ${reconcileError.error}`);
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for output card ${OUTPUT_NAME}`);
}

async function waitForMessageText(page, text, timeoutMs = 30_000) {
  await page
    .getByTestId('messages-view')
    .getByText(text, { exact: true })
    .last()
    .waitFor({ timeout: timeoutMs });
}

async function verifyDownloadCard(page) {
  const button = page.getByRole('button', { name: OUTPUT_NAME, exact: true }).last();
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await button.click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), OUTPUT_NAME);
  assert.equal(await download.failure(), null);
}

async function waitForDelivery(database, conversationId, status = 'completed') {
  return waitFor(
    () => database.collection('file_agent_phase3db_deliveries').findOne({ conversationId, status }),
    `delivery ${conversationId} to reach ${status}`,
    60_000,
    100,
  );
}

async function main() {
  if (requiredEnvironment('FILE_AGENT_PHASE3DB_SCOPE') !== 'non-production') {
    throw new Error('FILE_AGENT_PHASE3DB_SCOPE must equal non-production');
  }
  if (requiredEnvironment('FILE_AGENT_PHASE3DB_CONFIRM') !== CONFIRMATION) {
    throw new Error(`FILE_AGENT_PHASE3DB_CONFIRM must equal ${CONFIRMATION}`);
  }

  const repositoryRoot = path.resolve(
    new URL('../../../', import.meta.url).pathname,
  );
  const upstreamRoot = path.resolve(requiredEnvironment('FILE_AGENT_PHASE3DB_UPSTREAM_ROOT'));
  const { stdout: pinnedRevision } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: upstreamRoot,
  });
  assert.equal(pinnedRevision.trim(), UPSTREAM_PIN);
  const requireUpstream = createRequire(path.join(upstreamRoot, 'package.json'));
  const { MongoMemoryServer } = requireUpstream('mongodb-memory-server');
  const { MongoClient } = requireUpstream('mongodb');
  const { chromium } = requireUpstream('playwright');

  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-phase3db-'));
  const apiPort = await reservePort();
  const runtimePort = await reservePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const configPath = path.join(rootDir, 'librechat.phase3db.yaml');
  const runtimeRequestCounts = new Map();
  const user = {
    name: 'Phase 3D-B User',
    email: `phase3db-${Date.now()}@example.local`,
    password: `Phase3DB-${randomBytes(12).toString('hex')}!`,
  };
  const workbookA = path.join(rootDir, 'runtime-restart.xlsx');
  const workbookB = path.join(rootDir, 'api-restart.xlsx');
  const workbookC = path.join(rootDir, 'native-fallback.xlsx');
  let mongoServer;
  let mongo;
  let database;
  let codeApi;
  let relay;
  let runtimeFactory;
  let apiController;
  let browser;
  let page;
  const browserEvents = [];
  let firstTaskId = null;
  let secondTaskId = null;

  try {
    await mkdir(rootDir, { recursive: true });
    await Promise.all([
      createWorkbook(workbookA, 'runtime-restart'),
      createWorkbook(workbookB, 'api-restart'),
      createWorkbook(workbookC, 'native-fallback'),
    ]);
    await writeFile(configPath, `version: 1.3.11
cache: false
balance:
  enabled: false
transactions:
  enabled: true
endpoints:
  agents:
    capabilities:
      - execute_code
      - artifacts
  custom:
    - name: '${MOCK_ENDPOINT}'
      apiKey: 'isolated-e2e-key'
      baseURL: 'http://127.0.0.1:9/v1'
      models:
        default:
          - '${MOCK_MODEL}'
        fetch: false
      titleConvo: false
      modelDisplayLabel: '${MOCK_ENDPOINT}'
modelSpecs:
  prioritize: false
  enforce: false
  addedEndpoints:
    - '${MOCK_ENDPOINT}'
    - 'agents'
`, 'utf8');

    mongoServer = await MongoMemoryServer.create({
      binary: { version: process.env.FILE_AGENT_PHASE3DB_MONGOD_VERSION ?? '8.2.1' },
      instance: { ip: '127.0.0.1' },
    });
    const databaseName = `librechat_phase3db_${Date.now()}_${process.pid}`;
    const mongoUri = new URL(mongoServer.getUri());
    mongoUri.pathname = `/${databaseName}`;
    mongo = new MongoClient(mongoUri.toString(), { serverSelectionTimeoutMS: 5_000 });
    await mongo.connect();
    database = mongo.db(databaseName);

    codeApi = await new IsolatedCodeApiServer(path.join(rootDir, 'codeapi')).start();
    relay = await new IsolatedModelRelay({
      responseFor: async ({ operation }) => {
        await sleep(1_500);
        return runtimePlan(operation);
      },
    }).start();
    runtimeFactory = createRuntimeFactory({
      rootDir,
      relay,
      codeApi,
      runtimePort,
      requestCounts: runtimeRequestCounts,
    });
    await runtimeFactory.start();

    const environment = apiEnvironment({
      upstreamRoot,
      configPath,
      mongoUri: mongoUri.toString(),
      codeApiBaseUrl: codeApi.baseUrl,
      apiPort,
    });
    apiController = createApiController({
      repositoryRoot,
      upstreamRoot,
      environment,
      runtimeBaseUrl: `http://127.0.0.1:${runtimePort}`,
    });

    process.stdout.write('phase=bootstrap-native-api\n');
    await apiController.start({ bridge: false });
    const launchOptions = { headless: true };
    if (process.env.FILE_AGENT_PHASE3DB_CHROMIUM_EXECUTABLE) {
      launchOptions.executablePath = process.env.FILE_AGENT_PHASE3DB_CHROMIUM_EXECUTABLE;
    } else {
      launchOptions.channel = process.env.FILE_AGENT_PHASE3DB_CHROMIUM_CHANNEL ?? 'chrome';
    }
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ acceptDownloads: true, locale: 'en-US' });
    page = await context.newPage();
    page.on('console', (message) => {
      browserEvents.push({ type: 'console', level: message.type(), text: message.text() });
    });
    page.on('response', (response) => {
      const pathname = new URL(response.url()).pathname;
      if (pathname.includes('/api/agents/chat')) {
        browserEvents.push({ type: 'response', method: response.request().method(), pathname, status: response.status() });
      }
    });
    page.on('requestfailed', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.includes('/api/agents/chat')) {
        browserEvents.push({
          type: 'requestfailed',
          method: request.method(),
          pathname,
          error: request.failure()?.errorText ?? null,
        });
      }
    });
    process.stdout.write('phase=register-browser-user\n');
    await registerAndLogin(page, baseUrl, user);
    const token = await getAccessToken(page);
    const agent = await createAgent(page, token);
    assert.ok(agent.id);
    const userRecord = await database.collection('users').findOne({ email: user.email });
    assert.ok(userRecord?._id);
    const userId = userRecord._id.toString();

    process.stdout.write('phase=enable-file-agent-bridge\n');
    await apiController.stop();
    await apiController.start({ bridge: true, allowlistedUserIds: [userId] });

    process.stdout.write('phase=ordinary-chat-native-path\n');
    await page.goto(`${baseUrl}/c/new`, { timeout: 30_000 });
    await selectMockEndpoint(page);
    const runtimeSubmitsBeforeChat = runtimeRequestCounts.get('POST /v1/tasks') ?? 0;
    await sendMessage(page, 'E2E_REPLY:phase3db-ordinary');
    await waitForMessageText(page, 'E2E reply phase3db-ordinary');
    assert.equal(runtimeRequestCounts.get('POST /v1/tasks') ?? 0, runtimeSubmitsBeforeChat);

    process.stdout.write('phase=runtime-restart-workbook\n');
    await page.goto(`${baseUrl}/c/new?agent_id=${encodeURIComponent(agent.id)}`, { timeout: 30_000 });
    await uploadWorkbook(page, workbookA);
    const firstStart = await sendMessage(page, '读取当前工作簿并生成一个经过验证的 Excel 文件');
    assert.ok(firstStart.body.conversationId);
    await waitFor(
      () => (runtimeRequestCounts.get('POST /v1/tasks') ?? 0) === 1,
      'one Runtime task submission for the first workbook',
    );
    const firstTask = await waitFor(async () => {
      const tasks = await runtimeFactory.current().store.listRecoverableTasks();
      return tasks[0] ?? null;
    }, 'first Runtime task record');
    firstTaskId = firstTask.taskId;
    await runtimeFactory.restart();
    await waitForOutputCard(page, apiController, 90_000);
    await verifyDownloadCard(page);
    const firstDelivery = await waitForDelivery(database, firstStart.body.conversationId);
    assert.equal(firstDelivery.taskId, firstTask.taskId);

    process.stdout.write('phase=api-restart-workbook\n');
    await page.goto(`${baseUrl}/c/new?agent_id=${encodeURIComponent(agent.id)}`, { timeout: 30_000 });
    await uploadWorkbook(page, workbookB);
    const secondStart = await sendMessage(page, '读取第二个工作簿并生成一个经过验证的 Excel 文件');
    assert.ok(secondStart.body.conversationId);
    await waitFor(
      () => (runtimeRequestCounts.get('POST /v1/tasks') ?? 0) === 2,
      'one Runtime task submission for each workbook',
    );
    await waitFor(
      () => database.collection('file_agent_phase3db_deliveries').findOne({
        conversationId: secondStart.body.conversationId,
      }),
      'second durable delivery before API restart',
    );
    const secondTask = await waitFor(async () => {
      const tasks = await runtimeFactory.current().store.listRecoverableTasks();
      return tasks.find((task) => task.taskId !== firstTask.taskId) ?? null;
    }, 'second Runtime task record');
    secondTaskId = secondTask.taskId;
    await apiController.stop();
    await runtimeFactory.current().waitFor(secondTask.taskId, (task) => task.status === 'completed', {
      timeoutMs: 90_000,
    });
    await apiController.start({ bridge: true, allowlistedUserIds: [userId] });
    const secondDelivery = await waitForDelivery(database, secondStart.body.conversationId);
    assert.equal(secondDelivery.taskId, secondTask.taskId);
    await page.goto(`${baseUrl}/c/${secondStart.body.conversationId}`, { timeout: 30_000 });
    await waitForOutputCard(page, apiController, 60_000);

    const countsAfterRecovery = {
      deliveries: await database.collection('file_agent_phase3db_deliveries').countDocuments({}),
      snapshots: await database.collection('file_agent_phase3db_billing_snapshots').countDocuments({}),
      transactions: await database.collection('transactions').countDocuments({ context: 'file_agent' }),
      generatedFiles: await database.collection('files').countDocuments({ filename: OUTPUT_NAME }),
      outputMessages: await database.collection('messages').countDocuments({
        messageId: { $in: [firstDelivery.assistantMessageId, secondDelivery.assistantMessageId] },
      }),
    };
    assert.deepEqual(countsAfterRecovery, {
      deliveries: 2,
      snapshots: 2,
      transactions: 8,
      generatedFiles: 2,
      outputMessages: 2,
    });
    assert.ok([...relay.actualExecutions.values()].every((count) => count === 1));
    assert.ok([...codeApi.actualExecutions.values()].every((count) => count === 1));

    process.stdout.write('phase=bridge-disabled-native-fallback\n');
    await apiController.stop();
    await apiController.start({ bridge: false });
    await page.goto(`${baseUrl}/c/new?agent_id=${encodeURIComponent(agent.id)}`, { timeout: 30_000 });
    await uploadWorkbook(page, workbookC);
    await sendMessage(page, 'E2E_REPLY:phase3db-native-fallback');
    await waitForMessageText(page, 'E2E reply phase3db-native-fallback');
    assert.equal(runtimeRequestCounts.get('POST /v1/tasks') ?? 0, 2);

    process.stdout.write(`${JSON.stringify({
      schemaVersion: '1.0',
      status: 'passed',
      scope: 'non-production',
      upstreamPin: UPSTREAM_PIN,
      libreChatBuild: 'full-packages-and-client',
      browser: launchOptions.channel ?? launchOptions.executablePath,
      ordinaryChatRuntimeTasks: 0,
      bridgedWorkbookUploads: 2,
      runtimeTaskSubmissions: runtimeRequestCounts.get('POST /v1/tasks') ?? 0,
      runtimeRestartRecovered: true,
      apiRestartRecoveredFromMongo: true,
      completionWithoutRefresh: true,
      nativeDownloadCard: true,
      nativeFallbackAfterBridgeRemoval: true,
      duplicateCheck: countsAfterRecovery,
    }, null, 2)}\n`);
  } catch (error) {
    const diagnostics = {
      runtimeRequests: Object.fromEntries(runtimeRequestCounts),
      relayRequests: (relay?.requests ?? []).map(({ callId, operation }) => ({ callId, operation })),
      relayExecutions: Object.fromEntries(relay?.actualExecutions ?? []),
      codeApiUploads: codeApi?.uploads ?? [],
      codeApiRequests: (codeApi?.requests ?? []).map((request) => ({
        itemId: request.item_id,
        artifactPaths: request.artifact_paths,
      })),
      codeApiExecutions: Object.fromEntries(codeApi?.actualExecutions ?? []),
      apiLogs: (apiController?.logs() ?? []).filter((line) =>
        /file-agent|runtime|codeapi|error|warn/i.test(line),
      ),
      apiMessages: apiController?.messages() ?? [],
      browserEvents,
    };
    if (runtimeFactory?.current()) {
      diagnostics.runtimeTasks = {};
      for (const taskId of [firstTaskId, secondTaskId].filter(Boolean)) {
        const task = await runtimeFactory.current().getTask(taskId).catch(() => null);
        const events = await runtimeFactory.current().getEvents(taskId, 0).catch(() => []);
        diagnostics.runtimeTasks[taskId] = {
          task: task == null ? null : {
            taskId: task.taskId,
            status: task.status,
            phase: task.phase,
            planRevision: task.planRevision,
            completedItemIds: task.completedItemIds,
            result: task.result,
            error: task.error,
          },
          events: events.slice(-10),
        };
      }
    }
    if (database) {
      diagnostics.deliveries = await database
        .collection('file_agent_phase3db_deliveries')
        .find({})
        .toArray()
        .catch(() => []);
      diagnostics.files = await database
        .collection('files')
        .find(
          { filename: { $in: [OUTPUT_NAME, path.basename(workbookA), path.basename(workbookB)] } },
          {
            projection: {
              _id: 1,
              file_id: 1,
              filename: 1,
              user: 1,
              conversationId: 1,
              messageId: 1,
              context: 1,
              status: 1,
              previewError: 1,
              metadata: 1,
            },
          },
        )
        .toArray()
        .catch(() => []);
      diagnostics.messages = await database
        .collection('messages')
        .find(
          firstTaskId == null ? { _id: null } : {},
          {
            projection: {
              _id: 1,
              messageId: 1,
              conversationId: 1,
              parentMessageId: 1,
              isCreatedByUser: 1,
              text: 1,
              files: 1,
              attachments: 1,
              unfinished: 1,
              error: 1,
            },
          },
        )
        .toArray()
        .catch(() => []);
    }
    if (page) {
      diagnostics.page = {
        url: page.url(),
        messagesText: await page
          .getByTestId('messages-view')
          .innerText()
          .catch(() => null),
        downloadButtons: await page
          .getByRole('button', { name: /Download/i })
          .allTextContents()
          .catch(() => []),
      };
    }
    throw new Error(
      `${error?.stack ?? error}\nphase3db-diagnostics=${JSON.stringify(diagnostics, null, 2)}`,
      { cause: error },
    );
  } finally {
    await browser?.close().catch(() => {});
    await apiController?.stop().catch(() => {});
    await runtimeFactory?.stop().catch(() => {});
    await relay?.stop().catch(() => {});
    await codeApi?.stop().catch(() => {});
    await mongo?.close().catch(() => {});
    await mongoServer?.stop().catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});

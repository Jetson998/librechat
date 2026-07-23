import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CodeApiHttpTransport } from '../src/codeapi-transport.js';
import { ContextProjector } from '../src/context-projector.js';
import { CodeApiXlsxExecutor, XLSX_MIME } from '../src/deterministic-xlsx.js';
import { FileModelCallJournal } from '../src/model-call-journal.js';
import { OpenAiChatTransport, SingleModelAgentProvider } from '../src/openai-compatible-provider.js';
import { ProviderRouteError } from '../src/provider-adapter.js';
import { FileAgentRuntime } from '../src/runtime.js';
import { FileTaskStore } from '../src/task-store.js';
import { IsolatedCodeApiServer } from '../test/isolated-codeapi.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_FIXTURE = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'phase2b-source.xlsx');
const DEFAULT_RUN_DIR = path.join(PACKAGE_ROOT, '.phase2b');
const FIXTURE_SHA256 = 'f082ebb1a704ed9b65d16e8a44b41b6f07377979e684f4fc7464966a975aedc3';
const CONFIRMATION = 'ONE_NON_PRODUCTION_BILLABLE_TASK';
const ROUTE_ID = 'file-agent-primary';
const CAPABILITY_PROFILE = 'office-planner-v1';
const MAX_CALLS = 2;
const INPUT_BUDGET_TOKENS_PER_CALL = 6_000;
const TOTAL_INPUT_BUDGET_TOKENS = 12_000;
const OUTPUT_BUDGET_TOKENS_PER_CALL = 256;
const TOTAL_OUTPUT_BUDGET_TOKENS = 512;
const CONTEXT_BUDGET_CHARS = 8_000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function normalizeBaseUrl(value) {
  const parsed = new URL(requiredString(value, 'FILE_AGENT_PHASE2B_BASE_URL'));
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('Phase 2B base URL must not contain credentials, query, or fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, '').replace(/\/v1$/i, '');
  return parsed.toString().replace(/\/$/, '');
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') {
    return fallback;
  }
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  throw new TypeError('FILE_AGENT_PHASE2B_SUPPORTS_IDEMPOTENCY must be true or false');
}

function isLoopback(url) {
  const hostname = new URL(url).hostname;
  return ['127.0.0.1', '::1', 'localhost'].includes(hostname);
}

function validateOptions(options) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const apiKey = requiredString(options.apiKey, 'FILE_AGENT_PHASE2B_API_KEY');
  const model = requiredString(options.model, 'FILE_AGENT_PHASE2B_MODEL');
  if (apiKey.length < 8) {
    throw new TypeError('Phase 2B API key is too short');
  }
  if (!options.allowLocalFixture) {
    if (options.confirmation !== CONFIRMATION) {
      throw new TypeError(`FILE_AGENT_PHASE2B_CONFIRM must equal ${CONFIRMATION}`);
    }
    if (options.keyScope !== 'non-production') {
      throw new TypeError('FILE_AGENT_PHASE2B_KEY_SCOPE must equal non-production');
    }
    if (new URL(baseUrl).protocol !== 'https:') {
      throw new TypeError('Real Phase 2B relay must use HTTPS');
    }
  } else if (!isLoopback(baseUrl)) {
    throw new TypeError('Local fixture mode only accepts a loopback relay');
  }
  return {
    ...options,
    apiKey,
    baseUrl,
    model,
    supportsIdempotency: parseBoolean(options.supportsIdempotency, false),
  };
}

function createObservedFetch(fetchImpl = globalThis.fetch) {
  const observations = [];
  const observedFetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const body = JSON.parse(String(init.body ?? '{}'));
    const idempotencyKey = headers.get('idempotency-key');
    const response = await fetchImpl(url, init);
    const responseText = await response.text();
    let responseBody = null;
    try {
      responseBody = JSON.parse(responseText);
    } catch {}
    observations.push({
      request: {
        idempotencyKeyHash: idempotencyKey ? sha256(idempotencyKey) : null,
        metadataFields: Object.keys(body.metadata ?? {}).sort(),
        model: body.model ?? null,
        outputBudgetTokens: body.max_tokens ?? null,
        responseFormatType: body.response_format?.type ?? null,
        temperature: body.temperature ?? null,
      },
      response: {
        status: response.status,
        model: responseBody?.model ?? null,
        usageFields: Object.keys(responseBody?.usage ?? {}).sort(),
        promptDetailFields: Object.keys(responseBody?.usage?.prompt_tokens_details ?? {}).sort(),
      },
    });
    return new Response(responseText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return { observations, observedFetch };
}

class Phase2BInputGuardTransport {
  constructor(delegate) {
    this.delegate = delegate;
  }

  async invoke(args) {
    const estimatedInputTokens = Math.ceil(JSON.stringify({
      operation: args.operation,
      context: args.context,
    }).length / 3);
    if (estimatedInputTokens > INPUT_BUDGET_TOKENS_PER_CALL) {
      throw new ProviderRouteError('Phase 2B estimated input budget exceeded before request');
    }
    if (args.route.outputBudgetTokens > OUTPUT_BUDGET_TOKENS_PER_CALL) {
      throw new ProviderRouteError('Phase 2B output budget exceeds the approved per-call limit');
    }
    return this.delegate.invoke(args);
  }
}

class Phase2BBudgetedProvider {
  constructor(delegate) {
    this.delegate = delegate;
    this.attemptedCalls = 0;
    this.journaledCalls = 0;
    this.completedCalls = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.budgetExceeded = false;
  }

  plan(args) {
    return this.#invoke('plan', args);
  }

  repair(args) {
    return this.#invoke('repair', args);
  }

  async #invoke(operation, args) {
    if (this.attemptedCalls >= MAX_CALLS) {
      throw new ProviderRouteError(`Phase 2B call budget exceeded: ${MAX_CALLS}`);
    }
    this.attemptedCalls += 1;
    const result = await this.delegate[operation](args);
    this.journaledCalls += 1;
    this.totalInputTokens += result.usage.inputTokens;
    this.totalOutputTokens += result.usage.outputTokens;
    if (
      result.usage.inputTokens > INPUT_BUDGET_TOKENS_PER_CALL ||
      this.totalInputTokens > TOTAL_INPUT_BUDGET_TOKENS ||
      result.usage.outputTokens > OUTPUT_BUDGET_TOKENS_PER_CALL ||
      this.totalOutputTokens > TOTAL_OUTPUT_BUDGET_TOKENS
    ) {
      this.budgetExceeded = true;
      throw new ProviderRouteError('Phase 2B provider usage exceeded the approved budget');
    }
    this.completedCalls += 1;
    return result;
  }

  snapshot() {
    return {
      attemptedCalls: this.attemptedCalls,
      journaledCalls: this.journaledCalls,
      completedCalls: this.completedCalls,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      budgetExceeded: this.budgetExceeded,
    };
  }
}

async function listFiles(rootDir) {
  const results = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        results.push(target);
      }
    }
  }
  await visit(rootDir);
  return results;
}

async function assertSecretsNotPersisted(rootDir, secrets) {
  const needles = secrets.filter(Boolean).map((value) => Buffer.from(value));
  for (const filePath of await listFiles(rootDir)) {
    const contents = await readFile(filePath);
    if (needles.some((needle) => contents.includes(needle))) {
      throw new Error(`Phase 2B secret or relay URL was persisted in ${path.basename(filePath)}`);
    }
  }
}

function usageTotals(task) {
  return (task.usageRecords ?? []).reduce(
    (totals, usage) => ({
      inputTokens: totals.inputTokens + usage.inputTokens,
      cacheReadTokens: totals.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens + usage.cacheWriteTokens,
      outputTokens: totals.outputTokens + usage.outputTokens,
    }),
    { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  );
}

function buildReport({ task, observations, budget, fixtureHash, startedAt, finishedAt, supportsIdempotency }) {
  const successfulObservations = observations.filter(
    (entry) => entry.response.status >= 200 && entry.response.status < 300,
  );
  return {
    schemaVersion: '1.0',
    phase: '2B',
    mode: 'one-shot-non-production-contract',
    startedAt,
    finishedAt,
    elapsedMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    task: {
      taskId: task.taskId,
      status: task.status,
      planRevision: task.planRevision,
      usageEventCount: task.usageRecords?.length ?? 0,
      artifactCount: task.result?.artifacts?.length ?? 0,
      error: task.error ? { code: task.error.code ?? null, name: task.error.name } : null,
    },
    route: {
      modelRouteId: ROUTE_ID,
      providerModels: [...new Set((task.usageRecords ?? []).map((usage) => usage.providerModel))],
      capabilityProfile: CAPABILITY_PROFILE,
      operatorDeclaredIdempotency: supportsIdempotency,
    },
    fixture: {
      name: 'phase2b-source.xlsx',
      sha256: fixtureHash,
      customerData: false,
    },
    budgets: {
      maxCalls: MAX_CALLS,
      inputTokensPerCall: INPUT_BUDGET_TOKENS_PER_CALL,
      totalInputTokens: TOTAL_INPUT_BUDGET_TOKENS,
      outputTokensPerCall: OUTPUT_BUDGET_TOKENS_PER_CALL,
      totalOutputTokens: TOTAL_OUTPUT_BUDGET_TOKENS,
      contextCharacters: CONTEXT_BUDGET_CHARS,
      observed: budget,
    },
    usage: usageTotals(task),
    contract: {
      requestCount: observations.length,
      chatCompletionsAccepted: successfulObservations.length > 0,
      responseFormatAccepted:
        successfulObservations.length > 0 &&
        successfulObservations.every(
          (entry) => entry.request.responseFormatType === 'json_object',
        ),
      metadataAccepted:
        successfulObservations.length > 0 &&
        successfulObservations.every(
          (entry) =>
            entry.request.metadataFields.includes('call_id') &&
            entry.request.metadataFields.includes('operation'),
        ),
      idempotencyHeaderSent:
        observations.length > 0 &&
        observations.every((entry) => entry.request.idempotencyKeyHash != null),
      usagePresent:
        successfulObservations.length > 0 &&
        successfulObservations.every(
          (entry) =>
            entry.response.usageFields.includes('prompt_tokens') &&
            entry.response.usageFields.includes('completion_tokens'),
        ),
      cacheUsageFieldObserved: successfulObservations.some(
        (entry) => entry.response.promptDetailFields.includes('cached_tokens') ||
          entry.response.usageFields.includes('cache_read_tokens') ||
          entry.response.usageFields.includes('cache_creation_input_tokens'),
      ),
      observations,
    },
    quality: {
      completed: task.status === 'completed',
      verifiedArtifact: task.verification?.passed === true && task.result?.artifacts?.length === 1,
      actionKinds: (task.completedItemIds ?? [])
        .filter((itemId) => itemId.includes(':execute:'))
        .map((itemId) => task.itemResults?.[itemId]?.actionKind)
        .filter(Boolean),
    },
    persistence: {
      containsApiKey: false,
      containsRelayUrl: false,
      libreChatTransactionsWritten: false,
    },
  };
}

export async function runPhase2B(rawOptions) {
  const options = validateOptions(rawOptions);
  const runDir = path.resolve(options.runDir ?? DEFAULT_RUN_DIR);
  const fixturePath = path.resolve(options.fixturePath ?? DEFAULT_FIXTURE);
  const fixtureInfo = await stat(fixturePath);
  if (!fixtureInfo.isFile()) {
    throw new TypeError('Phase 2B fixture must be a file');
  }
  const fixtureHash = await sha256File(fixturePath);
  if (fixtureHash !== FIXTURE_SHA256) {
    throw new Error('Phase 2B repository fixture hash does not match the approved fixture');
  }
  await mkdir(runDir, { recursive: true });

  const observed = createObservedFetch(options.fetchImpl);
  const guardedTransport = new Phase2BInputGuardTransport(
    new OpenAiChatTransport({ fetchImpl: observed.observedFetch, timeoutMs: 60_000 }),
  );
  const codeApi = await new IsolatedCodeApiServer(path.join(runDir, 'codeapi')).start();
  const sessionId = 'phase2b-isolated-session';
  const fileId = 'phase2b-repository-fixture';
  await codeApi.registerFile({
    sessionId,
    fileId,
    name: 'phase2b-source.xlsx',
    sourcePath: fixturePath,
  });

  const store = new FileTaskStore(path.join(runDir, 'runtime'));
  const budgetedProvider = new Phase2BBudgetedProvider(
    new SingleModelAgentProvider({
      routes: {
        [ROUTE_ID]: {
          baseUrl: options.baseUrl,
          model: options.model,
          apiKey: options.apiKey,
          capabilityProfile: CAPABILITY_PROFILE,
          supportsIdempotency: options.supportsIdempotency,
          outputBudgetTokens: OUTPUT_BUDGET_TOKENS_PER_CALL,
        },
      },
      transport: guardedTransport,
      journal: new FileModelCallJournal(path.join(runDir, 'provider-journal')),
      projector: new ContextProjector({ maxChars: CONTEXT_BUDGET_CHARS }),
    }),
  );
  const runtime = new FileAgentRuntime({
    store,
    provider: budgetedProvider,
    executor: new CodeApiXlsxExecutor({
      transport: new CodeApiHttpTransport({ baseUrl: codeApi.baseUrl }),
    }),
  });

  const startedAt = new Date().toISOString();
  try {
    await runtime.start();
    const submitted = await runtime.submit({
      idempotencyKey: `phase2b:${FIXTURE_SHA256}:contract-v1`,
      manifest: {
        schemaVersion: '1.0',
        taskContractVersion: 'office-file-agent.v1',
        taskType: 'office_transform',
        intent: 'Use the approved single model route to plan one deterministic repository XLSX transform',
        acceptance: [
          'Return exactly one verified XLSX artifact',
          'Reuse the persisted workbook worker and apply only the bounded repair action',
        ],
        model: {
          modelRouteId: ROUTE_ID,
          capabilityProfile: CAPABILITY_PROFILE,
        },
        execution: {
          executor: 'codeapi',
          sessionId,
          workspaceRoot: '/mnt/data/.agent/{taskId}',
        },
        inputs: [
          {
            logicalName: 'phase2b-source.xlsx',
            sha256: fixtureHash,
            mimeType: XLSX_MIME,
            codeEnvRef: {
              storage_session_id: sessionId,
              file_id: fileId,
            },
          },
        ],
        limits: {
          maxVisibleArtifacts: 1,
          maxModelCalls: MAX_CALLS,
          inputBudgetTokens: TOTAL_INPUT_BUDGET_TOKENS,
          outputBudgetTokens: TOTAL_OUTPUT_BUDGET_TOKENS,
        },
      },
    });
    const task = await runtime.waitFor(
      submitted.task.taskId,
      (current) => ['completed', 'failed', 'needs_input', 'canceled'].includes(current.status),
      { timeoutMs: 180_000, intervalMs: 50 },
    );
    const finishedAt = new Date().toISOString();
    await assertSecretsNotPersisted(runDir, [options.apiKey, options.baseUrl]);
    const reportPath = path.join(runDir, 'phase2b-report.json');
    if (observed.observations.length === 0) {
      try {
        const existingReport = JSON.parse(await readFile(reportPath, 'utf8'));
        if (existingReport?.task?.taskId === task.taskId) {
          return existingReport;
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      }
    }
    const report = buildReport({
      task,
      observations: observed.observations,
      budget: budgetedProvider.snapshot(),
      fixtureHash,
      startedAt,
      finishedAt,
      supportsIdempotency: options.supportsIdempotency,
    });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return report;
  } finally {
    await runtime.stop();
    await codeApi.stop();
  }
}

function optionsFromEnvironment() {
  return {
    baseUrl: process.env.FILE_AGENT_PHASE2B_BASE_URL,
    apiKey: process.env.FILE_AGENT_PHASE2B_API_KEY,
    model: process.env.FILE_AGENT_PHASE2B_MODEL,
    confirmation: process.env.FILE_AGENT_PHASE2B_CONFIRM,
    keyScope: process.env.FILE_AGENT_PHASE2B_KEY_SCOPE,
    supportsIdempotency: process.env.FILE_AGENT_PHASE2B_SUPPORTS_IDEMPOTENCY,
    runDir: process.env.FILE_AGENT_PHASE2B_RUN_DIR,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runPhase2B(optionsFromEnvironment())
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.task.status === 'completed' ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(`Phase 2B stopped: ${error?.message ?? String(error)}\n`);
      process.exitCode = 1;
    });
}

export const PHASE2B_CONFIRMATION = CONFIRMATION;
export const PHASE2B_FIXTURE_SHA256 = FIXTURE_SHA256;

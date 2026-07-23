import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { LibreChatCodeApiTransport } from '../../file-agent-runtime/src/librechat-codeapi-transport.js';
import { OpenAiChatTransport } from '../../file-agent-runtime/src/openai-compatible-provider.js';
import { ProviderRouteError } from '../../file-agent-runtime/src/provider-adapter.js';
import { runPhase3DAcceptance } from './phase3d-nonproduction-acceptance.js';

const CONFIRMATION = 'ONE_EXTERNAL_NON_PRODUCTION_TASK';
const FIXTURE_SHA256 = 'f082ebb1a704ed9b65d16e8a44b41b6f07377979e684f4fc7464966a975aedc3';
const MAX_MODEL_CALLS = 2;
const INPUT_TOKENS_PER_CALL = 6_000;
const TOTAL_INPUT_TOKENS = 12_000;
const OUTPUT_TOKENS_PER_CALL = 256;
const TOTAL_OUTPUT_TOKENS = 512;
const MAX_CODEAPI_EXEC_CALLS = 7;
const CODEAPI_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 180_000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function parseBoolean(value, name) {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${name} must equal true or false`);
}

function normalizeExternalUrl(value, name, { allowLoopback = false, stripV1 = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  const parsed = new URL(value.trim());
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain credentials, query, or fragment`);
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(allowLoopback && loopback && parsed.protocol === 'http:')) {
    throw new Error(`${name} must use HTTPS${allowLoopback ? ' or loopback HTTP' : ''}`);
  }
  const normalized = parsed.toString().replace(/\/$/, '');
  return stripV1 ? normalized.replace(/\/v1$/i, '') : normalized;
}

function createObservedModelFetch(fetchImpl = globalThis.fetch) {
  const observations = [];
  const observedFetch = async (url, init) => {
    const startedAt = Date.now();
    const response = await fetchImpl(url, init);
    const responseText = await response.text();
    let body;
    try {
      body = JSON.parse(responseText);
    } catch {}
    observations.push({
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      model: body?.model ?? null,
      usageFields: Object.keys(body?.usage ?? {}).sort(),
      promptDetailFields: Object.keys(body?.usage?.prompt_tokens_details ?? {}).sort(),
    });
    return new Response(responseText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return { observations, observedFetch };
}

class BudgetedProvider {
  constructor(delegate) {
    this.delegate = delegate;
    this.attemptedCalls = 0;
    this.journaledCalls = 0;
    this.completedCalls = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.budgetExceeded = false;
  }

  plan(args) {
    return this.#invoke('plan', args);
  }

  repair(args) {
    return this.#invoke('repair', args);
  }

  async #invoke(operation, args) {
    if (this.attemptedCalls >= MAX_MODEL_CALLS) {
      throw new ProviderRouteError(`Phase 3D-C model call budget exceeded: ${MAX_MODEL_CALLS}`);
    }
    this.attemptedCalls += 1;
    let result;
    try {
      result = await this.delegate[operation](args);
    } catch (error) {
      if (error?.receipt?.usage) {
        this.#record(error.receipt.usage);
      }
      throw error;
    }
    this.#record(result.usage);
    this.completedCalls += 1;
    return result;
  }

  #record(usage) {
    this.journaledCalls += 1;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    if (
      usage.inputTokens > INPUT_TOKENS_PER_CALL ||
      this.inputTokens > TOTAL_INPUT_TOKENS ||
      usage.outputTokens > OUTPUT_TOKENS_PER_CALL ||
      this.outputTokens > TOTAL_OUTPUT_TOKENS
    ) {
      this.budgetExceeded = true;
      throw new ProviderRouteError('Phase 3D-C provider usage exceeded the approved budget');
    }
  }

  snapshot() {
    return {
      attemptedCalls: this.attemptedCalls,
      journaledCalls: this.journaledCalls,
      completedCalls: this.completedCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      budgetExceeded: this.budgetExceeded,
    };
  }
}

class BudgetedCodeApiTransport {
  constructor(delegate) {
    this.delegate = delegate;
    this.calls = [];
  }

  async execute(request) {
    if (this.calls.length >= MAX_CODEAPI_EXEC_CALLS) {
      throw new Error(`Phase 3D-C CodeAPI call budget exceeded: ${MAX_CODEAPI_EXEC_CALLS}`);
    }
    const observation = {
      itemIdHash: sha256(request.itemId),
      operation: request.itemId === 'phase3dc-codeapi-preflight'
        ? 'preflight'
        : request.artifactPaths?.length
          ? 'publish'
          : 'execute',
      elapsedMs: null,
      status: 'started',
    };
    this.calls.push(observation);
    const startedAt = Date.now();
    try {
      const result = await this.delegate.execute(request);
      observation.elapsedMs = Date.now() - startedAt;
      observation.status = 'completed';
      observation.artifactCount = result.artifacts.length;
      return result;
    } catch (error) {
      observation.elapsedMs = Date.now() - startedAt;
      observation.status = 'failed';
      observation.errorCode = error?.code ?? error?.name ?? 'UNKNOWN';
      throw error;
    }
  }
}

async function listFiles(rootDir) {
  const results = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
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
      throw new Error(`Phase 3D-C secret or external URL was persisted in ${path.basename(filePath)}`);
    }
  }
}

async function downloadArtifact({ baseUrl, headers, resourceId, artifact }) {
  const query = new URLSearchParams({ kind: 'user', id: resourceId });
  const response = await fetch(
    `${baseUrl}/download/${encodeURIComponent(artifact.codeEnvRef.storage_session_id)}/` +
      `${encodeURIComponent(artifact.codeEnvRef.file_id)}?${query}`,
    { headers },
  );
  if (!response.ok) {
    throw new Error(`Phase 3D-C artifact download returned HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return { bytes: buffer.length, sha256: sha256(buffer) };
}

async function main() {
  if (requiredEnvironment('FILE_AGENT_PHASE3DC_SCOPE') !== 'non-production') {
    throw new Error('FILE_AGENT_PHASE3DC_SCOPE must equal non-production');
  }
  if (requiredEnvironment('FILE_AGENT_PHASE3DC_CONFIRM') !== CONFIRMATION) {
    throw new Error(`FILE_AGENT_PHASE3DC_CONFIRM must equal ${CONFIRMATION}`);
  }
  if (requiredEnvironment('FILE_AGENT_PHASE3DC_KEY_SCOPE') !== 'non-production') {
    throw new Error('FILE_AGENT_PHASE3DC_KEY_SCOPE must equal non-production');
  }

  const modelBaseUrl = normalizeExternalUrl(
    process.env.FILE_AGENT_PHASE3DC_MODEL_BASE_URL,
    'FILE_AGENT_PHASE3DC_MODEL_BASE_URL',
    { stripV1: true },
  );
  const codeApiBaseUrl = normalizeExternalUrl(
    process.env.FILE_AGENT_PHASE3DC_CODEAPI_BASE_URL,
    'FILE_AGENT_PHASE3DC_CODEAPI_BASE_URL',
    { allowLoopback: true },
  );
  const modelApiKey = requiredEnvironment('FILE_AGENT_PHASE3DC_MODEL_API_KEY');
  const codeApiToken = requiredEnvironment('FILE_AGENT_PHASE3DC_CODEAPI_BEARER_TOKEN');
  if (modelApiKey.length < 8 || codeApiToken.length < 8) {
    throw new Error('Phase 3D-C test credentials are too short');
  }
  const model = requiredEnvironment('FILE_AGENT_PHASE3DC_MODEL');
  const sessionId = requiredEnvironment('FILE_AGENT_PHASE3DC_CODEAPI_SESSION_ID');
  const codeFileId = requiredEnvironment('FILE_AGENT_PHASE3DC_CODEAPI_FILE_ID');
  const resourceId = requiredEnvironment('FILE_AGENT_PHASE3DC_CODEAPI_RESOURCE_ID');
  const supportsIdempotency = parseBoolean(
    requiredEnvironment('FILE_AGENT_PHASE3DC_MODEL_SUPPORTS_IDEMPOTENCY'),
    'FILE_AGENT_PHASE3DC_MODEL_SUPPORTS_IDEMPOTENCY',
  );
  const headers = { authorization: `Bearer ${codeApiToken}` };
  const fixturePath = path.resolve(
    'services/file-agent-runtime/test/fixtures/phase2b-source.xlsx',
  );
  if (sha256(await readFile(fixturePath)) !== FIXTURE_SHA256) {
    throw new Error('Phase 3D-C repository fixture hash does not match the approved fixture');
  }

  process.env.FILE_AGENT_PHASE3D_SCOPE = 'non-production';
  process.env.FILE_AGENT_PHASE3D_CONFIRM = CONFIRMATION;
  for (const suffix of ['NODE_MODULES', 'MONGO_MODE', 'MONGO_URI', 'MONGOD_VERSION']) {
    const value = process.env[`FILE_AGENT_PHASE3DC_${suffix}`];
    if (value) {
      process.env[`FILE_AGENT_PHASE3D_${suffix}`] = value;
    }
  }

  let modelBudget;
  let modelObservations;
  let codeApiBudget;
  let artifactReceipt;
  let tokenUsage;
  const startedAt = Date.now();
  const report = await runPhase3DAcceptance({
    confirmation: CONFIRMATION,
    taskTimeoutMs: TOTAL_TIMEOUT_MS - CODEAPI_TIMEOUT_MS,
    createDependencies: async ({ rootDir }) => {
      const observedModel = createObservedModelFetch();
      modelObservations = observedModel.observations;
      const nativeCodeApi = new LibreChatCodeApiTransport({
        baseUrl: codeApiBaseUrl,
        headers,
        resourceKind: 'user',
        resourceId,
        timeoutMs: CODEAPI_TIMEOUT_MS,
      });
      codeApiBudget = new BudgetedCodeApiTransport(nativeCodeApi);
      const preflight = await codeApiBudget.execute({
        itemId: 'phase3dc-codeapi-preflight',
        sessionId,
        command: 'sha256sum /mnt/data/source.xlsx',
        injectedFiles: [{
          name: 'source.xlsx',
          storage_session_id: sessionId,
          file_id: codeFileId,
        }],
        timeoutMs: CODEAPI_TIMEOUT_MS,
      });
      if (!preflight.stdout.includes(FIXTURE_SHA256)) {
        throw new Error('Phase 3D-C CodeAPI fixture hash did not match the repository fixture');
      }
      return {
        sessionId,
        codeFileId,
        resourceKind: 'user',
        resourceId,
        userId: resourceId,
        tenantId: 'phase3dc-non-production',
        billingModel: model,
        providerRoute: {
          baseUrl: modelBaseUrl,
          model,
          apiKey: modelApiKey,
          capabilityProfile: 'office-planner-v1',
          supportsIdempotency,
          structuredOutputMode: 'json_schema',
          outputBudgetTokens: OUTPUT_TOKENS_PER_CALL,
          timeoutMs: 60_000,
        },
        providerTransport: new OpenAiChatTransport({
          fetchImpl: observedModel.observedFetch,
          timeoutMs: 60_000,
        }),
        executorTransport: codeApiBudget,
        executorTimeoutMs: CODEAPI_TIMEOUT_MS,
        wrapProvider(provider) {
          modelBudget = new BudgetedProvider(provider);
          return modelBudget;
        },
        async assertCompleted({ ports }) {
          if (modelBudget.snapshot().attemptedCalls !== MAX_MODEL_CALLS) {
            throw new Error('Phase 3D-C did not execute the expected two bounded model calls');
          }
          if (codeApiBudget.calls.length !== MAX_CODEAPI_EXEC_CALLS) {
            throw new Error('Phase 3D-C did not execute the expected bounded CodeAPI call sequence');
          }
          const artifact = [...ports.files.values()][0];
          tokenUsage = [...ports.transactions.values()].reduce(
            (totals, transaction) => ({
              inputTokens: totals.inputTokens + (transaction.inputTokens ?? 0),
              cacheReadTokens: totals.cacheReadTokens + (transaction.cacheReadTokens ?? 0),
              cacheWriteTokens: totals.cacheWriteTokens + (transaction.cacheWriteTokens ?? 0),
              outputTokens: totals.outputTokens + (transaction.outputTokens ?? 0),
            }),
            { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
          );
          artifactReceipt = await downloadArtifact({
            baseUrl: codeApiBaseUrl,
            headers,
            resourceId,
            artifact,
          });
          await assertSecretsNotPersisted(rootDir, [
            modelApiKey,
            codeApiToken,
            modelBaseUrl,
            codeApiBaseUrl,
          ]);
        },
        report: {
          modelRelay: 'external-non-production-openai-compatible',
          codeApi: 'external-non-production-librechat-protocol',
        },
      };
    },
  });

  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > TOTAL_TIMEOUT_MS) {
    throw new Error(`Phase 3D-C total wall-clock budget exceeded: ${elapsedMs} ms`);
  }
  const finalReport = {
    ...report,
    phase: '3D-C',
    elapsedMs,
    model: {
      name: model,
      budget: modelBudget.snapshot(),
      observations: modelObservations,
      usage: tokenUsage,
    },
    codeApiContract: {
      execCalls: codeApiBudget.calls,
      maxExecCalls: MAX_CODEAPI_EXEC_CALLS,
      timeoutMs: CODEAPI_TIMEOUT_MS,
    },
    artifact: {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ...artifactReceipt,
    },
    persistence: {
      containsCredentials: false,
      containsExternalUrls: false,
      containsRawModelOutput: false,
      containsCustomerFiles: false,
    },
    productionAuthorized: false,
  };
  process.stdout.write(`${JSON.stringify(finalReport, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});

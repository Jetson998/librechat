import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CodeApiHttpTransport } from './codeapi-transport.js';
import { ContextProjector } from './context-projector.js';
import { CodeApiOfficeComposeV1Executor } from './deterministic-office-compose-v1.js';
import { CodeApiPptxV1Executor, PPTX_MIME } from './deterministic-pptx-v1.js';
import { CodeApiXlsxV1Executor, XLSX_MIME } from './deterministic-xlsx-v1.js';
import { CodeApiWordExecutor, DOCX_MIME } from './deterministic-word.js';
import { createRuntimeHttpServer } from './http-server.js';
import { FileModelCallJournal } from './model-call-journal.js';
import { CodeApiOfficeExecutor } from './office-executor.js';
import { OpenAiChatTransport, SingleModelAgentProvider } from './openai-compatible-provider.js';
import { loadProductionRuntimeConfig } from './production-config.js';
import { FileAgentRuntime } from './runtime.js';
import { FileTaskStore } from './task-store.js';
import {
  ServiceScopeSigner,
  createRuntimeAuthorizer,
} from '../../librechat-file-agent-connector/src/service-scope.js';

export const PRODUCTION_RUNTIME_CAPABILITIES = Object.freeze({
  schemaVersion: '1.0',
  taskContractVersions: ['office-file-agent.v1.1', 'office-file-agent.v1.2'],
  taskTypes: ['office_transform'],
  capabilityProfiles: ['word-edit-v1', 'xlsx-edit-v1', 'pptx-edit-v1', 'office-compose-v1'],
  inputMimeTypes: [DOCX_MIME, XLSX_MIME, PPTX_MIME],
  outputMimeTypes: [DOCX_MIME, XLSX_MIME, PPTX_MIME],
  maxInputFiles: 2,
  maxVisibleArtifacts: 1,
});

const PROFILE_ROUTE_SUFFIXES = Object.freeze({
  'word-edit-v1': '',
  'xlsx-edit-v1': '-xlsx',
  'pptx-edit-v1': '-pptx',
  'office-compose-v1': '-compose',
});

function requiredConfig(config, key) {
  if (!config || typeof config !== 'object' || config[key] == null) {
    throw new TypeError(`Production Runtime config.${key} is required`);
  }
  return config[key];
}

function listen(server, { host, port }) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Creates the multi-capability production Runtime without starting a network listener. */
export function createProductionRuntime(config, { store = null, journal = null } = {}) {
  requiredConfig(config, 'dataDir');
  const modelRoute = requiredConfig(config, 'modelRoute');
  const codeApi = requiredConfig(config, 'codeApi');
  const providerJournal = journal ?? new FileModelCallJournal(
    path.join(config.dataDir, 'provider-journal'),
  );
  const routes = Object.fromEntries(
    Object.entries(PROFILE_ROUTE_SUFFIXES).map(([capabilityProfile, suffix]) => [
      `${modelRoute.routeId}${suffix}`,
      { ...modelRoute, routeId: `${modelRoute.routeId}${suffix}`, capabilityProfile },
    ]),
  );
  const provider = new SingleModelAgentProvider({
    routes,
    transport: new OpenAiChatTransport(),
    journal: providerJournal,
    projector: new ContextProjector({ maxChars: config.maxContextChars }),
  });
  const transport = new CodeApiHttpTransport({
    baseUrl: codeApi.baseUrl,
    timeoutMs: codeApi.timeoutMs,
  });
  const executor = new CodeApiOfficeExecutor({
    wordExecutor: new CodeApiWordExecutor({ transport, timeoutMs: codeApi.timeoutMs }),
    xlsxExecutor: new CodeApiXlsxV1Executor({ transport, timeoutMs: codeApi.timeoutMs }),
    pptxExecutor: new CodeApiPptxV1Executor({ transport, timeoutMs: codeApi.timeoutMs }),
    composeExecutor: new CodeApiOfficeComposeV1Executor({
      transport,
      timeoutMs: codeApi.timeoutMs,
    }),
  });
  return new FileAgentRuntime({
    store: store ?? new FileTaskStore(path.join(config.dataDir, 'tasks')),
    provider,
    executor,
    maxConcurrentTasks: config.maxConcurrentTasks,
    enabledCapabilityProfiles: new Set(PRODUCTION_RUNTIME_CAPABILITIES.capabilityProfiles),
    enabledTaskContractVersions: new Set(PRODUCTION_RUNTIME_CAPABILITIES.taskContractVersions),
  });
}

export function productionModelRouteId(baseRouteId, capabilityProfile) {
  if (typeof baseRouteId !== 'string' || baseRouteId.trim() === '') {
    throw new TypeError('baseRouteId is required');
  }
  const suffix = PROFILE_ROUTE_SUFFIXES[capabilityProfile];
  if (suffix == null) {
    throw new TypeError(`Unsupported production capability profile: ${capabilityProfile}`);
  }
  return `${baseRouteId.trim()}${suffix}`;
}

export function createProductionRuntimeServer(runtime, config) {
  const serviceScope = requiredConfig(config, 'serviceScope');
  const signer = new ServiceScopeSigner({
    secret: serviceScope.secret,
    ttlSeconds: serviceScope.ttlSeconds,
  });
  return createRuntimeHttpServer(runtime, {
    capabilities: PRODUCTION_RUNTIME_CAPABILITIES,
    authorizeRequest: createRuntimeAuthorizer(signer),
    healthResponse: {
      status: 'ok',
      mode: 'production',
      capabilityProfiles: PRODUCTION_RUNTIME_CAPABILITIES.capabilityProfiles,
    },
  });
}

export async function startProductionRuntime({ config = null, attachSignalHandlers = true } = {}) {
  const resolvedConfig = config ?? await loadProductionRuntimeConfig();
  const runtime = createProductionRuntime(resolvedConfig);
  await runtime.start();
  const server = createProductionRuntimeServer(runtime, resolvedConfig);
  try {
    await listen(server, resolvedConfig);
  } catch (error) {
    await runtime.stop().catch(() => {});
    throw error;
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    await closeServer(server).catch(() => {});
    await runtime.stop();
  };
  if (attachSignalHandlers) {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        stop()
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      });
    }
  }
  return { config: resolvedConfig, runtime, server, stop };
}

async function main() {
  const instance = await startProductionRuntime();
  process.stdout.write(
    `File Agent Runtime production server listening on ${instance.config.host}:${instance.config.port}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`File Agent Runtime production startup failed: ${error.safeSummary ?? error.message}\n`);
    process.exit(1);
  });
}

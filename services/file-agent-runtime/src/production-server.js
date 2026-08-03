import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CodeApiHttpTransport } from './codeapi-transport.js';
import { ContextProjector } from './context-projector.js';
import { CodeApiWordExecutor, DOCX_MIME } from './deterministic-word.js';
import { createRuntimeHttpServer } from './http-server.js';
import { FileModelCallJournal } from './model-call-journal.js';
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
  taskContractVersions: ['office-file-agent.v1.1'],
  taskTypes: ['office_transform'],
  capabilityProfiles: ['word-edit-v1'],
  inputMimeTypes: [DOCX_MIME],
  outputMimeTypes: [DOCX_MIME],
  maxInputFiles: 1,
  maxVisibleArtifacts: 1,
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

/** Creates the Word-only production Runtime without starting a network listener. */
export function createProductionRuntime(config, { store = null, journal = null } = {}) {
  requiredConfig(config, 'dataDir');
  const modelRoute = requiredConfig(config, 'modelRoute');
  const codeApi = requiredConfig(config, 'codeApi');
  const providerJournal = journal ?? new FileModelCallJournal(
    path.join(config.dataDir, 'provider-journal'),
  );
  const provider = new SingleModelAgentProvider({
    routes: { [modelRoute.routeId]: modelRoute },
    transport: new OpenAiChatTransport(),
    journal: providerJournal,
    projector: new ContextProjector({ maxChars: config.maxContextChars }),
  });
  const executor = new CodeApiWordExecutor({
    transport: new CodeApiHttpTransport({
      baseUrl: codeApi.baseUrl,
      timeoutMs: codeApi.timeoutMs,
    }),
    timeoutMs: codeApi.timeoutMs,
  });
  return new FileAgentRuntime({
    store: store ?? new FileTaskStore(path.join(config.dataDir, 'tasks')),
    provider,
    executor,
    maxConcurrentTasks: config.maxConcurrentTasks,
    enabledCapabilityProfiles: new Set(['word-edit-v1']),
    enabledTaskContractVersions: new Set(['office-file-agent.v1.1']),
  });
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

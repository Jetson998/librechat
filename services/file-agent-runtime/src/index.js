import path from 'node:path';

import { FakeExecutor, FakeProvider } from './fake-adapters.js';
import { createRuntimeHttpServer } from './http-server.js';
import { FileAgentRuntime } from './runtime.js';
import { FileTaskStore } from './task-store.js';

const host = process.env.FILE_AGENT_HOST ?? '127.0.0.1';
const port = Number(process.env.FILE_AGENT_PORT ?? 8790);
const dataDir = path.resolve(process.env.FILE_AGENT_DATA_DIR ?? './.data');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('FILE_AGENT_PORT must be an integer between 1 and 65535');
}

const store = new FileTaskStore(dataDir);
const runtime = new FileAgentRuntime({
  store,
  provider: new FakeProvider(),
  executor: new FakeExecutor(),
});

await runtime.start();
const server = createRuntimeHttpServer(runtime);

server.listen(port, host, () => {
  process.stdout.write(
    `File Agent Runtime development server listening on http://${host}:${port} with dataDir=${dataDir}\n`,
  );
});

async function shutdown(signal) {
  process.stdout.write(`Received ${signal}; stopping development runtime\n`);
  server.close();
  await runtime.stop();
}

process.once('SIGINT', () => {
  shutdown('SIGINT').finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  shutdown('SIGTERM').finally(() => process.exit(0));
});

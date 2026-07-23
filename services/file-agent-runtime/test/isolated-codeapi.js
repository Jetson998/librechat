import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { XLSX_MIME } from '../src/deterministic-xlsx.js';

const BODY_LIMIT = 1024 * 1024;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > BODY_LIMIT) {
      throw new Error('request body too large');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function respond(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body)}\n`);
}

function runCommand(command, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-lc', command],
      {
        cwd,
        env: { ...process.env },
        maxBuffer: 4 * 1024 * 1024,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        const exitCode = error ? (Number.isInteger(error.code) ? error.code : 1) : 0;
        resolve({ exitCode, stdout, stderr });
      },
    );
  });
}

export class IsolatedCodeApiServer {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.resultsDir = path.join(this.rootDir, 'idempotency');
    this.sessionsDir = path.join(this.rootDir, 'sessions');
    this.allowedSessions = new Set();
    this.registeredFiles = new Map();
    this.actualExecutions = new Map();
    this.requests = [];
    this.server = createServer((request, response) => this.#handle(request, response));
  }

  async start() {
    await mkdir(this.resultsDir, { recursive: true });
    await mkdir(this.sessionsDir, { recursive: true });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async stop() {
    if (!this.server.listening) {
      return;
    }
    this.server.closeIdleConnections?.();
    this.server.closeAllConnections?.();
    await new Promise((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  async registerFile({ sessionId, fileId, name, sourcePath }) {
    this.allowedSessions.add(sessionId);
    this.registeredFiles.set(`${sessionId}:${fileId}`, {
      name,
      sourcePath: path.resolve(sourcePath),
    });
    await mkdir(this.#mntData(sessionId), { recursive: true });
  }

  virtualPath(sessionId, virtualPath) {
    if (!virtualPath.startsWith('/mnt/data/')) {
      throw new Error('isolated CodeAPI only maps /mnt/data paths');
    }
    return path.join(this.#mntData(sessionId), virtualPath.slice('/mnt/data/'.length));
  }

  executionCount(itemId) {
    return this.actualExecutions.get(itemId) ?? 0;
  }

  async #handle(request, response) {
    try {
      if (request.method !== 'POST' || request.url !== '/exec') {
        respond(response, 404, { error: 'not found' });
        return;
      }
      const body = await readBody(request);
      const itemId = body.item_id;
      const sessionId = body.session_id;
      if (typeof itemId !== 'string' || typeof sessionId !== 'string') {
        respond(response, 400, { error: 'item_id and session_id are required' });
        return;
      }
      if (!this.allowedSessions.has(sessionId)) {
        respond(response, 403, { error: 'session is not allowed' });
        return;
      }
      this.requests.push(structuredClone(body));

      const resultPath = path.join(this.resultsDir, `${sha256(itemId)}.json`);
      const cached = await readJson(resultPath);
      if (cached) {
        respond(response, 200, { ...cached, replayed: true });
        return;
      }

      await this.#injectFiles(sessionId, body.injected_files ?? []);
      const mntData = this.#mntData(sessionId);
      const command = String(body.command).replaceAll('/mnt/data', mntData);
      this.actualExecutions.set(itemId, this.executionCount(itemId) + 1);
      const execution = await runCommand(command, {
        cwd: mntData,
        timeoutMs: Number.isInteger(body.timeout_ms) ? body.timeout_ms : 120_000,
      });
      const artifacts = await this.#artifacts(sessionId, body.artifact_paths ?? []);
      const result = {
        status: execution.exitCode === 0 ? 'success' : 'error',
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
        artifacts,
        replayed: false,
      };
      await atomicWriteJson(resultPath, result);
      respond(response, 200, result);
    } catch (error) {
      respond(response, 500, { error: error?.message ?? String(error) });
    }
  }

  async #injectFiles(sessionId, files) {
    for (const file of files) {
      const registered = this.registeredFiles.get(`${sessionId}:${file.file_id}`);
      if (!registered || registered.name !== file.name) {
        throw new Error(`injected file is not registered: ${file.file_id}`);
      }
      const destination = this.virtualPath(sessionId, `/mnt/data/${file.name}`);
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await stat(destination);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
        await copyFile(registered.sourcePath, destination);
      }
    }
  }

  async #artifacts(sessionId, artifactPaths) {
    const artifacts = [];
    for (const virtualPath of artifactPaths) {
      const actualPath = this.virtualPath(sessionId, virtualPath);
      const info = await stat(actualPath);
      if (!info.isFile()) {
        throw new Error(`artifact is not a file: ${virtualPath}`);
      }
      artifacts.push({
        name: path.posix.basename(virtualPath),
        mimeType: virtualPath.toLowerCase().endsWith('.xlsx') ? XLSX_MIME : 'application/octet-stream',
        size: info.size,
        codeEnvRef: {
          storage_session_id: sessionId,
          file_id: `artifact-${sha256(`${sessionId}:${virtualPath}`).slice(0, 24)}`,
        },
      });
    }
    return artifacts;
  }

  #mntData(sessionId) {
    return path.join(this.sessionsDir, sessionId, 'mnt', 'data');
  }
}

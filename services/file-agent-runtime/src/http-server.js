import { createServer } from 'node:http';

import { TaskNotFoundError } from './task-store.js';

const TASK_PATH = /^\/v1\/tasks\/([0-9a-f-]{36})$/i;
const EVENTS_PATH = /^\/v1\/tasks\/([0-9a-f-]{36})\/events$/i;
const CANCEL_PATH = /^\/v1\/tasks\/([0-9a-f-]{36})\/cancel$/i;
const STEER_PATH = /^\/v1\/tasks\/([0-9a-f-]{36})\/steer$/i;
const BODY_LIMIT_BYTES = 1024 * 1024;

function jsonResponse(status, body) {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function readRequestJson(request) {
  const text = await request.text();
  if (Buffer.byteLength(text) > BODY_LIMIT_BYTES) {
    const error = new Error('Request body exceeds 1 MiB');
    error.statusCode = 413;
    throw error;
  }
  if (text === '') {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

function parseAfter(url) {
  const value = url.searchParams.get('after') ?? '0';
  if (!/^\d+$/.test(value)) {
    const error = new Error('after must be a non-negative integer');
    error.statusCode = 400;
    throw error;
  }
  return Number(value);
}

export async function handleRuntimeFetch(runtime, request) {
  try {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return jsonResponse(200, { status: 'ok', mode: 'development' });
    }

    if (request.method === 'POST' && url.pathname === '/v1/tasks') {
      const idempotencyKey = request.headers.get('idempotency-key');
      const manifest = await readRequestJson(request);
      const result = await runtime.submit({ idempotencyKey, manifest });
      return jsonResponse(result.created ? 202 : 200, result);
    }

    const taskMatch = url.pathname.match(TASK_PATH);
    if (request.method === 'GET' && taskMatch) {
      const task = await runtime.getTask(taskMatch[1]);
      if (!task) {
        throw new TaskNotFoundError(taskMatch[1]);
      }
      return jsonResponse(200, { task });
    }

    const eventsMatch = url.pathname.match(EVENTS_PATH);
    if (request.method === 'GET' && eventsMatch) {
      const after = parseAfter(url);
      const events = await runtime.getEvents(eventsMatch[1], after);
      return jsonResponse(200, {
        taskId: eventsMatch[1],
        after,
        events,
        nextAfter: events.at(-1)?.sequence ?? after,
      });
    }

    const cancelMatch = url.pathname.match(CANCEL_PATH);
    if (request.method === 'POST' && cancelMatch) {
      const task = await runtime.cancel(cancelMatch[1]);
      return jsonResponse(200, { task });
    }

    const steerMatch = url.pathname.match(STEER_PATH);
    if (request.method === 'POST' && steerMatch) {
      const instruction = await readRequestJson(request);
      const task = await runtime.steer(steerMatch[1], instruction);
      return jsonResponse(200, { task });
    }

    return jsonResponse(404, { error: 'Not found' });
  } catch (error) {
    const status =
      error instanceof TaskNotFoundError
        ? 404
        : error?.statusCode ?? (error instanceof TypeError ? 400 : 500);
    return jsonResponse(status, { error: error?.message ?? 'Internal server error' });
  }
}

async function readIncomingBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > BODY_LIMIT_BYTES) {
      const error = new Error('Request body exceeds 1 MiB');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function toWebHeaders(incomingHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incomingHeaders)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(name, entry);
      }
    } else if (typeof value === 'string') {
      headers.set(name, value);
    }
  }
  return headers;
}

export function createRuntimeHttpServer(runtime) {
  return createServer(async (incoming, outgoing) => {
    try {
      const body = ['GET', 'HEAD'].includes(incoming.method) ? undefined : await readIncomingBody(incoming);
      const request = new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method,
        headers: toWebHeaders(incoming.headers),
        body,
      });
      const response = await handleRuntimeFetch(runtime, request);
      const responseBody = Buffer.from(await response.arrayBuffer());
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(responseBody);
    } catch (error) {
      const response = jsonResponse(error?.statusCode ?? 500, {
        error: error?.message ?? 'Internal server error',
      });
      const responseBody = Buffer.from(await response.arrayBuffer());
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(responseBody);
    }
  });
}

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function respond(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body)}\n`);
}

function defaultPlan(operation) {
  if (operation === 'repair') {
    return {
      schemaVersion: '1.0',
      summary: 'Patch the persisted workbook worker',
      needsInput: false,
      actions: [
        { kind: 'xlsx_patch_and_transform', summary: 'Apply one bounded worker patch' },
      ],
    };
  }
  return {
    schemaVersion: '1.0',
    summary: 'Run the persisted workbook worker',
    needsInput: false,
    actions: [
      { kind: 'xlsx_transform', summary: 'Run the stable workbook transform' },
    ],
  };
}

export class IsolatedModelRelay {
  constructor({ responseFor } = {}) {
    this.responseFor = responseFor ?? (({ operation }) => defaultPlan(operation));
    this.responses = new Map();
    this.inFlight = new Map();
    this.actualExecutions = new Map();
    this.requests = [];
    this.server = createServer((request, response) => this.#handle(request, response));
  }

  async start() {
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

  executionCount(callId) {
    return this.actualExecutions.get(callId) ?? 0;
  }

  async #handle(request, response) {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        respond(response, 404, { error: 'not found' });
        return;
      }
      const callId = request.headers['idempotency-key'];
      if (typeof callId !== 'string' || callId === '') {
        respond(response, 400, { error: 'idempotency-key is required' });
        return;
      }
      const body = await readBody(request);
      const userMessage = body.messages?.find((message) => message.role === 'user');
      const payload = JSON.parse(userMessage?.content ?? '{}');
      const requestRecord = {
        callId,
        operation: payload.operation,
        context: payload.context,
        model: body.model,
        requestDigest: sha256(JSON.stringify(body)),
      };
      this.requests.push(requestRecord);

      const cached = this.responses.get(callId);
      if (cached) {
        respond(response, 200, cached);
        return;
      }

      let execution = this.inFlight.get(callId);
      if (!execution) {
        this.actualExecutions.set(callId, this.executionCount(callId) + 1);
        execution = (async () => {
          const plan = await this.responseFor({
            callId,
            operation: payload.operation,
            context: payload.context,
            requestIndex: this.requests.length - 1,
          });
          const bodyResponse = {
            id: `chatcmpl-${sha256(callId).slice(0, 16)}`,
            object: 'chat.completion',
            model: 'recorded-office-planner',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: JSON.stringify(plan) },
              },
            ],
            usage: {
              prompt_tokens: payload.operation === 'repair' ? 700 : 500,
              completion_tokens: payload.operation === 'repair' ? 90 : 70,
              prompt_tokens_details: { cached_tokens: payload.operation === 'repair' ? 120 : 0 },
              cache_creation_input_tokens: 0,
            },
          };
          this.responses.set(callId, bodyResponse);
          return bodyResponse;
        })();
        this.inFlight.set(callId, execution);
      }
      let bodyResponse;
      try {
        bodyResponse = await execution;
      } finally {
        if (this.inFlight.get(callId) === execution) {
          this.inFlight.delete(callId);
        }
      }
      respond(response, 200, bodyResponse);
    } catch (error) {
      respond(response, 500, { error: error?.message ?? String(error) });
    }
  }
}

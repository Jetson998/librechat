import { appendFile, mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const port = Number(process.env.FAKE_RELAY_PORT || 8788);
const stateDir = path.resolve(process.env.FAKE_RELAY_STATE_DIR || '/var/lib/fake-relay');
const requestLog = path.join(stateDir, 'requests.ndjson');

function json(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function bodyOf(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Fake Relay request body is not JSON');
  }
}

function firstAssertion(context) {
  return context?.wordAcceptanceAssertions?.[0] ?? null;
}

function wordAction(assertion, operation) {
  const fallback = {
    schemaVersion: '1.0',
    type: 'text_replace',
    find: 'Integration',
    replace: 'Integration Verified',
    occurrence: 1,
  };
  const value = assertion && typeof assertion === 'object' ? assertion : fallback;
  if (operation === 'inspect') {
    return {
      schemaVersion: '1.0',
      objective: 'Inspect the authorized Word document before choosing a transform.',
      worker: 'word.inspect.v1',
      inputRefs: ['input:source-docx'],
      targetRef: 'candidate:working-docx',
      parameters: {
        operation: 'inspect',
        find: null,
        replace: null,
        text: null,
        occurrence: null,
        tableIndex: null,
        rowIndex: null,
        columnIndex: null,
        style: null,
        expectedBaseSha256: null,
      },
      expectedChange: ['Inspect the authorized Word document structure.'],
      verificationProfile: 'word-structure-v1',
      onFailure: 'fail',
      summary: 'Inspect the Word document',
    };
  }
  if (value.type === 'paragraph_append') {
    return {
      schemaVersion: '1.0',
      objective: 'Append the independently resolved paragraph assertion.',
      worker: 'word.transform.v1',
      inputRefs: ['input:source-docx'],
      targetRef: 'candidate:working-docx',
      parameters: {
        operation: 'append_paragraph',
        find: null,
        replace: null,
        text: value.text,
        occurrence: null,
        tableIndex: null,
        rowIndex: null,
        columnIndex: null,
        style: null,
        expectedBaseSha256: null,
      },
      expectedChange: [`Append paragraph: ${value.text}`],
      verificationProfile: 'word-structure-v1',
      onFailure: 'replan',
      summary: 'Append the requested paragraph',
    };
  }
  if (value.type === 'table_cell_replace') {
    return {
      schemaVersion: '1.0',
      objective: 'Replace the independently resolved table-cell assertion.',
      worker: 'word.transform.v1',
      inputRefs: ['input:source-docx'],
      targetRef: 'candidate:working-docx',
      parameters: {
        operation: 'replace_table_cell',
        find: null,
        replace: null,
        text: value.text,
        occurrence: null,
        tableIndex: value.tableIndex,
        rowIndex: value.rowIndex,
        columnIndex: value.columnIndex,
        style: null,
        expectedBaseSha256: null,
      },
      expectedChange: [`Replace table cell ${value.tableIndex + 1}/${value.rowIndex + 1}/${value.columnIndex + 1}.`],
      verificationProfile: 'word-structure-v1',
      onFailure: 'replan',
      summary: 'Replace the requested table cell',
    };
  }
  return {
    schemaVersion: '1.0',
    objective: 'Replace the independently resolved text assertion.',
    worker: 'word.transform.v1',
    inputRefs: ['input:source-docx'],
    targetRef: 'candidate:working-docx',
    parameters: {
      operation: 'replace_text',
      find: value.find,
      replace: value.replace,
      text: null,
      occurrence: value.occurrence ?? 1,
      tableIndex: null,
      rowIndex: null,
      columnIndex: null,
      style: null,
      expectedBaseSha256: null,
    },
    expectedChange: [`Replace ${value.find} with ${value.replace}.`],
    verificationProfile: 'word-structure-v1',
    onFailure: 'replan',
    summary: 'Replace the requested text',
  };
}

function planFor(body) {
  const context = body?.messages?.find((message) => message.role === 'user')?.content;
  let requestContext = {};
  try {
    requestContext = JSON.parse(context || '{}');
  } catch {
    requestContext = {};
  }
  const assertion = firstAssertion(requestContext.context);
  const hasDocument = requestContext.context?.document != null;
  const actions = hasDocument
    ? [wordAction(assertion, 'transform'), {
        ...wordAction(assertion, 'inspect'),
        worker: 'word.validate.v1',
        objective: 'Validate the complete Word artifact against the frozen assertions.',
        parameters: {
          operation: 'validate',
          find: null,
          replace: null,
          text: null,
          occurrence: null,
          tableIndex: null,
          rowIndex: null,
          columnIndex: null,
          style: null,
          expectedBaseSha256: null,
        },
        expectedChange: ['Validate the complete Word artifact.'],
        onFailure: 'fail',
        summary: 'Validate the Word artifact',
      }]
    : [wordAction(assertion, 'inspect')];
  return {
    schemaVersion: '1.0',
    summary: 'Deterministic integration fixture plan derived from the frozen acceptance assertion.',
    needsInput: false,
    question: null,
    actions,
  };
}

async function recordRequest(request) {
  await mkdir(stateDir, { recursive: true });
  // The parent is private integration state; this bounded routing log must be
  // readable by the host-side E2E process even when container and host UIDs
  // differ on a clean Linux machine.
  await appendFile(requestLog, `${JSON.stringify(request)}\n`, { encoding: 'utf8', mode: 0o644 });
}

async function requests() {
  try {
    const text = await readFile(requestLog, 'utf8');
    return text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { status: 'ok', service: 'fake-model-relay' });
    }
    if (req.method === 'GET' && url.pathname === '/requests') {
      return json(res, 200, await requests());
    }
    if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/messages'].includes(url.pathname)) {
      return json(res, 404, { error: 'not_found' });
    }
    const body = await bodyOf(req);
    const protocol = url.pathname.endsWith('/messages') ? 'anthropic-messages' : 'openai-compatible';
    const record = {
      occurredAt: new Date().toISOString(),
      endpoint: `http://fake-model-relay:${port}/v1`,
      path: url.pathname,
      protocol,
      model: body.model ?? null,
      idempotencyKey: req.headers['idempotency-key'] ?? null,
      authorizationPresent: Boolean(req.headers.authorization || req.headers['x-api-key']),
      operation: body.metadata?.operation ?? null,
      requestContext: (() => {
        try {
          const message = protocol === 'openai-compatible'
            ? body.messages?.find((entry) => entry.role === 'user')
            : body.messages?.find((entry) => entry.role === 'user');
          const parsed = JSON.parse(typeof message?.content === 'string' ? message.content : '{}');
          return {
            operation: parsed.operation ?? null,
            capabilityProfile: parsed.context?.state?.capabilityProfile ?? null,
            acceptanceTypes: Array.isArray(parsed.context?.wordAcceptanceAssertions)
              ? parsed.context.wordAcceptanceAssertions.map((assertion) => assertion?.type ?? null)
              : [],
            hasDocument: parsed.context?.document != null,
          };
        } catch {
          return null;
        }
      })(),
    };
    await recordRequest(record);
    const plan = planFor(body);
    if (protocol === 'anthropic-messages') {
      return json(res, 200, {
        id: `msg_integration_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: JSON.stringify(plan) }],
        usage: { input_tokens: 17, output_tokens: 11 },
      });
    }
    return json(res, 200, {
      id: `chatcmpl_integration_${Date.now()}`,
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(plan) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 17, completion_tokens: 11, total_tokens: 28 },
    });
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
});

await mkdir(stateDir, { recursive: true });
server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`fake-model-relay listening on 0.0.0.0:${port}\n`);
});

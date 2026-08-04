import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ContextProjector } from '../src/context-projector.js';
import {
  OFFICE_COMPOSE_VERIFIER_PROFILE,
} from '../src/deterministic-office-compose-v1.js';
import { FileModelCallJournal } from '../src/model-call-journal.js';
import { OpenAiChatTransport, SingleModelAgentProvider } from '../src/openai-compatible-provider.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

test('Office Compose provider emits a strict source-mapping plan schema', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'file-agent-compose-provider-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let requestBody;
  const transport = new OpenAiChatTransport({
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        model: 'compose-provider-model',
        choices: [{
          message: {
            content: JSON.stringify({
              schemaVersion: '1.0',
              summary: 'Inspect the authorized source workbook',
              needsInput: false,
              question: null,
              actions: [{
                schemaVersion: '1.0',
                objective: 'Inspect all authorized Office sources',
                worker: 'office-compose.inspect.v1',
                inputRefs: ['input:office-sources'],
                targetRef: 'candidate:working-pptx',
                parameters: { operation: 'inspect', title: null, slides: null },
                expectedChange: ['compose.source_facts'],
                verificationProfile: OFFICE_COMPOSE_VERIFIER_PROFILE,
                onFailure: 'replan',
                summary: 'Inspect source facts',
              }],
            }),
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const provider = new SingleModelAgentProvider({
    routes: {
      'file-agent-compose': {
        baseUrl: 'https://compose-provider.example.invalid',
        model: 'compose-provider-model',
        capabilityProfile: 'office-compose-v1',
        supportsIdempotency: true,
        outputBudgetTokens: 256,
        structuredOutputMode: 'json_schema',
      },
    },
    transport,
    journal: new FileModelCallJournal(path.join(rootDir, 'provider-journal')),
    projector: new ContextProjector(),
  });

  const result = await provider.plan({
    callId: 'compose-provider-plan',
    task: {
      taskId: 'compose-provider-task',
      manifest: {
        intent: 'Compose a source-backed presentation',
        acceptance: ['Return one verified PPTX'],
        acceptanceAssertions: [{
          type: 'compose.source_hash.v1',
          sourceLogicalId: 'source:finance',
          sha256: 'a'.repeat(64),
        }],
        model: {
          modelRouteId: 'file-agent-compose',
          capabilityProfile: 'office-compose-v1',
        },
        inputs: [{
          logicalId: 'source:finance',
          logicalName: 'source.xlsx',
          mimeType: XLSX_MIME,
          sha256: 'a'.repeat(64),
        }],
      },
      phase: 'planning',
      planRevision: 0,
      instructionRevision: 0,
      events: [],
      itemResults: {},
      progress: {},
    },
  });

  assert.equal(result.value.actions[0].worker, 'office-compose.inspect.v1');
  assert.equal(requestBody.response_format.type, 'json_schema');
  assert.equal(requestBody.response_format.json_schema.strict, true);
  const actionSchema = requestBody.response_format.json_schema.schema.properties.actions.items;
  assert.ok(actionSchema.properties.worker.enum.includes('office-compose.generate.v1'));
  assert.equal(actionSchema.properties.targetRef.const, 'candidate:working-pptx');
  assert.equal(actionSchema.properties.parameters.properties.slides.anyOf[1].maxItems, 12);
});

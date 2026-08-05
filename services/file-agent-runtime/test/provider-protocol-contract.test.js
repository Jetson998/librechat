import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AnthropicMessagesTransport,
  OpenAiChatTransport,
  SingleModelAgentProvider,
} from '../src/openai-compatible-provider.js';

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

test('OpenAI-compatible transport uses the selected provider model and route', async () => {
  let request;
  const transport = new OpenAiChatTransport({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({
        model: 'gpt-5.6-sol',
        choices: [{ message: { content: '{"schemaVersion":"1.0"}' } }],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      });
    },
  });
  await transport.invoke({
    callId: 'call-openai',
    route: {
      baseUrl: 'https://api.example.test/v1',
      model: 'gpt-5.6-sol',
      apiKey: 'secret',
      protocol: 'openai-compatible',
      outputBudgetTokens: 500,
      capabilityProfile: 'word-edit-v1',
    },
    operation: 'plan',
    context: {},
  });
  assert.equal(request.url, 'https://api.example.test/v1/chat/completions');
  assert.equal(JSON.parse(request.options.body).model, 'gpt-5.6-sol');
});

test('Anthropic transport uses Messages API and explicit Anthropic headers', async () => {
  let request;
  const transport = new AnthropicMessagesTransport({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({
        model: 'claude-fable-5',
        content: [{ type: 'text', text: '{"schemaVersion":"1.0"}' }],
        usage: { input_tokens: 2, output_tokens: 3 },
      });
    },
  });
  await transport.invoke({
    callId: 'call-anthropic',
    route: {
      baseUrl: 'https://api.example.test',
      model: 'claude-fable-5',
      apiKey: 'secret',
      protocol: 'anthropic-messages',
      outputBudgetTokens: 500,
      capabilityProfile: 'word-edit-v1',
    },
    operation: 'plan',
    context: {},
  });
  assert.equal(request.url, 'https://api.example.test/v1/messages');
  assert.equal(request.options.headers['x-api-key'], 'secret');
  assert.equal(request.options.headers['anthropic-version'], '2023-06-01');
  assert.equal(JSON.parse(request.options.body).model, 'claude-fable-5');
});

test('SingleModelAgentProvider resolves the task route identity instead of a fixed model', async () => {
  let invokedRoute;
  const provider = new SingleModelAgentProvider({
    routes: {
      'custom:Muskapis-openai': {
        providerRouteRef: 'custom:Muskapis-openai',
        providerEndpoint: 'Muskapis-openai',
        baseUrl: 'https://api.example.test/v1',
        protocol: 'openai-compatible',
        allowedModels: ['gpt-5.6-sol'],
        apiKey: 'secret',
        outputBudgetTokens: 500,
        supportsIdempotency: false,
      },
    },
    transport: {
      async invoke({ route }) {
        invokedRoute = route;
        return {
          plan: {
            schemaVersion: '1.0',
            summary: 'Needs one bounded instruction',
            needsInput: true,
            question: 'Please clarify',
            actions: [],
          },
          providerModel: route.model,
          usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
        };
      },
    },
    journal: {
      async begin() {
        return { action: 'new' };
      },
      async completeValid({ result }) {
        return result;
      },
      async completeInvalid() {
        throw new Error('not expected');
      },
    },
    projector: { project: () => ({ context: {}, digest: 'context-digest', characters: 0 }) },
  });
  const result = await provider.plan({
    callId: 'dynamic-route-call',
    task: {
      manifest: {
        model: {
          modelRouteId: 'file-agent-primary',
          capabilityProfile: 'office-planner-v1',
          providerRouteRef: 'custom:Muskapis-openai',
          providerEndpoint: 'Muskapis-openai',
          providerModel: 'gpt-5.6-sol',
          providerProtocol: 'openai-compatible',
        },
      },
    },
  });
  assert.equal(invokedRoute.model, 'gpt-5.6-sol');
  assert.equal(invokedRoute.providerEndpoint, 'Muskapis-openai');
  assert.equal(result.call.providerRouteRef, 'custom:Muskapis-openai');
  assert.equal(result.call.providerProtocol, 'openai-compatible');
});

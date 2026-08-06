import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AnthropicMessagesTransport,
  OpenAiChatTransport,
  ProviderProtocolTransport,
  SingleModelAgentProvider,
} from '../src/openai-compatible-provider.js';
import { providerRouteConfigDigest } from '../src/provider-route-registry.js';

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
  const route = {
    providerRouteRef: 'custom:Muskapis-openai',
    providerEndpoint: 'Muskapis-openai',
    baseUrl: 'https://api.example.test/v1',
    protocol: 'openai-compatible',
    allowedModels: ['gpt-5.6-sol'],
    apiKey: 'secret',
    outputBudgetTokens: 500,
    supportsIdempotency: false,
  };
  const routeConfigDigestValue = providerRouteConfigDigest([route]);
  const provider = new SingleModelAgentProvider({
    routes: {
      'custom:Muskapis-openai': { ...route, routeConfigDigest: routeConfigDigestValue },
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
          routeConfigDigest: routeConfigDigestValue,
        },
      },
    },
  });
  assert.equal(invokedRoute.model, 'gpt-5.6-sol');
  assert.equal(invokedRoute.providerEndpoint, 'Muskapis-openai');
  assert.equal(result.call.providerRouteRef, 'custom:Muskapis-openai');
  assert.equal(result.call.providerProtocol, 'openai-compatible');
});

test('production route contract sends both allowlisted models through one OpenAI-compatible relay', async () => {
  const routes = [{
    librechatEndpoint: 'Muskapis-openai',
    providerRouteRef: 'custom:Muskapis-openai',
    providerEndpoint: 'Muskapis-openai',
    baseUrl: 'https://relay.example.test/v1',
    protocol: 'openai-compatible',
    allowedModels: ['gpt-5.6-sol', 'claude-fable-5'],
    apiKey: 'test-secret',
    outputBudgetTokens: 500,
    supportsIdempotency: false,
  }];
  const routeConfigDigestValue = providerRouteConfigDigest(routes);
  const observedModels = [];
  const provider = new SingleModelAgentProvider({
    routes: { 'custom:Muskapis-openai': { ...routes[0], routeConfigDigest: routeConfigDigestValue } },
    transport: new ProviderProtocolTransport({
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        observedModels.push(body.model);
        return response({
          model: body.model,
          choices: [{ message: { content: '{"schemaVersion":"1.0","summary":"clarify","needsInput":true,"question":"clarify","actions":[]}' } }],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        });
      },
    }),
    journal: {
      async begin() { return { action: 'new' }; },
      async completeValid({ result }) { return result; },
      async completeInvalid() { throw new Error('not expected'); },
    },
    projector: { project: () => ({ context: {}, digest: 'context-digest', characters: 0 }) },
  });

  for (const [index, model] of ['gpt-5.6-sol', 'claude-fable-5'].entries()) {
    const result = await provider.plan({
      callId: `production-route-${index}`,
      task: {
        manifest: {
          model: {
            modelRouteId: 'file-agent-primary',
            capabilityProfile: 'word-edit-v1',
            providerRouteRef: 'custom:Muskapis-openai',
            providerEndpoint: 'Muskapis-openai',
            providerModel: model,
            providerProtocol: 'openai-compatible',
            routeConfigDigest: routeConfigDigestValue,
          },
        },
      },
    });
    assert.equal(result.call.requestedModel, model);
    assert.equal(result.call.actualModel, model);
    assert.equal(result.call.routeConfigDigest, routeConfigDigestValue);
  }
  assert.deepEqual(observedModels, ['gpt-5.6-sol', 'claude-fable-5']);
  await assert.rejects(
    provider.plan({
      callId: 'production-route-rejected',
      task: {
        manifest: {
          model: {
            modelRouteId: 'file-agent-primary',
            capabilityProfile: 'word-edit-v1',
            providerRouteRef: 'custom:Muskapis-openai',
            providerEndpoint: 'Muskapis-openai',
            providerModel: 'unsupported-model',
            providerProtocol: 'openai-compatible',
            routeConfigDigest: routeConfigDigestValue,
          },
        },
      },
    }),
    /Provider model is not allowed/u,
  );
});

test('provider fails closed when the relay reports an actual model different from the requested model', async () => {
  const routes = [{
    librechatEndpoint: 'Muskapis-openai',
    providerRouteRef: 'custom:Muskapis-openai',
    providerEndpoint: 'Muskapis-openai',
    baseUrl: 'https://relay.example.test/v1',
    protocol: 'openai-compatible',
    allowedModels: ['gpt-5.6-sol', 'claude-fable-5'],
    apiKey: 'test-secret',
    outputBudgetTokens: 500,
    supportsIdempotency: false,
  }];
  const routeConfigDigestValue = providerRouteConfigDigest(routes);
  const provider = new SingleModelAgentProvider({
    routes: { 'custom:Muskapis-openai': { ...routes[0], routeConfigDigest: routeConfigDigestValue } },
    transport: {
      async invoke() {
        return {
          plan: { schemaVersion: '1.0', summary: 'clarify', needsInput: true, question: 'clarify', actions: [] },
          providerModel: 'gpt-5.6-sol',
          usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
        };
      },
    },
    journal: {
      async begin() { return { action: 'new' }; },
      async completeValid({ result }) { return result; },
      async completeInvalid() { throw new Error('not expected'); },
    },
    projector: { project: () => ({ context: {}, digest: 'context-digest', characters: 0 }) },
  });
  await assert.rejects(
    provider.plan({
      callId: 'production-route-model-mismatch',
      task: {
        manifest: {
          model: {
            modelRouteId: 'file-agent-primary',
            capabilityProfile: 'word-edit-v1',
            providerRouteRef: 'custom:Muskapis-openai',
            providerEndpoint: 'Muskapis-openai',
            providerModel: 'claude-fable-5',
            providerProtocol: 'openai-compatible',
            routeConfigDigest: routeConfigDigestValue,
          },
        },
      },
    }),
    /does not match requested model/u,
  );
});

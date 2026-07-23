import { createHash } from 'node:crypto';

import {
  ProviderCanceledError,
  ProviderProtocolError,
  ProviderRejectedError,
  ProviderRouteError,
  ProviderTransportError,
} from './provider-adapter.js';

const PROFILE_ACTIONS = Object.freeze({
  'office-planner-v1': new Set(['xlsx_transform', 'xlsx_patch_and_transform']),
});
const MAX_ACTIONS = 2;
const MAX_SUMMARY_CHARS = 500;
const MAX_ERROR_TEXT = 2_000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function boundedText(value) {
  return typeof value === 'string' ? value.slice(0, MAX_ERROR_TEXT) : '';
}

function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ProviderProtocolError(`Provider usage ${field} must be a non-negative integer`);
  }
  return value;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    throw new ProviderProtocolError('Provider response usage is required');
  }
  return {
    inputTokens: nonNegativeInteger(usage.prompt_tokens ?? usage.input_tokens, 'inputTokens'),
    cacheReadTokens: nonNegativeInteger(
      usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_tokens ?? 0,
      'cacheReadTokens',
    ),
    cacheWriteTokens: nonNegativeInteger(
      usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0,
      'cacheWriteTokens',
    ),
    outputTokens: nonNegativeInteger(usage.completion_tokens ?? usage.output_tokens, 'outputTokens'),
  };
}

function validateAction(action, allowedActions, operation) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new ProviderProtocolError('Provider plan action must be an object');
  }
  const keys = Object.keys(action);
  if (keys.some((key) => !['kind', 'summary'].includes(key))) {
    throw new ProviderProtocolError('Provider plan action contains unsupported fields');
  }
  if (!allowedActions.has(action.kind)) {
    throw new ProviderProtocolError(`Provider plan action is not allowed: ${action.kind}`);
  }
  if (operation === 'plan' && action.kind !== 'xlsx_transform') {
    throw new ProviderProtocolError('Initial plan must use xlsx_transform');
  }
  if (operation === 'repair' && action.kind !== 'xlsx_patch_and_transform') {
    throw new ProviderProtocolError('Repair plan must use xlsx_patch_and_transform');
  }
  if (
    typeof action.summary !== 'string' ||
    action.summary.trim() === '' ||
    action.summary.length > MAX_SUMMARY_CHARS
  ) {
    throw new ProviderProtocolError('Provider plan action summary is invalid');
  }
  return { kind: action.kind, summary: action.summary.trim() };
}

function validatePlan(value, { capabilityProfile, operation }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderProtocolError('Provider plan must be a JSON object');
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !['schemaVersion', 'summary', 'needsInput', 'question', 'actions'].includes(key))) {
    throw new ProviderProtocolError('Provider plan contains unsupported fields');
  }
  if (value.schemaVersion !== '1.0') {
    throw new ProviderProtocolError('Provider plan schemaVersion must be "1.0"');
  }
  if (
    typeof value.summary !== 'string' ||
    value.summary.trim() === '' ||
    value.summary.length > MAX_SUMMARY_CHARS
  ) {
    throw new ProviderProtocolError('Provider plan summary is invalid');
  }
  if (typeof value.needsInput !== 'boolean') {
    throw new ProviderProtocolError('Provider plan needsInput must be boolean');
  }
  if (value.needsInput) {
    if (typeof value.question !== 'string' || value.question.trim() === '') {
      throw new ProviderProtocolError('Provider plan question is required when needsInput is true');
    }
    return {
      schemaVersion: '1.0',
      summary: value.summary.trim(),
      needsInput: true,
      question: value.question.trim().slice(0, MAX_SUMMARY_CHARS),
      actions: [],
    };
  }
  if (!Array.isArray(value.actions) || value.actions.length === 0 || value.actions.length > MAX_ACTIONS) {
    throw new ProviderProtocolError(`Provider plan actions must contain 1-${MAX_ACTIONS} entries`);
  }
  const allowedActions = PROFILE_ACTIONS[capabilityProfile];
  if (!allowedActions) {
    throw new ProviderRouteError(`Unsupported capability profile: ${capabilityProfile}`);
  }
  const actions = value.actions.map((action) => validateAction(action, allowedActions, operation));
  if (new Set(actions.map((action) => action.kind)).size !== actions.length) {
    throw new ProviderProtocolError('Provider plan contains duplicate actions');
  }
  return {
    schemaVersion: '1.0',
    summary: value.summary.trim(),
    needsInput: false,
    actions,
  };
}

export class OpenAiChatTransport {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 60_000 } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('OpenAiChatTransport fetchImpl must be a function');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError('OpenAiChatTransport timeoutMs must be a positive integer');
    }
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async invoke({ callId, route, operation, context, signal }) {
    const timeoutSignal = AbortSignal.timeout(route.timeoutMs ?? this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await this.fetchImpl(`${route.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': callId,
          ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: route.model,
          messages: [
            {
              role: 'system',
              content: 'Return one JSON plan only. Choose declared actions. Never emit code, commands, credentials, prices, or file contents.',
            },
            {
              role: 'user',
              content: JSON.stringify({ operation, context }),
            },
          ],
          response_format: { type: 'json_object' },
          max_tokens: route.outputBudgetTokens,
          temperature: 0,
          metadata: { operation, call_id: callId },
        }),
        signal: combinedSignal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new ProviderCanceledError('Provider request was canceled', { cause: error });
      }
      if (timeoutSignal.aborted) {
        throw new ProviderTransportError('Provider request timed out', {
          code: 'PROVIDER_TIMEOUT',
          cause: error,
        });
      }
      throw new ProviderTransportError('Provider request failed', { cause: error });
    }

    const text = await response.text();
    if (!response.ok) {
      if (response.status >= 500) {
        throw new ProviderTransportError(`Provider returned ${response.status}: ${boundedText(text)}`);
      }
      throw new ProviderRejectedError(`Provider rejected the request with ${response.status}: ${boundedText(text)}`);
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new ProviderProtocolError('Provider response was not valid JSON', { cause: error });
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new ProviderProtocolError('Provider response contained no plan content');
    }
    let plan;
    try {
      plan = JSON.parse(content);
    } catch (error) {
      throw new ProviderProtocolError('Provider plan content was not valid JSON', { cause: error });
    }
    return {
      plan,
      providerModel: body.model ?? route.model,
      usage: normalizeUsage(body.usage),
    };
  }
}

export class SingleModelAgentProvider {
  constructor({ routes, transport, journal, projector }) {
    if (!routes || typeof routes !== 'object' || Array.isArray(routes)) {
      throw new TypeError('SingleModelAgentProvider routes are required');
    }
    if (!transport || typeof transport.invoke !== 'function') {
      throw new TypeError('SingleModelAgentProvider transport.invoke is required');
    }
    if (!journal || typeof journal.begin !== 'function' || typeof journal.complete !== 'function') {
      throw new TypeError('SingleModelAgentProvider journal is required');
    }
    if (!projector || typeof projector.project !== 'function') {
      throw new TypeError('SingleModelAgentProvider projector is required');
    }
    this.routes = { ...routes };
    this.transport = transport;
    this.journal = journal;
    this.projector = projector;
  }

  plan({ callId, task, signal }) {
    return this.#invoke({ callId, task, operation: 'plan', signal });
  }

  repair({ callId, task, signal }) {
    return this.#invoke({ callId, task, operation: 'repair', signal });
  }

  async #invoke({ callId, task, operation, signal }) {
    const routeId = task.manifest.model?.modelRouteId;
    const capabilityProfile = task.manifest.model?.capabilityProfile;
    const route = this.routes[routeId];
    if (!route) {
      throw new ProviderRouteError(`Model route is not allowed: ${routeId ?? 'missing'}`);
    }
    if (route.capabilityProfile !== capabilityProfile) {
      throw new ProviderRouteError('Task capability profile does not match the configured route');
    }
    if (
      typeof route.baseUrl !== 'string' ||
      typeof route.model !== 'string' ||
      !Number.isInteger(route.outputBudgetTokens)
    ) {
      throw new ProviderRouteError(`Model route is incomplete: ${routeId}`);
    }

    const projection = this.projector.project(task);
    const requestDigest = sha256(JSON.stringify({
      schemaVersion: '1.0',
      operation,
      routeId,
      model: route.model,
      capabilityProfile,
      contextDigest: projection.digest,
    }));
    const journalState = await this.journal.begin({
      callId,
      requestDigest,
      routeId,
      supportsIdempotency: route.supportsIdempotency === true,
    });
    if (journalState.action === 'replay') {
      return {
        ...journalState.result,
        call: { ...journalState.result.call, replayed: true },
      };
    }

    const response = await this.transport.invoke({
      callId,
      route,
      operation,
      context: projection.context,
      signal,
    });
    const value = validatePlan(response.plan, { capabilityProfile, operation });
    const occurredAt = new Date().toISOString();
    const result = {
      value,
      call: {
        callId,
        modelRouteId: routeId,
        providerModel: response.providerModel,
        replayed: journalState.replay === true,
      },
      usage: {
        ...response.usage,
        occurredAt,
      },
      context: {
        digest: projection.digest,
        characters: projection.characters,
        compaction: projection.compaction,
      },
    };
    return this.journal.complete({ callId, requestDigest, routeId, result });
  }
}

import { createHash } from 'node:crypto';

import { normalizeWordAction, WORD_WORKER_IDS, WORD_VERIFIER_PROFILE } from './deterministic-word.js';
import {
  normalizeXlsxAction,
  XLSX_VERIFIER_PROFILE,
  XLSX_WORKER_IDS,
} from './deterministic-xlsx-v1.js';
import {
  normalizePptxAction,
  PPTX_VERIFIER_PROFILE,
  PPTX_WORKER_IDS,
} from './deterministic-pptx-v1.js';
import {
  ProviderAmbiguousCommitError,
  ProviderCanceledError,
  ProviderProtocolError,
  ProviderRejectedError,
  ProviderRouteError,
  ProviderTransportError,
} from './provider-adapter.js';

const PROFILE_CONFIG = Object.freeze({
  'office-planner-v1': Object.freeze({
    legacyActions: new Set(['xlsx_transform', 'xlsx_patch_and_transform']),
    maxActions: 2,
  }),
  'word-edit-v1': Object.freeze({
    workers: new Set(WORD_WORKER_IDS),
    maxActions: 4,
  }),
  'xlsx-edit-v1': Object.freeze({
    workers: new Set(XLSX_WORKER_IDS),
    maxActions: 4,
  }),
  'pptx-edit-v1': Object.freeze({
    workers: new Set(PPTX_WORKER_IDS),
    maxActions: 4,
  }),
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
      usage.prompt_tokens_details?.cached_creation_tokens ??
        usage.cache_creation_input_tokens ??
        usage.cache_write_tokens ??
        0,
      'cacheWriteTokens',
    ),
    outputTokens: nonNegativeInteger(usage.completion_tokens ?? usage.output_tokens, 'outputTokens'),
  };
}

function responseFormatFor(route, operation) {
  const mode = route.structuredOutputMode ?? 'json_object';
  if (mode === 'json_object') {
    return { type: 'json_object' };
  }
  if (mode !== 'json_schema') {
    throw new ProviderRouteError(`Unsupported structured output mode: ${mode}`);
  }
  if (route.capabilityProfile === 'word-edit-v1') {
    return {
      type: 'json_schema',
      json_schema: {
        name: `word_${operation}_plan`,
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            schemaVersion: { type: 'string', const: '1.0' },
            summary: { type: 'string', minLength: 1, maxLength: MAX_SUMMARY_CHARS },
            needsInput: { type: 'boolean' },
            question: {
              anyOf: [
                { type: 'string', minLength: 1, maxLength: MAX_SUMMARY_CHARS },
                { type: 'null' },
              ],
            },
            actions: {
              type: 'array',
              minItems: 0,
              maxItems: 4,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  schemaVersion: { type: 'string', const: '1.0' },
                  objective: { type: 'string', minLength: 1, maxLength: 1_000 },
                  worker: { type: 'string', enum: WORD_WORKER_IDS },
                  inputRefs: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 20,
                    items: { type: 'string' },
                  },
                  targetRef: { type: 'string', const: 'candidate:working-docx' },
                  parameters: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      operation: {
                        type: 'string',
                        enum: ['inspect', 'validate', 'replace_text', 'append_paragraph', 'replace_table_cell'],
                      },
                      find: { anyOf: [{ type: 'string', maxLength: 4_000 }, { type: 'null' }] },
                      replace: { anyOf: [{ type: 'string', maxLength: 4_000 }, { type: 'null' }] },
                      text: { anyOf: [{ type: 'string', maxLength: 4_000 }, { type: 'null' }] },
                      occurrence: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
                      tableIndex: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
                      rowIndex: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
                      columnIndex: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
                      style: { anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }] },
                      expectedBaseSha256: { anyOf: [{ type: 'string', pattern: '^[a-fA-F0-9]{64}$' }, { type: 'null' }] },
                    },
                    required: [
                      'operation',
                      'find',
                      'replace',
                      'text',
                      'occurrence',
                      'tableIndex',
                      'rowIndex',
                      'columnIndex',
                      'style',
                      'expectedBaseSha256',
                    ],
                  },
                  expectedChange: {
                    type: 'array',
                    maxItems: 20,
                    items: { type: 'string', minLength: 1, maxLength: 240 },
                  },
                  verificationProfile: { type: 'string', const: WORD_VERIFIER_PROFILE },
                  onFailure: { type: 'string', enum: ['replan', 'needs_input', 'fail'] },
                  summary: { type: 'string', minLength: 1, maxLength: MAX_SUMMARY_CHARS },
                },
                required: [
                  'schemaVersion',
                  'objective',
                  'worker',
                  'inputRefs',
                  'targetRef',
                  'parameters',
                  'expectedChange',
                  'verificationProfile',
                  'onFailure',
                  'summary',
                ],
              },
            },
          },
          required: ['schemaVersion', 'summary', 'needsInput', 'question', 'actions'],
        },
      },
    };
  }
  if (['xlsx-edit-v1', 'pptx-edit-v1'].includes(route.capabilityProfile)) {
    const isPptx = route.capabilityProfile === 'pptx-edit-v1';
    const workerIds = isPptx ? PPTX_WORKER_IDS : XLSX_WORKER_IDS;
    const verifierProfile = isPptx ? PPTX_VERIFIER_PROFILE : XLSX_VERIFIER_PROFILE;
    const targetRef = isPptx ? 'candidate:working-pptx' : 'candidate:working-xlsx';
    const operations = isPptx
      ? ['inspect', 'validate', 'replace_text', 'set_table_cell', 'add_slide', 'reorder_slides']
      : ['inspect', 'validate', 'set_cell', 'set_formula', 'add_sheet', 'rename_sheet', 'set_number_format'];
    return {
      type: 'json_schema',
      json_schema: {
        name: `${isPptx ? 'pptx' : 'xlsx'}_${operation}_plan`,
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            schemaVersion: { type: 'string', const: '1.0' },
            summary: { type: 'string', minLength: 1, maxLength: MAX_SUMMARY_CHARS },
            needsInput: { type: 'boolean' },
            question: {
              anyOf: [
                { type: 'string', minLength: 1, maxLength: MAX_SUMMARY_CHARS },
                { type: 'null' },
              ],
            },
            actions: {
              type: 'array',
              minItems: 0,
              maxItems: 4,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  schemaVersion: { type: 'string', const: '1.0' },
                  objective: { type: 'string', minLength: 1, maxLength: 1_000 },
                  worker: { type: 'string', enum: workerIds },
                  inputRefs: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 20,
                    items: { type: 'string' },
                  },
                  targetRef: { type: 'string', const: targetRef },
                  parameters: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      operation: {
                        type: 'string',
                        enum: operations,
                      },
                      sheet: { anyOf: [{ type: 'string', maxLength: 31 }, { type: 'null' }] },
                      cell: { anyOf: [{ type: 'string', pattern: '^[A-Za-z]{1,3}[1-9][0-9]{0,6}$' }, { type: 'null' }] },
                      value: {
                        anyOf: [
                          { type: 'string', maxLength: 4_000 },
                          { type: 'number' },
                          { type: 'boolean' },
                          { type: 'null' },
                        ],
                      },
                      formula: { anyOf: [{ type: 'string', minLength: 1, maxLength: 4_000 }, { type: 'null' }] },
                      from: { anyOf: [{ type: 'string', maxLength: 31 }, { type: 'null' }] },
                      to: { anyOf: [{ type: 'string', maxLength: 31 }, { type: 'null' }] },
                      numberFormat: { anyOf: [{ type: 'string', minLength: 1, maxLength: 256 }, { type: 'null' }] },
                      expectedBaseSha256: { anyOf: [{ type: 'string', pattern: '^[a-fA-F0-9]{64}$' }, { type: 'null' }] },
                    },
                    required: ['operation', 'sheet', 'cell', 'value', 'formula', 'from', 'to', 'numberFormat', 'expectedBaseSha256'],
                  },
                  expectedChange: {
                    type: 'array',
                    maxItems: 20,
                    items: { type: 'string', minLength: 1, maxLength: 240 },
                  },
                  verificationProfile: { type: 'string', const: verifierProfile },
                  onFailure: { type: 'string', enum: ['replan', 'needs_input', 'fail'] },
                  summary: { type: 'string', minLength: 1, maxLength: MAX_SUMMARY_CHARS },
                },
                required: [
                  'schemaVersion',
                  'objective',
                  'worker',
                  'inputRefs',
                  'targetRef',
                  'parameters',
                  'expectedChange',
                  'verificationProfile',
                  'onFailure',
                  'summary',
                ],
              },
            },
          },
          required: ['schemaVersion', 'summary', 'needsInput', 'question', 'actions'],
        },
      },
    };
  }
  const actionKind = operation === 'repair' ? 'xlsx_patch_and_transform' : 'xlsx_transform';
  return {
    type: 'json_schema',
    json_schema: {
      name: `office_${operation}_plan`,
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          schemaVersion: { type: 'string', const: '1.0' },
          summary: { type: 'string', minLength: 1, maxLength: MAX_SUMMARY_CHARS },
          needsInput: { type: 'boolean' },
          question: {
            anyOf: [
              { type: 'string', minLength: 1, maxLength: MAX_SUMMARY_CHARS },
              { type: 'null' },
            ],
          },
          actions: {
            type: 'array',
            minItems: 0,
            maxItems: MAX_ACTIONS,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: [actionKind] },
                summary: { type: 'string', minLength: 1, maxLength: MAX_SUMMARY_CHARS },
              },
              required: ['kind', 'summary'],
            },
          },
        },
        required: ['schemaVersion', 'summary', 'needsInput', 'question', 'actions'],
      },
    },
  };
}

function safeProtocolError(error) {
  return {
    name: error.name,
    code: error.code,
    message: error.message,
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

function validateWordPlanAction(action, operation) {
  let normalized;
  try {
    normalized = normalizeWordAction(action);
  } catch (error) {
    throw new ProviderProtocolError(error.message, { cause: error });
  }
  if (operation === 'plan' && !['word.inspect.v1', 'word.transform.v1', 'word.validate.v1'].includes(normalized.worker)) {
    throw new ProviderProtocolError('Initial Word plan cannot use word.patch.v1');
  }
  if (operation === 'repair' && normalized.worker === 'word.inspect.v1') {
    throw new ProviderProtocolError('Word repair plan cannot use word.inspect.v1');
  }
  return normalized;
}

function validateXlsxPlanAction(action) {
  try {
    return normalizeXlsxAction(action);
  } catch (error) {
    throw new ProviderProtocolError(error.message, { cause: error });
  }
}

function validatePptxPlanAction(action) {
  try {
    return normalizePptxAction(action);
  } catch (error) {
    throw new ProviderProtocolError(error.message, { cause: error });
  }
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
  if (!Array.isArray(value.actions) || value.actions.length === 0) {
    throw new ProviderProtocolError('Provider plan actions must contain at least one entry');
  }
  const profile = PROFILE_CONFIG[capabilityProfile];
  if (!profile) {
    throw new ProviderRouteError(`Unsupported capability profile: ${capabilityProfile}`);
  }
  if (value.actions.length > profile.maxActions) {
    throw new ProviderProtocolError(`Provider plan actions must contain 1-${profile.maxActions} entries`);
  }
  const actions = capabilityProfile === 'word-edit-v1'
    ? value.actions.map((action) => validateWordPlanAction(action, operation))
    : capabilityProfile === 'xlsx-edit-v1'
      ? value.actions.map(validateXlsxPlanAction)
      : capabilityProfile === 'pptx-edit-v1'
        ? value.actions.map(validatePptxPlanAction)
      : value.actions.map((action) => validateAction(action, profile.legacyActions, operation));
  const signatures = actions.map((entry) => capabilityProfile === 'office-planner-v1'
    ? entry.kind
    : JSON.stringify({ worker: entry.worker, parameters: entry.parameters, targetRef: entry.targetRef }));
  if (new Set(signatures).size !== actions.length) {
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
          response_format: responseFormatFor(route, operation),
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
    if (
      !journal ||
      typeof journal.begin !== 'function' ||
      typeof journal.completeValid !== 'function' ||
      typeof journal.completeInvalid !== 'function'
    ) {
      throw new TypeError('SingleModelAgentProvider journal with valid and invalid completion is required');
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
    if (!PROFILE_CONFIG[capabilityProfile]) {
      throw new ProviderRouteError(`Unsupported capability profile: ${capabilityProfile}`);
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
    if (journalState.action === 'replay_invalid') {
      const receipt = {
        ...journalState.receipt,
        call: { ...journalState.receipt.call, replayed: true },
      };
      throw new ProviderProtocolError(receipt.error.message, { receipt });
    }

    const response = await this.transport.invoke({
      callId,
      route,
      operation,
      context: projection.context,
      signal,
    });
    const occurredAt = new Date().toISOString();
    const call = {
      callId,
      modelRouteId: routeId,
      providerModel: response.providerModel,
      replayed: journalState.replay === true,
    };
    const usage = { ...response.usage, occurredAt };
    const context = {
      digest: projection.digest,
      characters: projection.characters,
      compaction: projection.compaction,
    };
    const responseDigest = sha256(JSON.stringify(response.plan));
    let value;
    try {
      value = validatePlan(response.plan, { capabilityProfile, operation });
    } catch (error) {
      if (!(error instanceof ProviderProtocolError)) {
        throw error;
      }
      const receipt = {
        call,
        usage,
        context,
        responseDigest,
        error: safeProtocolError(error),
      };
      let persistedReceipt;
      try {
        persistedReceipt = await this.journal.completeInvalid({
          callId,
          requestDigest,
          routeId,
          receipt,
        });
      } catch (cause) {
        throw new ProviderAmbiguousCommitError(
          'Provider returned an invalid plan but its completion receipt could not be persisted',
          { cause },
        );
      }
      throw new ProviderProtocolError(error.message, { receipt: persistedReceipt });
    }
    const result = { value, call, usage, context };
    return this.journal.completeValid({ callId, requestDigest, routeId, result });
  }
}

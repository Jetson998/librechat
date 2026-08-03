import { createHash } from 'node:crypto';

export const ACTION_ENVELOPE_SCHEMA_VERSION = '1.0';
export const MAX_ACTION_PARAMETER_BYTES = 8 * 1024;

const MAX_OBJECTIVE_CHARS = 1_000;
const MAX_WORKER_CHARS = 120;
const MAX_REFERENCE_CHARS = 160;
const MAX_EXPECTED_CHANGE_CHARS = 240;
const MAX_SUMMARY_CHARS = 500;
const REFERENCE_PATTERN = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._-]{1,128}$/;
const ABSOLUTE_PATH_PATTERN = /^(?:\/(?:[^/]|$)|[A-Za-z]:[\\/]|\\\\)/;
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const FORBIDDEN_PARAMETER_KEY = /(?:command|script|credential|secret|password|token|authorization|apikey|api_key|baseurl|base_url|price|balance|prompt)/i;
const FAILURE_MODES = new Set(['replan', 'needs_input', 'fail']);

function assertText(value, field, maxChars) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (value.length > maxChars) {
    throw new TypeError(`${field} exceeds ${maxChars} characters`);
  }
  return value.trim();
}

function assertReference(value, field) {
  const reference = assertText(value, field, MAX_REFERENCE_CHARS);
  if (!REFERENCE_PATTERN.test(reference)) {
    throw new TypeError(`${field} must be a logical reference`);
  }
  return reference;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function rejectUnsafeParameterValue(value, path = 'parameters') {
  if (typeof value === 'string') {
    if (ABSOLUTE_PATH_PATTERN.test(value.trim()) || URL_PATTERN.test(value.trim())) {
      throw new TypeError(`${path} cannot contain an absolute path or URL`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectUnsafeParameterValue(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_PARAMETER_KEY.test(key)) {
        throw new TypeError(`${path}.${key} is not allowed in an Action Envelope`);
      }
      rejectUnsafeParameterValue(entry, `${path}.${key}`);
    }
  }
}

function normalizeParameters(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new TypeError('parameters must be an object');
  }
  rejectUnsafeParameterValue(parameters);
  const normalized = canonicalize(parameters);
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ACTION_PARAMETER_BYTES) {
    throw new TypeError(`parameters exceed ${MAX_ACTION_PARAMETER_BYTES} bytes`);
  }
  return normalized;
}

function normalizeExpectedChange(expectedChange) {
  if (!Array.isArray(expectedChange) || expectedChange.length > 20) {
    throw new TypeError('expectedChange must be an array with at most 20 entries');
  }
  return expectedChange.map((entry, index) =>
    assertText(entry, `expectedChange[${index}]`, MAX_EXPECTED_CHANGE_CHARS),
  );
}

export function normalizeActionEnvelope(action, { allowedWorkers } = {}) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new TypeError('Action Envelope must be an object');
  }
  const allowedKeys = new Set([
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
  ]);
  if (Object.keys(action).some((key) => !allowedKeys.has(key))) {
    throw new TypeError('Action Envelope contains unsupported fields');
  }
  if (action.schemaVersion !== ACTION_ENVELOPE_SCHEMA_VERSION) {
    throw new TypeError(`Action Envelope schemaVersion must be "${ACTION_ENVELOPE_SCHEMA_VERSION}"`);
  }
  const worker = assertText(action.worker, 'worker', MAX_WORKER_CHARS);
  if (allowedWorkers && !allowedWorkers.has(worker)) {
    throw new TypeError(`Action worker is not allowed: ${worker}`);
  }
  if (!Array.isArray(action.inputRefs) || action.inputRefs.length === 0 || action.inputRefs.length > 20) {
    throw new TypeError('inputRefs must contain between 1 and 20 references');
  }
  const inputRefs = action.inputRefs.map((entry, index) => assertReference(entry, `inputRefs[${index}]`));
  const targetRef = assertReference(action.targetRef, 'targetRef');
  const verificationProfile = assertText(action.verificationProfile, 'verificationProfile', MAX_WORKER_CHARS);
  const onFailure = assertText(action.onFailure, 'onFailure', 32);
  if (!FAILURE_MODES.has(onFailure)) {
    throw new TypeError(`Unsupported Action Envelope onFailure mode: ${onFailure}`);
  }
  const normalized = {
    schemaVersion: ACTION_ENVELOPE_SCHEMA_VERSION,
    objective: assertText(action.objective, 'objective', MAX_OBJECTIVE_CHARS),
    worker,
    inputRefs,
    targetRef,
    parameters: normalizeParameters(action.parameters),
    expectedChange: normalizeExpectedChange(action.expectedChange),
    verificationProfile,
    onFailure,
  };
  if (action.summary !== undefined) {
    normalized.summary = assertText(action.summary, 'summary', MAX_SUMMARY_CHARS);
  }
  return normalized;
}

function legacyActionForSignature(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new TypeError('Plan action must be an object');
  }
  if (typeof action.worker === 'string') {
    return normalizeActionEnvelope(action);
  }
  if (typeof action.kind !== 'string' || action.kind.trim() === '') {
    throw new TypeError('Plan action requires worker or kind');
  }
  return {
    schemaVersion: ACTION_ENVELOPE_SCHEMA_VERSION,
    objective: null,
    worker: action.kind.trim(),
    inputRefs: [],
    targetRef: null,
    parameters: {},
    expectedChange: [],
    verificationProfile: null,
    onFailure: null,
  };
}

export function canonicalActionForSignature(action) {
  const normalized = legacyActionForSignature(action);
  const { summary: _summary, objective: _objective, ...signature } = normalized;
  return canonicalize(signature);
}

export function actionSignature(actionsOrPlan) {
  const actions = Array.isArray(actionsOrPlan) ? actionsOrPlan : actionsOrPlan?.actions;
  if (!Array.isArray(actions)) {
    throw new TypeError('Plan actions must be an array');
  }
  const canonical = actions.map(canonicalActionForSignature);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

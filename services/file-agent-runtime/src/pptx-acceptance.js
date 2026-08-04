import { PPTX_MIME } from './constants.js';

export const PPTX_ACCEPTANCE_SCHEMA_VERSION = '1.0';
export const PPTX_ACCEPTANCE_TYPES = Object.freeze({
  SLIDE_PRESENT: 'pptx.slide_present.v1',
  TEXT_VALUE: 'pptx.text_value.v1',
  TABLE_CELL_VALUE: 'pptx.table_cell_value.v1',
  SLIDE_ORDER: 'pptx.slide_order.v1',
  ARTIFACT: 'pptx.artifact.v1',
});
export const PPTX_ARTIFACT_LOGICAL_ID = 'candidate:working-pptx';
export const PPTX_ACCEPTANCE_MAX_SERIALIZED_CHARS = 12_000;

const MAX_TEXT_CHARS = 4_000;
const MAX_SHAPE_NAME_CHARS = 128;
const PPTX_BUSINESS_CHANGE_TYPES = new Set([
  PPTX_ACCEPTANCE_TYPES.SLIDE_PRESENT,
  PPTX_ACCEPTANCE_TYPES.TEXT_VALUE,
  PPTX_ACCEPTANCE_TYPES.TABLE_CELL_VALUE,
  PPTX_ACCEPTANCE_TYPES.SLIDE_ORDER,
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

function requiredText(value, field, max = MAX_TEXT_CHARS) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new TypeError(`${field} exceeds ${max} characters`);
  }
  return value;
}

function positiveInteger(value, field, max = 200) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError(`${field} must be a positive integer no greater than ${max}`);
  }
  return value;
}

function shapeName(value, field) {
  return requiredText(value, field, MAX_SHAPE_NAME_CHARS);
}

function scalar(value, field) {
  if (
    value !== null &&
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    throw new TypeError(`${field} must be a string, number, boolean, or null`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`${field} must be finite`);
  }
  if (typeof value === 'string' && value.length > MAX_TEXT_CHARS) {
    throw new TypeError(`${field} exceeds ${MAX_TEXT_CHARS} characters`);
  }
  return value;
}

function normalizeAssertion(assertion, index) {
  if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) {
    throw new TypeError(`acceptanceAssertions[${index}] must be an object`);
  }
  if (
    assertion.schemaVersion != null &&
    assertion.schemaVersion !== PPTX_ACCEPTANCE_SCHEMA_VERSION
  ) {
    throw new TypeError(`acceptanceAssertions[${index}].schemaVersion must be "1.0"`);
  }
  const type = assertion.type ?? assertion.kind;
  if (!Object.values(PPTX_ACCEPTANCE_TYPES).includes(type)) {
    throw new TypeError(`acceptanceAssertions[${index}].type is unsupported`);
  }
  if (type === PPTX_ACCEPTANCE_TYPES.SLIDE_PRESENT) {
    return {
      schemaVersion: PPTX_ACCEPTANCE_SCHEMA_VERSION,
      type,
      slide: positiveInteger(assertion.slide, `acceptanceAssertions[${index}].slide`),
    };
  }
  if (
    type === PPTX_ACCEPTANCE_TYPES.TEXT_VALUE ||
    type === PPTX_ACCEPTANCE_TYPES.TABLE_CELL_VALUE
  ) {
    const normalized = {
      schemaVersion: PPTX_ACCEPTANCE_SCHEMA_VERSION,
      type,
      slide: positiveInteger(assertion.slide, `acceptanceAssertions[${index}].slide`),
      shape: shapeName(assertion.shape, `acceptanceAssertions[${index}].shape`),
    };
    if (type === PPTX_ACCEPTANCE_TYPES.TABLE_CELL_VALUE) {
      normalized.row = positiveInteger(assertion.row, `acceptanceAssertions[${index}].row`, 200) - 1;
      normalized.column = positiveInteger(assertion.column, `acceptanceAssertions[${index}].column`, 200) - 1;
    }
    normalized.value = scalar(assertion.value, `acceptanceAssertions[${index}].value`);
    return normalized;
  }
  if (type === PPTX_ACCEPTANCE_TYPES.SLIDE_ORDER) {
    if (!Array.isArray(assertion.order) || assertion.order.length === 0 || assertion.order.length > 200) {
      throw new TypeError(`acceptanceAssertions[${index}].order must contain between 1 and 200 slide numbers`);
    }
    const order = assertion.order.map((slide, orderIndex) =>
      positiveInteger(slide, `acceptanceAssertions[${index}].order[${orderIndex}]`));
    if (new Set(order).size !== order.length) {
      throw new TypeError(`acceptanceAssertions[${index}].order must not contain duplicate slide numbers`);
    }
    return {
      schemaVersion: PPTX_ACCEPTANCE_SCHEMA_VERSION,
      type,
      order,
    };
  }
  const logicalId = assertion.logicalId ?? PPTX_ARTIFACT_LOGICAL_ID;
  if (logicalId !== PPTX_ARTIFACT_LOGICAL_ID) {
    throw new TypeError(
      `acceptanceAssertions[${index}].logicalId must be ${PPTX_ARTIFACT_LOGICAL_ID}`,
    );
  }
  if ((assertion.mimeType ?? PPTX_MIME) !== PPTX_MIME) {
    throw new TypeError('PPTX artifact acceptance must require a PPTX MIME type');
  }
  if ((assertion.maxCount ?? 1) !== 1) {
    throw new TypeError('PPTX artifact acceptance must require exactly one artifact');
  }
  return {
    schemaVersion: PPTX_ACCEPTANCE_SCHEMA_VERSION,
    type,
    logicalId: PPTX_ARTIFACT_LOGICAL_ID,
    mimeType: PPTX_MIME,
    maxCount: 1,
  };
}

export function normalizePptxAcceptanceAssertions(
  value,
  { requireBusinessChange = true } = {},
) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) {
    throw new TypeError('PPTX acceptanceAssertions must contain between 1 and 24 entries');
  }
  const normalized = value.map(normalizeAssertion);
  const artifacts = normalized.filter((assertion) => assertion.type === PPTX_ACCEPTANCE_TYPES.ARTIFACT);
  if (artifacts.length > 1) {
    throw new TypeError('PPTX acceptanceAssertions may contain only one artifact assertion');
  }
  if (
    requireBusinessChange &&
    !normalized.some((assertion) => PPTX_BUSINESS_CHANGE_TYPES.has(assertion.type))
  ) {
    throw new TypeError('PPTX acceptanceAssertions must include an independent presentation assertion');
  }
  if (artifacts.length === 0) {
    normalized.push({
      schemaVersion: PPTX_ACCEPTANCE_SCHEMA_VERSION,
      type: PPTX_ACCEPTANCE_TYPES.ARTIFACT,
      logicalId: PPTX_ARTIFACT_LOGICAL_ID,
      mimeType: PPTX_MIME,
      maxCount: 1,
    });
  }
  if (JSON.stringify(normalized).length > PPTX_ACCEPTANCE_MAX_SERIALIZED_CHARS) {
    throw new TypeError(
      `PPTX acceptanceAssertions exceed ${PPTX_ACCEPTANCE_MAX_SERIALIZED_CHARS} serialized characters`,
    );
  }
  return deepFreeze(normalized);
}

export function isPptxBusinessAssertion(assertion) {
  return PPTX_BUSINESS_CHANGE_TYPES.has(assertion?.type);
}

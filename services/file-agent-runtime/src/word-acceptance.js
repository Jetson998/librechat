import { DOCX_MIME } from './constants.js';

export const WORD_ACCEPTANCE_SCHEMA_VERSION = '1.0';
export const WORD_ACCEPTANCE_TYPES = Object.freeze({
  TEXT_REPLACE: 'word.text_replace.v1',
  PARAGRAPH_APPEND: 'word.paragraph_append.v1',
  TABLE_CELL_REPLACE: 'word.table_cell_replace.v1',
  ARTIFACT: 'word.artifact.v1',
});
export const WORD_ARTIFACT_LOGICAL_ID = 'candidate:working-docx';
export const WORD_ACCEPTANCE_MAX_SERIALIZED_CHARS = 8_000;

const MAX_TEXT_CHARS = 4_000;

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

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_TEXT_CHARS) {
    throw new TypeError(`${field} exceeds ${MAX_TEXT_CHARS} characters`);
  }
  return value;
}

function optionalStyle(value) {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_ -]{0,63}$/.test(value)) {
    throw new TypeError('Word acceptance style is invalid');
  }
  return value;
}

function indexField(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function normalizeAssertion(assertion, index) {
  if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) {
    throw new TypeError(`acceptanceAssertions[${index}] must be an object`);
  }
  if (assertion.schemaVersion != null && assertion.schemaVersion !== WORD_ACCEPTANCE_SCHEMA_VERSION) {
    throw new TypeError(`acceptanceAssertions[${index}].schemaVersion must be "1.0"`);
  }
  const type = assertion.type ?? assertion.kind;
  if (!Object.values(WORD_ACCEPTANCE_TYPES).includes(type)) {
    throw new TypeError(`acceptanceAssertions[${index}].type is unsupported`);
  }

  if (type === WORD_ACCEPTANCE_TYPES.TEXT_REPLACE) {
    const occurrence = assertion.occurrence ?? 1;
    if (!Number.isSafeInteger(occurrence) || occurrence < 1) {
      throw new TypeError(`acceptanceAssertions[${index}].occurrence must be a positive integer`);
    }
    if (typeof assertion.replace !== 'string') {
      throw new TypeError(`acceptanceAssertions[${index}].replace must be a string`);
    }
    if (assertion.replace.length > MAX_TEXT_CHARS) {
      throw new TypeError(`acceptanceAssertions[${index}].replace exceeds ${MAX_TEXT_CHARS} characters`);
    }
    return {
      schemaVersion: WORD_ACCEPTANCE_SCHEMA_VERSION,
      type,
      find: requiredText(assertion.find, `acceptanceAssertions[${index}].find`),
      replace: assertion.replace,
      occurrence,
    };
  }

  if (type === WORD_ACCEPTANCE_TYPES.PARAGRAPH_APPEND) {
    const style = optionalStyle(assertion.style);
    return {
      schemaVersion: WORD_ACCEPTANCE_SCHEMA_VERSION,
      type,
      text: requiredText(assertion.text, `acceptanceAssertions[${index}].text`),
      ...(style ? { style } : {}),
    };
  }

  if (type === WORD_ACCEPTANCE_TYPES.TABLE_CELL_REPLACE) {
    return {
      schemaVersion: WORD_ACCEPTANCE_SCHEMA_VERSION,
      type,
      tableIndex: indexField(assertion.tableIndex, `acceptanceAssertions[${index}].tableIndex`),
      rowIndex: indexField(assertion.rowIndex, `acceptanceAssertions[${index}].rowIndex`),
      columnIndex: indexField(assertion.columnIndex, `acceptanceAssertions[${index}].columnIndex`),
      text: requiredText(assertion.text, `acceptanceAssertions[${index}].text`),
    };
  }

  const logicalId = assertion.logicalId ?? WORD_ARTIFACT_LOGICAL_ID;
  if (typeof logicalId !== 'string' || logicalId.trim() === '') {
    throw new TypeError(`acceptanceAssertions[${index}].logicalId is required`);
  }
  if (logicalId.trim() !== WORD_ARTIFACT_LOGICAL_ID) {
    throw new TypeError(
      `acceptanceAssertions[${index}].logicalId must be ${WORD_ARTIFACT_LOGICAL_ID}`,
    );
  }
  if ((assertion.mimeType ?? DOCX_MIME) !== DOCX_MIME) {
    throw new TypeError('Word artifact acceptance must require a DOCX MIME type');
  }
  const maxCount = assertion.maxCount ?? 1;
  if (maxCount !== 1) {
    throw new TypeError('Word artifact acceptance must require exactly one artifact');
  }
  return {
    schemaVersion: WORD_ACCEPTANCE_SCHEMA_VERSION,
    type,
    logicalId: WORD_ARTIFACT_LOGICAL_ID,
    mimeType: DOCX_MIME,
    maxCount: 1,
  };
}

export function normalizeWordAcceptanceAssertions(
  value,
  { requireBusinessChange = true } = {},
) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new TypeError('Word acceptanceAssertions must contain between 1 and 16 entries');
  }
  const normalized = value.map(normalizeAssertion);
  const artifactAssertions = normalized.filter(
    (assertion) => assertion.type === WORD_ACCEPTANCE_TYPES.ARTIFACT,
  );
  if (artifactAssertions.length > 1) {
    throw new TypeError('Word acceptanceAssertions may contain only one artifact assertion');
  }
  if (requireBusinessChange && normalized.every(
    (assertion) => assertion.type === WORD_ACCEPTANCE_TYPES.ARTIFACT,
  )) {
    throw new TypeError('Word acceptanceAssertions must include an independent document change assertion');
  }
  if (artifactAssertions.length === 0) {
    normalized.push({
      schemaVersion: WORD_ACCEPTANCE_SCHEMA_VERSION,
      type: WORD_ACCEPTANCE_TYPES.ARTIFACT,
      logicalId: WORD_ARTIFACT_LOGICAL_ID,
      mimeType: DOCX_MIME,
      maxCount: 1,
    });
  }
  if (JSON.stringify(normalized).length > WORD_ACCEPTANCE_MAX_SERIALIZED_CHARS) {
    throw new TypeError(
      `Word acceptanceAssertions exceed ${WORD_ACCEPTANCE_MAX_SERIALIZED_CHARS} serialized characters`,
    );
  }
  return deepFreeze(normalized);
}

export function isWordChangeAssertion(assertion) {
  return assertion?.type != null && assertion.type !== WORD_ACCEPTANCE_TYPES.ARTIFACT;
}

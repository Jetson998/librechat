import { PPTX_MIME } from './constants.js';

export const OFFICE_COMPOSE_ACCEPTANCE_SCHEMA_VERSION = '1.0';
export const OFFICE_COMPOSE_ACCEPTANCE_TYPES = Object.freeze({
  SECTION_PRESENT: 'compose.section_present.v1',
  SOURCE_VALUE: 'compose.source_value.v1',
  SOURCE_MAPPING: 'compose.source_mapping.v1',
  SOURCE_HASH: 'compose.source_hash.v1',
  ARTIFACT: 'compose.artifact.v1',
});
export const OFFICE_COMPOSE_ARTIFACT_LOGICAL_ID = 'candidate:working-pptx';
export const OFFICE_COMPOSE_MAX_INPUTS = 2;
export const OFFICE_COMPOSE_MAX_SLIDES = 12;
export const OFFICE_COMPOSE_ACCEPTANCE_MAX_SERIALIZED_CHARS = 16_000;

const MAX_TEXT_CHARS = 4_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const LOGICAL_ID_PATTERN = /^source:[a-z][a-z0-9._-]{0,63}$/;
const LOCATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._!$:#\-\[\]]{0,159}$/u;

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

function logicalId(value, field) {
  const normalized = requiredText(value, field, 72);
  if (!LOGICAL_ID_PATTERN.test(normalized)) {
    throw new TypeError(`${field} must be a source logical ID`);
  }
  return normalized;
}

function location(value, field) {
  const normalized = requiredText(value, field, 160);
  if (!LOCATION_PATTERN.test(normalized)) {
    throw new TypeError(`${field} must be a bounded source location`);
  }
  return normalized;
}

function positiveInteger(value, field, max = OFFICE_COMPOSE_MAX_SLIDES) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError(`${field} must be a positive integer no greater than ${max}`);
  }
  return value;
}

function targetShape(value, field) {
  const normalized = requiredText(value, field, 16);
  if (!['title', 'body'].includes(normalized)) {
    throw new TypeError(`${field} must be title or body`);
  }
  return normalized;
}

function normalizeAssertion(assertion, index) {
  if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) {
    throw new TypeError(`acceptanceAssertions[${index}] must be an object`);
  }
  if (
    assertion.schemaVersion != null &&
    assertion.schemaVersion !== OFFICE_COMPOSE_ACCEPTANCE_SCHEMA_VERSION
  ) {
    throw new TypeError(`acceptanceAssertions[${index}].schemaVersion must be "1.0"`);
  }
  const type = assertion.type ?? assertion.kind;
  if (!Object.values(OFFICE_COMPOSE_ACCEPTANCE_TYPES).includes(type)) {
    throw new TypeError(`acceptanceAssertions[${index}].type is unsupported`);
  }

  if (type === OFFICE_COMPOSE_ACCEPTANCE_TYPES.SECTION_PRESENT) {
    return {
      schemaVersion: OFFICE_COMPOSE_ACCEPTANCE_SCHEMA_VERSION,
      type,
      slide: positiveInteger(assertion.slide, `acceptanceAssertions[${index}].slide`),
      title: requiredText(assertion.title, `acceptanceAssertions[${index}].title`, 400),
    };
  }

  if (type === OFFICE_COMPOSE_ACCEPTANCE_TYPES.SOURCE_VALUE) {
    const value = assertion.value;
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new TypeError(`acceptanceAssertions[${index}].value must be a scalar`);
    }
    if (typeof value === 'string' && value.length > MAX_TEXT_CHARS) {
      throw new TypeError(`acceptanceAssertions[${index}].value exceeds ${MAX_TEXT_CHARS} characters`);
    }
    return {
      schemaVersion: OFFICE_COMPOSE_ACCEPTANCE_SCHEMA_VERSION,
      type,
      sourceLogicalId: logicalId(
        assertion.sourceLogicalId,
        `acceptanceAssertions[${index}].sourceLogicalId`,
      ),
      sourceLocation: location(
        assertion.sourceLocation,
        `acceptanceAssertions[${index}].sourceLocation`,
      ),
      targetSlide: positiveInteger(
        assertion.targetSlide,
        `acceptanceAssertions[${index}].targetSlide`,
      ),
      targetShape: targetShape(assertion.targetShape, `acceptanceAssertions[${index}].targetShape`),
      value,
    };
  }

  if (type === OFFICE_COMPOSE_ACCEPTANCE_TYPES.SOURCE_MAPPING) {
    return {
      schemaVersion: OFFICE_COMPOSE_ACCEPTANCE_SCHEMA_VERSION,
      type,
      sourceLogicalId: logicalId(
        assertion.sourceLogicalId,
        `acceptanceAssertions[${index}].sourceLogicalId`,
      ),
      sourceLocation: location(
        assertion.sourceLocation,
        `acceptanceAssertions[${index}].sourceLocation`,
      ),
      targetSlide: positiveInteger(
        assertion.targetSlide,
        `acceptanceAssertions[${index}].targetSlide`,
      ),
      targetShape: targetShape(assertion.targetShape, `acceptanceAssertions[${index}].targetShape`),
    };
  }

  if (type === OFFICE_COMPOSE_ACCEPTANCE_TYPES.SOURCE_HASH) {
    if (!SHA256_PATTERN.test(assertion.sha256 ?? '')) {
      throw new TypeError(`acceptanceAssertions[${index}].sha256 must be a SHA-256 digest`);
    }
    return {
      schemaVersion: OFFICE_COMPOSE_ACCEPTANCE_SCHEMA_VERSION,
      type,
      sourceLogicalId: logicalId(
        assertion.sourceLogicalId,
        `acceptanceAssertions[${index}].sourceLogicalId`,
      ),
      sha256: assertion.sha256.toLowerCase(),
    };
  }

  const logicalArtifactId = assertion.logicalId ?? OFFICE_COMPOSE_ARTIFACT_LOGICAL_ID;
  if (logicalArtifactId !== OFFICE_COMPOSE_ARTIFACT_LOGICAL_ID) {
    throw new TypeError(
      `acceptanceAssertions[${index}].logicalId must be ${OFFICE_COMPOSE_ARTIFACT_LOGICAL_ID}`,
    );
  }
  if ((assertion.mimeType ?? PPTX_MIME) !== PPTX_MIME) {
    throw new TypeError('Office Compose artifact acceptance must require a PPTX MIME type');
  }
  if ((assertion.maxCount ?? 1) !== 1) {
    throw new TypeError('Office Compose artifact acceptance must require exactly one artifact');
  }
  return {
    schemaVersion: OFFICE_COMPOSE_ACCEPTANCE_SCHEMA_VERSION,
    type,
    logicalId: OFFICE_COMPOSE_ARTIFACT_LOGICAL_ID,
    mimeType: PPTX_MIME,
    maxCount: 1,
  };
}

export function normalizeOfficeComposeAcceptanceAssertions(value, { requireBusinessChange = true } = {}) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new TypeError('Office Compose acceptanceAssertions must contain between 1 and 32 entries');
  }
  const normalized = value.map(normalizeAssertion);
  const artifacts = normalized.filter(
    (assertion) => assertion.type === OFFICE_COMPOSE_ACCEPTANCE_TYPES.ARTIFACT,
  );
  if (artifacts.length > 1) {
    throw new TypeError('Office Compose acceptanceAssertions may contain only one artifact assertion');
  }
  const businessTypes = new Set([
    OFFICE_COMPOSE_ACCEPTANCE_TYPES.SECTION_PRESENT,
    OFFICE_COMPOSE_ACCEPTANCE_TYPES.SOURCE_VALUE,
    OFFICE_COMPOSE_ACCEPTANCE_TYPES.SOURCE_MAPPING,
    OFFICE_COMPOSE_ACCEPTANCE_TYPES.SOURCE_HASH,
  ]);
  if (requireBusinessChange && !normalized.some((assertion) => businessTypes.has(assertion.type))) {
    throw new TypeError('Office Compose acceptanceAssertions must include an independent source assertion');
  }
  if (artifacts.length === 0) {
    normalized.push({
      schemaVersion: OFFICE_COMPOSE_ACCEPTANCE_SCHEMA_VERSION,
      type: OFFICE_COMPOSE_ACCEPTANCE_TYPES.ARTIFACT,
      logicalId: OFFICE_COMPOSE_ARTIFACT_LOGICAL_ID,
      mimeType: PPTX_MIME,
      maxCount: 1,
    });
  }
  if (JSON.stringify(normalized).length > OFFICE_COMPOSE_ACCEPTANCE_MAX_SERIALIZED_CHARS) {
    throw new TypeError(
      `Office Compose acceptanceAssertions exceed ${OFFICE_COMPOSE_ACCEPTANCE_MAX_SERIALIZED_CHARS} serialized characters`,
    );
  }
  return deepFreeze(normalized);
}

export function isOfficeComposeBusinessAssertion(assertion) {
  return [
    OFFICE_COMPOSE_ACCEPTANCE_TYPES.SECTION_PRESENT,
    OFFICE_COMPOSE_ACCEPTANCE_TYPES.SOURCE_VALUE,
    OFFICE_COMPOSE_ACCEPTANCE_TYPES.SOURCE_MAPPING,
    OFFICE_COMPOSE_ACCEPTANCE_TYPES.SOURCE_HASH,
  ].includes(assertion?.type);
}

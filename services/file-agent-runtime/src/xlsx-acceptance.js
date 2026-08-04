import { XLSX_MIME } from './constants.js';

export const XLSX_ACCEPTANCE_SCHEMA_VERSION = '1.0';
export const XLSX_ACCEPTANCE_TYPES = Object.freeze({
  SHEET_PRESENT: 'xlsx.sheet_present.v1',
  CELL_VALUE: 'xlsx.cell_value.v1',
  FORMULA: 'xlsx.formula.v1',
  NUMBER_FORMAT: 'xlsx.number_format.v1',
  PROTECTED_CELL: 'xlsx.protected_cell.v1',
  ARTIFACT: 'xlsx.artifact.v1',
});
export const XLSX_ARTIFACT_LOGICAL_ID = 'candidate:working-xlsx';
export const XLSX_ACCEPTANCE_MAX_SERIALIZED_CHARS = 12_000;

const MAX_TEXT_CHARS = 4_000;
const CELL_PATTERN = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/;
const SHEET_PATTERN = /^[^\\/*?:\[\]]{1,31}$/;
const XLSX_BUSINESS_CHANGE_TYPES = new Set([
  XLSX_ACCEPTANCE_TYPES.SHEET_PRESENT,
  XLSX_ACCEPTANCE_TYPES.CELL_VALUE,
  XLSX_ACCEPTANCE_TYPES.FORMULA,
  XLSX_ACCEPTANCE_TYPES.NUMBER_FORMAT,
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

function sheetName(value, field) {
  const name = requiredText(value, field, 31);
  if (!SHEET_PATTERN.test(name)) {
    throw new TypeError(`${field} is not a valid XLSX sheet name`);
  }
  return name;
}

function cellReference(value, field) {
  const cell = requiredText(value, field, 10).toUpperCase();
  if (!CELL_PATTERN.test(cell)) {
    throw new TypeError(`${field} is not a valid XLSX cell reference`);
  }
  return cell;
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
    assertion.schemaVersion !== XLSX_ACCEPTANCE_SCHEMA_VERSION
  ) {
    throw new TypeError(`acceptanceAssertions[${index}].schemaVersion must be "1.0"`);
  }
  const type = assertion.type ?? assertion.kind;
  if (!Object.values(XLSX_ACCEPTANCE_TYPES).includes(type)) {
    throw new TypeError(`acceptanceAssertions[${index}].type is unsupported`);
  }

  if (type === XLSX_ACCEPTANCE_TYPES.SHEET_PRESENT) {
    return {
      schemaVersion: XLSX_ACCEPTANCE_SCHEMA_VERSION,
      type,
      sheet: sheetName(assertion.sheet, `acceptanceAssertions[${index}].sheet`),
    };
  }

  if (
    type === XLSX_ACCEPTANCE_TYPES.CELL_VALUE ||
    type === XLSX_ACCEPTANCE_TYPES.FORMULA ||
    type === XLSX_ACCEPTANCE_TYPES.NUMBER_FORMAT ||
    type === XLSX_ACCEPTANCE_TYPES.PROTECTED_CELL
  ) {
    const normalized = {
      schemaVersion: XLSX_ACCEPTANCE_SCHEMA_VERSION,
      type,
      sheet: sheetName(assertion.sheet, `acceptanceAssertions[${index}].sheet`),
      cell: cellReference(assertion.cell, `acceptanceAssertions[${index}].cell`),
    };
    if (type === XLSX_ACCEPTANCE_TYPES.FORMULA) {
      normalized.formula = requiredText(
        assertion.formula,
        `acceptanceAssertions[${index}].formula`,
      );
    } else if (type === XLSX_ACCEPTANCE_TYPES.NUMBER_FORMAT) {
      normalized.numberFormat = requiredText(
        assertion.numberFormat,
        `acceptanceAssertions[${index}].numberFormat`,
        256,
      );
    } else {
      normalized.value = scalar(assertion.value, `acceptanceAssertions[${index}].value`);
    }
    return normalized;
  }

  const logicalId = assertion.logicalId ?? XLSX_ARTIFACT_LOGICAL_ID;
  if (logicalId !== XLSX_ARTIFACT_LOGICAL_ID) {
    throw new TypeError(
      `acceptanceAssertions[${index}].logicalId must be ${XLSX_ARTIFACT_LOGICAL_ID}`,
    );
  }
  if ((assertion.mimeType ?? XLSX_MIME) !== XLSX_MIME) {
    throw new TypeError('XLSX artifact acceptance must require an XLSX MIME type');
  }
  if ((assertion.maxCount ?? 1) !== 1) {
    throw new TypeError('XLSX artifact acceptance must require exactly one artifact');
  }
  return {
    schemaVersion: XLSX_ACCEPTANCE_SCHEMA_VERSION,
    type,
    logicalId: XLSX_ARTIFACT_LOGICAL_ID,
    mimeType: XLSX_MIME,
    maxCount: 1,
  };
}

export function normalizeXlsxAcceptanceAssertions(
  value,
  { requireBusinessChange = true } = {},
) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) {
    throw new TypeError('XLSX acceptanceAssertions must contain between 1 and 24 entries');
  }
  const normalized = value.map(normalizeAssertion);
  const artifacts = normalized.filter((assertion) => assertion.type === XLSX_ACCEPTANCE_TYPES.ARTIFACT);
  if (artifacts.length > 1) {
    throw new TypeError('XLSX acceptanceAssertions may contain only one artifact assertion');
  }
  if (
    requireBusinessChange &&
    !normalized.some((assertion) => XLSX_BUSINESS_CHANGE_TYPES.has(assertion.type))
  ) {
    throw new TypeError('XLSX acceptanceAssertions must include an independent workbook assertion');
  }
  if (artifacts.length === 0) {
    normalized.push({
      schemaVersion: XLSX_ACCEPTANCE_SCHEMA_VERSION,
      type: XLSX_ACCEPTANCE_TYPES.ARTIFACT,
      logicalId: XLSX_ARTIFACT_LOGICAL_ID,
      mimeType: XLSX_MIME,
      maxCount: 1,
    });
  }
  if (JSON.stringify(normalized).length > XLSX_ACCEPTANCE_MAX_SERIALIZED_CHARS) {
    throw new TypeError(
      `XLSX acceptanceAssertions exceed ${XLSX_ACCEPTANCE_MAX_SERIALIZED_CHARS} serialized characters`,
    );
  }
  return deepFreeze(normalized);
}

export function isXlsxBusinessAssertion(assertion) {
  return XLSX_BUSINESS_CHANGE_TYPES.has(assertion?.type);
}

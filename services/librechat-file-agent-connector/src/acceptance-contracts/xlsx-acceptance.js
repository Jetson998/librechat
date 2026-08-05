import { XLSX_MIME } from '../constants.js';

export const XLSX_ACCEPTANCE_SCHEMA_VERSION = '1.0';
export const XLSX_ACCEPTANCE_TYPES = Object.freeze({
  SHEET_PRESENT: 'xlsx.sheet_present.v1',
  SHEET_ABSENT: 'xlsx.sheet_absent.v1',
  SHEET_RENAME: 'xlsx.sheet_rename.v1',
  SHEET_ORDER: 'xlsx.sheet_order.v1',
  CELL_VALUE: 'xlsx.cell_value.v1',
  FORMULA: 'xlsx.formula.v1',
  NUMBER_FORMAT: 'xlsx.number_format.v1',
  STYLE: 'xlsx.style.v1',
  TABLE_PRESENT: 'xlsx.table_present.v1',
  CHART_PRESENT: 'xlsx.chart_present.v1',
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
  XLSX_ACCEPTANCE_TYPES.SHEET_ABSENT,
  XLSX_ACCEPTANCE_TYPES.SHEET_RENAME,
  XLSX_ACCEPTANCE_TYPES.SHEET_ORDER,
  XLSX_ACCEPTANCE_TYPES.CELL_VALUE,
  XLSX_ACCEPTANCE_TYPES.FORMULA,
  XLSX_ACCEPTANCE_TYPES.NUMBER_FORMAT,
  XLSX_ACCEPTANCE_TYPES.STYLE,
  XLSX_ACCEPTANCE_TYPES.TABLE_PRESENT,
  XLSX_ACCEPTANCE_TYPES.CHART_PRESENT,
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

  if (type === XLSX_ACCEPTANCE_TYPES.SHEET_ABSENT) {
    return {
      schemaVersion: XLSX_ACCEPTANCE_SCHEMA_VERSION,
      type,
      sheet: sheetName(assertion.sheet, `acceptanceAssertions[${index}].sheet`),
    };
  }

  if (type === XLSX_ACCEPTANCE_TYPES.SHEET_RENAME) {
    const from = sheetName(assertion.from, `acceptanceAssertions[${index}].from`);
    const to = sheetName(assertion.to, `acceptanceAssertions[${index}].to`);
    if (from === to) {
      throw new TypeError(`acceptanceAssertions[${index}].from and .to must differ`);
    }
    return { schemaVersion: XLSX_ACCEPTANCE_SCHEMA_VERSION, type, from, to };
  }

  if (type === XLSX_ACCEPTANCE_TYPES.SHEET_ORDER) {
    if (!Array.isArray(assertion.order) || assertion.order.length < 1 || assertion.order.length > 64) {
      throw new TypeError(`acceptanceAssertions[${index}].order must contain between 1 and 64 sheets`);
    }
    const order = assertion.order.map((value, orderIndex) =>
      sheetName(value, `acceptanceAssertions[${index}].order[${orderIndex}]`));
    if (new Set(order).size !== order.length) {
      throw new TypeError(`acceptanceAssertions[${index}].order must not contain duplicate sheets`);
    }
    return { schemaVersion: XLSX_ACCEPTANCE_SCHEMA_VERSION, type, order };
  }

  if (
    type === XLSX_ACCEPTANCE_TYPES.CELL_VALUE ||
    type === XLSX_ACCEPTANCE_TYPES.FORMULA ||
    type === XLSX_ACCEPTANCE_TYPES.NUMBER_FORMAT ||
    type === XLSX_ACCEPTANCE_TYPES.STYLE ||
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
    } else if (type === XLSX_ACCEPTANCE_TYPES.STYLE) {
      const style = assertion.style;
      if (!style || typeof style !== 'object' || Array.isArray(style)) {
        throw new TypeError(`acceptanceAssertions[${index}].style must be an object`);
      }
      const normalizedStyle = {};
      if (style.fontBold != null) {
        if (typeof style.fontBold !== 'boolean') throw new TypeError(`acceptanceAssertions[${index}].style.fontBold must be boolean`);
        normalizedStyle.fontBold = style.fontBold;
      }
      for (const field of ['fontColor', 'fillColor']) {
        if (style[field] != null) {
          if (typeof style[field] !== 'string' || !/^[0-9a-f]{6}$/iu.test(style[field])) {
            throw new TypeError(`acceptanceAssertions[${index}].style.${field} must be a six-digit color`);
          }
          normalizedStyle[field] = style[field].toUpperCase();
        }
      }
      if (style.horizontalAlignment != null) {
        if (!['left', 'center', 'right', 'general'].includes(style.horizontalAlignment)) {
          throw new TypeError(`acceptanceAssertions[${index}].style.horizontalAlignment is unsupported`);
        }
        normalizedStyle.horizontalAlignment = style.horizontalAlignment;
      }
      if (style.numberFormat != null) {
        normalizedStyle.numberFormat = requiredText(style.numberFormat, `acceptanceAssertions[${index}].style.numberFormat`, 256);
      }
      if (Object.keys(normalizedStyle).length === 0) {
        throw new TypeError(`acceptanceAssertions[${index}].style must change at least one property`);
      }
      normalized.style = normalizedStyle;
    } else {
      normalized.value = scalar(assertion.value, `acceptanceAssertions[${index}].value`);
    }
    return normalized;
  }

  if (type === XLSX_ACCEPTANCE_TYPES.TABLE_PRESENT) {
    return {
      schemaVersion: XLSX_ACCEPTANCE_SCHEMA_VERSION,
      type,
      sheet: sheetName(assertion.sheet, `acceptanceAssertions[${index}].sheet`),
      tableName: requiredText(assertion.tableName, `acceptanceAssertions[${index}].tableName`, 255),
      ref: requiredText(assertion.ref, `acceptanceAssertions[${index}].ref`, 64),
    };
  }

  if (type === XLSX_ACCEPTANCE_TYPES.CHART_PRESENT) {
    return {
      schemaVersion: XLSX_ACCEPTANCE_SCHEMA_VERSION,
      type,
      sheet: sheetName(assertion.sheet, `acceptanceAssertions[${index}].sheet`),
      chartType: requiredText(assertion.chartType, `acceptanceAssertions[${index}].chartType`, 32),
      title: requiredText(assertion.title, `acceptanceAssertions[${index}].title`, 400),
    };
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

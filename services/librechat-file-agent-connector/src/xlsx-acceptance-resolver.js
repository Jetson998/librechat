import { XLSX_MIME } from './constants.js';
import {
  normalizeXlsxAcceptanceAssertions,
  XLSX_ACCEPTANCE_TYPES,
} from '../../file-agent-runtime/src/xlsx-acceptance.js';

export const XLSX_ACCEPTANCE_RESOLVER_VERSION = '1.0.0';

const MAX_INSTRUCTION_CHARS = 8_000;
const MAX_BUSINESS_ASSERTIONS = 6;
const QUOTED_CAPTURE = String.raw`(?:"([^"\r\n]+)"|“([^”\r\n]+)”|「([^」\r\n]+)」|『([^』\r\n]+)』|\x60([^\x60\r\n]+)\x60)`;
const VALUE_CAPTURE = String.raw`(?:${QUOTED_CAPTURE}|(-?(?:\d+(?:\.\d+)?|true|false|null)))`;
const LOCATION_CAPTURE = String.raw`(?:(?:"([^"\r\n!]{1,31})"|“([^”\r\n!]{1,31})”|([A-Za-z0-9_][A-Za-z0-9 _.-]{0,30}))\s*!\s*([A-Z]{1,3}[1-9][0-9]{0,6})|(?:"([A-Za-z0-9_][A-Za-z0-9 _.-]{0,30})!([A-Z]{1,3}[1-9][0-9]{0,6})"))`;
const CLAUSE_SEPARATOR = /[，,；;。、]|并且|同时|然后|而且|以及|并|\band\b|\bthen\b|\balso\b/giu;
const DELIVERY_PADDING = String.raw`[\s:：!！?？、。；;，,（）()【】\[\]{}]`;
const NON_ACTION_PADDING = new RegExp(String.raw`^(?:${DELIVERY_PADDING})*$`, 'u');
const CHINESE_DELIVERY_CLAUSE = new RegExp(
  String.raw`^${DELIVERY_PADDING}*(?:请|帮我|麻烦)?\s*(?:交付|提交|输出|返回|提供|下载|保存|生成)\s*(?:一个|一份|一)?\s*(?:经过验证的|已验证的|验证的|最终|修订版)?\s*(?:XLSX\s*(?:文件)?|Excel\s*(?:工作簿|文件)?|工作簿|电子表格|文件)${DELIVERY_PADDING}*$`,
  'iu',
);
const ENGLISH_DELIVERY_CLAUSE = new RegExp(
  String.raw`^${DELIVERY_PADDING}*(?:please|kindly)?\s*(?:deliver|submit|output|return|provide|download|save|produce)\s+(?:(?:a|an|one|the)\s+)?(?:(?:verified|validated|revised|final)\s+)?(?:xlsx(?:\s+file)?|excel\s+workbook|workbook|spreadsheet|file|artifact)${DELIVERY_PADDING}*$`,
  'iu',
);
const SHEET_NAME_PATTERN = /^[^\\/*?:\[\]]{1,31}$/u;
const CELL_PATTERN = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/u;

function quotedValue(match, start) {
  return match.slice(start, start + 5).find((value) => typeof value === 'string') ?? null;
}

function scalarValue(match, start) {
  const quoted = quotedValue(match, start);
  if (quoted != null) {
    return quoted;
  }
  const raw = match[start + 5];
  if (raw == null) {
    return null;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  if (raw === 'null') {
    return null;
  }
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function locationValue(match) {
  const sheet = match.slice(1, 4).find((value) => typeof value === 'string') ?? match[5];
  const cell = match[4] ?? match[6];
  if (!sheet || !cell) {
    return null;
  }
  const normalizedSheet = sheet.trim();
  const normalizedCell = cell.toUpperCase();
  if (!SHEET_NAME_PATTERN.test(normalizedSheet) || !CELL_PATTERN.test(normalizedCell)) {
    return null;
  }
  return { sheet: normalizedSheet, cell: normalizedCell };
}

function addAssertion(assertions, seen, assertion, start, end) {
  const key = `${start}:${JSON.stringify(assertion)}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  assertions.push({ assertion, start, end });
}

function maskQuotedText(instruction) {
  return instruction.replace(/"[^"\r\n]+"|“[^”\r\n]+”|「[^」\r\n]+」|『[^』\r\n]+』|`[^`\r\n]+`/gu, (value) => value.replace(/[^\r\n]/gu, ' '));
}

function splitIntoClauses(instruction) {
  const masked = maskQuotedText(instruction);
  const clauses = [];
  let cursor = 0;
  for (const separator of masked.matchAll(CLAUSE_SEPARATOR)) {
    const separatorStart = separator.index ?? cursor;
    clauses.push({ start: cursor, end: separatorStart });
    cursor = separatorStart + separator[0].length;
  }
  clauses.push({ start: cursor, end: instruction.length });
  return clauses;
}

function remainderKind(value) {
  if (NON_ACTION_PADDING.test(value)) {
    return 'padding';
  }
  if (CHINESE_DELIVERY_CLAUSE.test(value) || ENGLISH_DELIVERY_CLAUSE.test(value)) {
    return 'delivery';
  }
  return null;
}

function completeInstructionConsumption(instruction, matches) {
  const usedMatches = new Set();
  let deliveryIntentCount = 0;
  for (const clause of splitIntoClauses(instruction)) {
    const clauseMatches = matches.filter(
      (match) => match.start >= clause.start && match.end <= clause.end,
    );
    if (clauseMatches.length > 1) {
      return false;
    }
    let cursor = clause.start;
    const remainder = [];
    for (const match of clauseMatches) {
      if (match.start < cursor) {
        return false;
      }
      remainder.push(instruction.slice(cursor, match.start));
      cursor = match.end;
      usedMatches.add(match);
    }
    remainder.push(instruction.slice(cursor, clause.end));
    const kind = remainderKind(remainder.join(' '));
    if (kind == null) {
      return false;
    }
    if (kind === 'delivery' && ++deliveryIntentCount > 1) {
      return false;
    }
  }
  return usedMatches.size === matches.length;
}

function parseCellValues(instruction, assertions, seen) {
  const patterns = [
    new RegExp(String.raw`(?:将|把|请将|请把)\s*(?:单元格\s*)?${LOCATION_CAPTURE}\s*(?:设置为|改为|改成|替换为)\s*${VALUE_CAPTURE}`, 'giu'),
    new RegExp(String.raw`(?:set|change|replace)\s+(?:cell\s+)?${LOCATION_CAPTURE}\s+(?:to|with)\s+${VALUE_CAPTURE}`, 'giu'),
  ];
  for (const pattern of patterns) {
    for (const match of instruction.matchAll(pattern)) {
      const location = locationValue(match);
      const value = scalarValue(match, 7);
      if (!location || value === null && match[12] !== 'null') {
        continue;
      }
      addAssertion(
        assertions,
        seen,
        {
          schemaVersion: '1.0',
          type: XLSX_ACCEPTANCE_TYPES.CELL_VALUE,
          ...location,
          value,
        },
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      );
    }
  }
}

function parseFormulas(instruction, assertions, seen) {
  const formulaCapture = String.raw`(?:${QUOTED_CAPTURE}|(=[^，,；;。\r\n]+))`;
  const patterns = [
    new RegExp(String.raw`(?:将|把|请将|请把)\s*(?:单元格\s*)?${LOCATION_CAPTURE}\s*(?:设置公式为|设置公式|公式设为)\s*${formulaCapture}`, 'giu'),
    new RegExp(String.raw`(?:set|change)\s+(?:the\s+)?formula\s+(?:in\s+)?${LOCATION_CAPTURE}\s+(?:to|as)\s*${formulaCapture}`, 'giu'),
  ];
  for (const pattern of patterns) {
    for (const match of instruction.matchAll(pattern)) {
      const location = locationValue(match);
      const formula = quotedValue(match, 7) ?? match[12]?.trim();
      if (!location || typeof formula !== 'string' || !formula.startsWith('=')) {
        continue;
      }
      addAssertion(
        assertions,
        seen,
        {
          schemaVersion: '1.0',
          type: XLSX_ACCEPTANCE_TYPES.FORMULA,
          ...location,
          formula,
        },
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      );
    }
  }
}

function parseNumberFormats(instruction, assertions, seen) {
  const patterns = [
    new RegExp(String.raw`(?:将|把|请将|请把)\s*(?:单元格\s*)?${LOCATION_CAPTURE}\s*(?:的\s*)?(?:数字格式|数值格式)\s*(?:设置为|改为|设为)\s*${QUOTED_CAPTURE}`, 'giu'),
    new RegExp(String.raw`(?:set|change)\s+(?:the\s+)?number\s+format\s+(?:of\s+)?${LOCATION_CAPTURE}\s+(?:to|as)\s*${QUOTED_CAPTURE}`, 'giu'),
  ];
  for (const pattern of patterns) {
    for (const match of instruction.matchAll(pattern)) {
      const location = locationValue(match);
      const numberFormat = quotedValue(match, 7);
      if (!location || !numberFormat) {
        continue;
      }
      addAssertion(
        assertions,
        seen,
        {
          schemaVersion: '1.0',
          type: XLSX_ACCEPTANCE_TYPES.NUMBER_FORMAT,
          ...location,
          numberFormat,
        },
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      );
    }
  }
}

function parseAddedSheets(instruction, assertions, seen) {
  const patterns = [
    new RegExp(String.raw`(?:新增|添加|创建)\s*(?:一个)?\s*(?:工作表|表|sheet)\s*(?:名为|名称为|叫做|为|[:：])?\s*${QUOTED_CAPTURE}`, 'giu'),
    new RegExp(String.raw`(?:add|create)\s+(?:a\s+)?sheet\s+(?:named\s+)?${QUOTED_CAPTURE}`, 'giu'),
  ];
  for (const pattern of patterns) {
    for (const match of instruction.matchAll(pattern)) {
      const sheet = quotedValue(match, 1)?.trim();
      if (!sheet || !SHEET_NAME_PATTERN.test(sheet)) {
        continue;
      }
      addAssertion(
        assertions,
        seen,
        {
          schemaVersion: '1.0',
          type: XLSX_ACCEPTANCE_TYPES.SHEET_PRESENT,
          sheet,
        },
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      );
    }
  }
}

export function resolveXlsxAcceptanceAssertions({ instruction, files } = {}) {
  if (
    !Array.isArray(files)
    || files.length !== 1
    || files[0]?.type !== XLSX_MIME
    || typeof instruction !== 'string'
    || instruction.trim() === ''
    || instruction.length > MAX_INSTRUCTION_CHARS
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(instruction)
  ) {
    return null;
  }

  const assertions = [];
  const seen = new Set();
  const parserInstruction = instruction.replace(/[“”]/gu, '"');
  parseCellValues(parserInstruction, assertions, seen);
  parseFormulas(parserInstruction, assertions, seen);
  parseNumberFormats(parserInstruction, assertions, seen);
  parseAddedSheets(parserInstruction, assertions, seen);
  assertions.sort((left, right) => left.start - right.start);
  if (
    assertions.length === 0
    || assertions.length > MAX_BUSINESS_ASSERTIONS
    || !completeInstructionConsumption(instruction, assertions)
  ) {
    return null;
  }
  try {
    return normalizeXlsxAcceptanceAssertions(assertions.map(({ assertion }) => assertion));
  } catch {
    return null;
  }
}

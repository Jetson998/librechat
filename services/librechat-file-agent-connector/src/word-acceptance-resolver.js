import { DOCX_MIME } from './constants.js';
import {
  normalizeWordAcceptanceAssertions,
  WORD_ACCEPTANCE_TYPES,
} from '../../file-agent-runtime/src/word-acceptance.js';

export const WORD_ACCEPTANCE_RESOLVER_VERSION = '1.0.0';

const MAX_INSTRUCTION_CHARS = 8_000;
const MAX_BUSINESS_ASSERTIONS = 4;
const QUOTED_CAPTURE = String.raw`(?:"([^"\r\n]+)"|“([^”\r\n]+)”|「([^」\r\n]+)」|『([^』\r\n]+)』|\x60([^\x60\r\n]+)\x60)`;
const QUOTED_TEXT = /"[^"\r\n]+"|“[^”\r\n]+”|「[^」\r\n]+」|『[^』\r\n]+』|`[^`\r\n]+`/gu;
const CLAUSE_SEPARATOR = /[，,；;。、]|并且|同时|然后|而且|以及|并|\band\b|\bthen\b|\balso\b/giu;
const ALLOWED_REMAINDER_CHINESE_WORD = '请|帮我|麻烦|当前|这个|该|文档|文件|一个|一份|一|的|最终|修订版|经过|验证|已验证|交付|提交|输出|返回|提供|下载|保存|生成';
const ALLOWED_REMAINDER_ENGLISH_WORD = 'word|docx|document|file|paragraph|artifact|the|an|a|one|verified|revised|final|deliver|submit|output|return|provide|download|save|produce';
const ALLOWED_REMAINDER_WORD = new RegExp(
  String.raw`(?:${ALLOWED_REMAINDER_CHINESE_WORD}|(?<![A-Za-z0-9_])(?:${ALLOWED_REMAINDER_ENGLISH_WORD})(?![A-Za-z0-9_]))`,
  'giu',
);
const ALLOWED_REMAINDER_PUNCTUATION = /[\s:：!！?？、。；;，,（）()【】\[\]{}]/gu;

function quotedValue(match, start) {
  return match.slice(start, start + 5).find((value) => typeof value === 'string') ?? null;
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
  return instruction.replace(QUOTED_TEXT, (value) => value.replace(/[^\r\n]/gu, ' '));
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

function remainderIsNonAction(value) {
  const remaining = value
    .replace(QUOTED_TEXT, ' ')
    .replace(ALLOWED_REMAINDER_WORD, ' ')
    .replace(ALLOWED_REMAINDER_PUNCTUATION, '')
    .replace(/\s+/gu, '');
  return remaining === '';
}

function completeInstructionConsumption(instruction, matches) {
  const usedMatches = new Set();
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
    if (!remainderIsNonAction(remainder.join(' '))) {
      return false;
    }
  }
  return usedMatches.size === matches.length;
}

function parseTextReplacements(instruction, assertions, seen) {
  const chinese = new RegExp(
    String.raw`(?:将|把|请将|请把)?\s*(?:文字|文本)?\s*(?:第\s*(\d+)\s*(?:处|次)\s*)?${QUOTED_CAPTURE}\s*(?:替换为|改为|改成|换成)\s*${QUOTED_CAPTURE}`,
    'giu',
  );
  for (const match of instruction.matchAll(chinese)) {
    const occurrence = match[1] == null ? 1 : Number(match[1]);
    const find = quotedValue(match, 2);
    const replace = quotedValue(match, 7);
    if (!find || !replace || !Number.isSafeInteger(occurrence) || occurrence < 1) {
      continue;
    }
    addAssertion(
      assertions,
      seen,
      {
        schemaVersion: '1.0',
        type: WORD_ACCEPTANCE_TYPES.TEXT_REPLACE,
        find,
        replace,
        occurrence,
      },
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
    );
  }

  const english = new RegExp(
    String.raw`replace\s+${QUOTED_CAPTURE}\s+(?:with|by)\s+${QUOTED_CAPTURE}`,
    'giu',
  );
  for (const match of instruction.matchAll(english)) {
    const find = quotedValue(match, 1);
    const replace = quotedValue(match, 6);
    if (!find || !replace) {
      continue;
    }
    addAssertion(
      assertions,
      seen,
      {
        schemaVersion: '1.0',
        type: WORD_ACCEPTANCE_TYPES.TEXT_REPLACE,
        find,
        replace,
        occurrence: 1,
      },
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
    );
  }
}

function parseParagraphAppends(instruction, assertions, seen) {
  const chinese = new RegExp(
    String.raw`(?:在文档(?:末尾|最后)|于文档(?:末尾|最后))?\s*(?:追加|新增|添加|附加)(?:一段|段落|文字|文本)?\s*(?:[:：]\s*)?${QUOTED_CAPTURE}`,
    'giu',
  );
  for (const match of instruction.matchAll(chinese)) {
    const text = quotedValue(match, 1);
    if (!text) {
      continue;
    }
    addAssertion(
      assertions,
      seen,
      {
        schemaVersion: '1.0',
        type: WORD_ACCEPTANCE_TYPES.PARAGRAPH_APPEND,
        text,
      },
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
    );
  }

  const english = new RegExp(
    String.raw`(?:append|add)\s+(?:a\s+)?paragraph\s*(?:[:：]\s*|\s+)${QUOTED_CAPTURE}`,
    'giu',
  );
  for (const match of instruction.matchAll(english)) {
    const text = quotedValue(match, 1);
    if (!text) {
      continue;
    }
    addAssertion(
      assertions,
      seen,
      {
        schemaVersion: '1.0',
        type: WORD_ACCEPTANCE_TYPES.PARAGRAPH_APPEND,
        text,
      },
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
    );
  }
}

function parseTableCellReplacements(instruction, assertions, seen) {
  const chinese = new RegExp(
    String.raw`(?:将|把)?\s*第\s*(\d+)\s*个表格\s*(?:的\s*)?第\s*(\d+)\s*行\s*第\s*(\d+)\s*列\s*(?:替换为|改为|设置为)\s*${QUOTED_CAPTURE}`,
    'giu',
  );
  for (const match of instruction.matchAll(chinese)) {
    const tableIndex = Number(match[1]) - 1;
    const rowIndex = Number(match[2]) - 1;
    const columnIndex = Number(match[3]) - 1;
    const text = quotedValue(match, 4);
    if (
      !text
      || ![tableIndex, rowIndex, columnIndex].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    ) {
      continue;
    }
    addAssertion(
      assertions,
      seen,
      {
        schemaVersion: '1.0',
        type: WORD_ACCEPTANCE_TYPES.TABLE_CELL_REPLACE,
        tableIndex,
        rowIndex,
        columnIndex,
        text,
      },
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
    );
  }

  const english = new RegExp(
    String.raw`table\s+(\d+)\s+row\s+(\d+)\s+column\s+(\d+)\s+(?:replace|set)\s+(?:with|to)\s+${QUOTED_CAPTURE}`,
    'giu',
  );
  for (const match of instruction.matchAll(english)) {
    const tableIndex = Number(match[1]) - 1;
    const rowIndex = Number(match[2]) - 1;
    const columnIndex = Number(match[3]) - 1;
    const text = quotedValue(match, 4);
    if (
      !text
      || ![tableIndex, rowIndex, columnIndex].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    ) {
      continue;
    }
    addAssertion(
      assertions,
      seen,
      {
        schemaVersion: '1.0',
        type: WORD_ACCEPTANCE_TYPES.TABLE_CELL_REPLACE,
        tableIndex,
        rowIndex,
        columnIndex,
        text,
      },
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
    );
  }
}

export function resolveWordAcceptanceAssertions({ instruction, files } = {}) {
  if (
    !Array.isArray(files)
    || files.length !== 1
    || files[0]?.type !== DOCX_MIME
    || typeof instruction !== 'string'
    || instruction.trim() === ''
    || instruction.length > MAX_INSTRUCTION_CHARS
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(instruction)
  ) {
    return null;
  }

  const assertions = [];
  const seen = new Set();
  parseTextReplacements(instruction, assertions, seen);
  parseTableCellReplacements(instruction, assertions, seen);
  parseParagraphAppends(instruction, assertions, seen);
  assertions.sort((left, right) => left.start - right.start);

  if (
    assertions.length === 0
    || assertions.length > MAX_BUSINESS_ASSERTIONS
    || !completeInstructionConsumption(instruction, assertions)
  ) {
    return null;
  }

  try {
    return normalizeWordAcceptanceAssertions(assertions.map(({ assertion }) => assertion));
  } catch {
    return null;
  }
}

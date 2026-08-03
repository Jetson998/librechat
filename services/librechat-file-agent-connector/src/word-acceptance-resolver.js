import { DOCX_MIME } from './constants.js';
import {
  normalizeWordAcceptanceAssertions,
  WORD_ACCEPTANCE_TYPES,
} from '../../file-agent-runtime/src/word-acceptance.js';

export const WORD_ACCEPTANCE_RESOLVER_VERSION = '1.0.0';

const MAX_INSTRUCTION_CHARS = 8_000;
const MAX_BUSINESS_ASSERTIONS = 4;
const QUOTED_CAPTURE = String.raw`(?:"([^"\r\n]+)"|“([^”\r\n]+)”|「([^」\r\n]+)」|『([^』\r\n]+)』|\x60([^\x60\r\n]+)\x60)`;
const UNSUPPORTED_ACTION_CUE = /(?:删除|删掉|移动|重排|格式化|加粗|斜体|下划线|批注|修订痕迹|修订模式|delete|remove|move|reorder|format|bold|italic|underline|comment|track changes)/iu;

function quotedValue(match, start) {
  return match.slice(start, start + 5).find((value) => typeof value === 'string') ?? null;
}

function instructionWithoutQuotedText(instruction) {
  return instruction
    .replace(/"[^"\r\n]+"|“[^”\r\n]+”|「[^」\r\n]+」|『[^』\r\n]+』|`[^`\r\n]+`/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function addAssertion(assertions, seen, assertion, index) {
  const key = JSON.stringify(assertion);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  assertions.push({ assertion, index });
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
  assertions.sort((left, right) => left.index - right.index);

  if (
    assertions.length === 0
    || assertions.length > MAX_BUSINESS_ASSERTIONS
    || UNSUPPORTED_ACTION_CUE.test(instructionWithoutQuotedText(instruction))
  ) {
    return null;
  }

  try {
    return normalizeWordAcceptanceAssertions(assertions.map(({ assertion }) => assertion));
  } catch {
    return null;
  }
}

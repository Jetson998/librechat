import { PPTX_MIME } from './constants.js';
import {
  normalizePptxAcceptanceAssertions,
  PPTX_ACCEPTANCE_TYPES,
} from '../../file-agent-runtime/src/pptx-acceptance.js';

export const PPTX_ACCEPTANCE_RESOLVER_VERSION = '1.0.0';

const MAX_INSTRUCTION_CHARS = 8_000;
const MAX_BUSINESS_ASSERTIONS = 6;
const QUOTED_CAPTURE = String.raw`(?:"([^"\r\n]+)"|“([^”\r\n]+)”|「([^」\r\n]+)」|『([^』\r\n]+)』|\x60([^\x60\r\n]+)\x60)`;
const VALUE_CAPTURE = QUOTED_CAPTURE;
const SLIDE_SHAPE_CAPTURE = String.raw`(?:(?:第\s*([1-9][0-9]*)\s*(?:页|张)\s*(?:的\s*)?(?:"([^"\r\n]+)"|“([^”\r\n]+)”|「([^」\r\n]+)」|『([^』\r\n]+)』|\x60([^\x60\r\n]+)\x60))|(?:slide\s+([1-9][0-9]*)\s+(?:shape\s+)?(?:"([^"\r\n]+)"|“([^”\r\n]+)”|「([^」\r\n]+)」|『([^』\r\n]+)』|\x60([^\x60\r\n]+)\x60)))`;
const CLAUSE_SEPARATOR = /[，,；;。、]|并且|同时|然后|而且|以及|并|\band\b|\bthen\b|\balso\b/giu;
const DELIVERY_PADDING = String.raw`[\s:：!！?？、。；;，,（）()【】\[\]{}]`;
const NON_ACTION_PADDING = new RegExp(String.raw`^(?:${DELIVERY_PADDING})*$`, 'u');
const CHINESE_DELIVERY_CLAUSE = new RegExp(
  String.raw`^${DELIVERY_PADDING}*(?:请|帮我|麻烦)?\s*(?:交付|提交|输出|返回|提供|下载|保存|生成)\s*(?:一个|一份|一)?\s*(?:经过验证的|已验证的|验证的|最终|修订版)?\s*(?:PPTX\s*(?:文件)?|PowerPoint\s*(?:演示文稿|文件)?|演示文稿|幻灯片|文件)${DELIVERY_PADDING}*$`,
  'iu',
);
const ENGLISH_DELIVERY_CLAUSE = new RegExp(
  String.raw`^${DELIVERY_PADDING}*(?:please|kindly)?\s*(?:deliver|submit|output|return|provide|download|save|produce)\s+(?:(?:a|an|one|the)\s+)?(?:(?:verified|validated|revised|final)\s+)?(?:pptx(?:\s+file)?|powerpoint\s+presentation|presentation|slides?|deck|file|artifact)${DELIVERY_PADDING}*$`,
  'iu',
);

function quotedValue(match, start) {
  return match.slice(start, start + 5).find((value) => typeof value === 'string') ?? null;
}

function slideShapeValue(match) {
  const slide = match[1] ?? match[7];
  const shape = quotedValue(match, 2) ?? quotedValue(match, 8);
  if (!slide || !shape) {
    return null;
  }
  const slideNumber = Number(slide);
  if (!Number.isSafeInteger(slideNumber) || slideNumber < 1 || slideNumber > 200) {
    return null;
  }
  return { slide: slideNumber, shape };
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
  return instruction
    .replace(/"[^"\r\n]+"|“[^”\r\n]+”|「[^」\r\n]+」|『[^』\r\n]+』|`[^`\r\n]+`/gu, (value) => value.replace(/[^\r\n]/gu, ' '))
    .replace(/([0-9](?:\s*[,，、]\s*)(?=[0-9]))/gu, (value) => value.replace(/[^\r\n]/gu, ' '));
}

function splitIntoClauses(instruction) {
  const masked = maskQuotedText(instruction);
  const clauses = [];
  let cursor = 0;
  for (const separator of masked.matchAll(CLAUSE_SEPARATOR)) {
    const separatorStart = separator.index ?? cursor;
    const separatorEnd = separatorStart + separator[0].length;
    if (
      /^[，,]$/u.test(separator[0])
      && /^\s*(?:标题|题目)/iu.test(masked.slice(separatorEnd))
    ) {
      continue;
    }
    clauses.push({ start: cursor, end: separatorStart });
    cursor = separatorEnd;
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

function parseTextValues(instruction, assertions, seen) {
  const patterns = [
    new RegExp(String.raw`(?:将|把|请将|请把)\s*${SLIDE_SHAPE_CAPTURE}\s*(?:替换为|改为|改成|设置为)\s*${VALUE_CAPTURE}`, 'giu'),
    new RegExp(String.raw`(?:replace|change|set)\s+${SLIDE_SHAPE_CAPTURE}\s+(?:with|to)\s*${VALUE_CAPTURE}`, 'giu'),
  ];
  for (const pattern of patterns) {
    for (const match of instruction.matchAll(pattern)) {
      const location = slideShapeValue(match);
      const value = quotedValue(match, 13);
      if (!location || value == null) {
        continue;
      }
      addAssertion(
        assertions,
        seen,
        {
          schemaVersion: '1.0',
          type: PPTX_ACCEPTANCE_TYPES.TEXT_VALUE,
          ...location,
          value,
        },
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      );
    }
  }
}

function parseTableValues(instruction, assertions, seen) {
  const tableName = String.raw`(?:"([^"\r\n]+)"|“([^”\r\n]+)”|「([^」\r\n]+)」|『([^』\r\n]+)』|\x60([^\x60\r\n]+)\x60)`;
  const patterns = [
    new RegExp(String.raw`(?:将|把|请将|请把)\s*第\s*([1-9][0-9]*)\s*(?:页|张)\s*(?:的\s*)?(?:表格\s*)?${tableName}\s*第\s*([1-9][0-9]*)\s*行\s*第\s*([1-9][0-9]*)\s*列\s*(?:替换为|改为|改成|设置为)\s*${VALUE_CAPTURE}`, 'giu'),
    new RegExp(String.raw`(?:set|change)\s+slide\s+([1-9][0-9]*)\s+table\s+${tableName}\s+row\s+([1-9][0-9]*)\s+column\s+([1-9][0-9]*)\s+(?:to|as)\s*${VALUE_CAPTURE}`, 'giu'),
  ];
  for (const pattern of patterns) {
    for (const match of instruction.matchAll(pattern)) {
      const slide = Number(match[1]);
      const shape = quotedValue(match, 2);
      const row = Number(match[7]);
      const column = Number(match[8]);
      const value = quotedValue(match, 9);
      if (!Number.isSafeInteger(slide) || slide < 1 || slide > 200 || !shape || !Number.isSafeInteger(row) || row < 1 || row > 200 || !Number.isSafeInteger(column) || column < 1 || column > 200 || value == null) {
        continue;
      }
      addAssertion(
        assertions,
        seen,
        {
          schemaVersion: '1.0',
          type: PPTX_ACCEPTANCE_TYPES.TABLE_CELL_VALUE,
          slide,
          shape,
          row,
          column,
          value,
        },
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      );
    }
  }
}

function parseSlideOrder(instruction, assertions, seen) {
  const patterns = [
    /(?:将|把)?\s*(?:幻灯片|页面)\s*(?:顺序)?\s*(?:调整为|设置为|改为)\s*([1-9][0-9]*(?:\s*[,，、]\s*[1-9][0-9]*)+)/giu,
    /(?:reorder\s+slides?|set\s+slide\s+order)\s+(?:to\s+)?([1-9][0-9]*(?:\s*,\s*[1-9][0-9]*)+)/giu,
  ];
  for (const pattern of patterns) {
    for (const match of instruction.matchAll(pattern)) {
      const order = match[1].split(/\s*[,，、]\s*/u).map(Number);
      if (order.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 200) || new Set(order).size !== order.length) {
        continue;
      }
      addAssertion(
        assertions,
        seen,
        { schemaVersion: '1.0', type: PPTX_ACCEPTANCE_TYPES.SLIDE_ORDER, order },
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      );
    }
  }
}

function parseSlideCopy(instruction, assertions, seen) {
  const patterns = [
    /(?:复制|拷贝|复制出)\s*第\s*([1-9][0-9]*)\s*(?:页|张)\s*(?:到|至)\s*第\s*([1-9][0-9]*)\s*(?:页|张)/giu,
    /(?:copy|duplicate)\s+slide\s+([1-9][0-9]*)\s+(?:to|into)\s+slide\s+([1-9][0-9]*)/giu,
  ];
  for (const pattern of patterns) {
    for (const match of instruction.matchAll(pattern)) {
      const sourceSlide = Number(match[1]);
      const destination = Number(match[2]);
      if (![sourceSlide, destination].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 200)) {
        continue;
      }
      addAssertion(
        assertions,
        seen,
        { schemaVersion: '1.0', type: PPTX_ACCEPTANCE_TYPES.SLIDE_COPY, sourceSlide, destination },
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      );
    }
  }
}

function parseSlideAddition(instruction, assertions, seen) {
  const patterns = [
    new RegExp(String.raw`(?:新增|添加|增加|插入)\s*(?:一页|一張|一张|一个页面|一张幻灯片|一页幻灯片)(?:[\s，,：:]*(?:标题|题目)\s*(?:为|是|叫做|名为)\s*${VALUE_CAPTURE})?`, 'giu'),
    new RegExp(String.raw`(?:add|insert)\s+(?:a|an|one)?\s*(?:new\s+)?slide(?:\s+(?:titled|named)\s*${VALUE_CAPTURE})?`, 'giu'),
  ];
  for (const pattern of patterns) {
    for (const match of instruction.matchAll(pattern)) {
      const title = quotedValue(match, 1) ?? quotedValue(match, 6) ?? null;
      addAssertion(
        assertions,
        seen,
        { schemaVersion: '1.0', type: PPTX_ACCEPTANCE_TYPES.SLIDE_ADD, position: 'append', title },
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      );
    }
  }
}

function parseSlideDeletion(instruction, assertions, seen) {
  const patterns = [
    /(?:删除|移除)\s*第\s*([1-9][0-9]*)\s*(?:页|张)(?:幻灯片|页面)?/giu,
    /(?:delete|remove)\s+slide\s+([1-9][0-9]*)/giu,
  ];
  for (const pattern of patterns) {
    for (const match of instruction.matchAll(pattern)) {
      const slide = Number(match[1]);
      if (!Number.isSafeInteger(slide) || slide < 1 || slide > 200) {
        continue;
      }
      addAssertion(
        assertions,
        seen,
        { schemaVersion: '1.0', type: PPTX_ACCEPTANCE_TYPES.SLIDE_ABSENT, slide },
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      );
    }
  }
}

export function resolvePptxAcceptanceAssertions({ instruction, files } = {}) {
  if (
    !Array.isArray(files)
    || files.length !== 1
    || files[0]?.type !== PPTX_MIME
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
  parseTextValues(parserInstruction, assertions, seen);
  parseTableValues(parserInstruction, assertions, seen);
  parseSlideOrder(parserInstruction, assertions, seen);
  parseSlideCopy(parserInstruction, assertions, seen);
  parseSlideAddition(parserInstruction, assertions, seen);
  parseSlideDeletion(parserInstruction, assertions, seen);
  assertions.sort((left, right) => left.start - right.start);
  if (
    assertions.length === 0
    || assertions.length > MAX_BUSINESS_ASSERTIONS
    || !completeInstructionConsumption(instruction, assertions)
  ) {
    return null;
  }
  try {
    return normalizePptxAcceptanceAssertions(assertions.map(({ assertion }) => assertion));
  } catch {
    return null;
  }
}

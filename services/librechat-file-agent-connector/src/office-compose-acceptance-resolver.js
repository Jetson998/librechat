import {
  DOCX_MIME,
  OFFICE_COMPOSE_CAPABILITY_PROFILE,
  PPTX_MIME,
  XLSX_MIME,
} from './constants.js';
import {
  OFFICE_COMPOSE_ACCEPTANCE_TYPES,
  normalizeOfficeComposeAcceptanceAssertions,
} from '../../file-agent-runtime/src/office-compose-acceptance.js';
import { sha256 } from './stable.js';

export const OFFICE_COMPOSE_ACCEPTANCE_RESOLVER_VERSION = '1.0.0';

const XLSX_LOCATION = /(?:^|[\s"“‘])([A-Za-z0-9_][A-Za-z0-9 _.-]{0,30})!([A-Z]{1,3}[1-9][0-9]{0,6})(?=$|[\s"”’。，,])/gu;
const XLSX_LOCATION_ASCII = /\b([A-Za-z0-9_][A-Za-z0-9 _.-]{0,30})!([A-Z]{1,3}[1-9][0-9]{0,6})\b/gu;
const DOCX_LOCATION = /(?:body\.paragraph\[([0-9]{1,2})\]|(?:第\s*)?([1-9][0-9]?)\s*(?:段|paragraph))/giu;
const COMPOSE_INTENT = /(?:生成|制作|汇总|整理|导出|转换|演示文稿|汇报|PowerPoint|PPTX|compose|presentation|slide|deck)/iu;
const MULTIPLE_OUTPUT_INTENT = /(?:两个|多份|多个|two|multiple|several)\s*(?:个|份)?\s*(?:文件|文档|PPTX|演示文稿|files?|documents?|decks?)/iu;
const NATURAL_COMPOSE_TITLE = /(?:生成|制作|汇总|整理|导出|create|generate|summari[sz]e|export)\s*(?:一页|一張|一张|one[-\s]?page)?\s*(?:一个|一份|a|an|one)?\s*(.{3,120}?)(?=\s*(?:PPTX?|PowerPoint|演示文稿|幻灯片|presentation|slides?|deck)\b)/iu;
const GENERIC_COMPOSE_TITLE = /^(?:汇报|报告|演示|presentation|slides?|deck|pptx?)$/iu;

function filenameStem(value) {
  return String(value ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    ?.replace(/\.[^.]+$/u, '') ?? '';
}

export function sourceLogicalIdForFile(file) {
  const fileId = String(file?.file_id ?? file?.fileId ?? '').trim();
  if (fileId === '') {
    throw new TypeError('Compose source file ID is required');
  }
  const rawStem = filenameStem(file?.filename ?? file?.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40) || 'source';
  const stem = /^[a-z]/u.test(rawStem) ? rawStem : `source-${rawStem}`;
  return `source:${stem}-${sha256(fileId).slice(0, 8)}`;
}

function sourceKind(file) {
  if (file?.type === XLSX_MIME) {
    return 'xlsx';
  }
  if (file?.type === DOCX_MIME) {
    return 'docx';
  }
  return null;
}

function xlsxLocations(instruction) {
  const matches = [...instruction.matchAll(XLSX_LOCATION), ...instruction.matchAll(XLSX_LOCATION_ASCII)];
  const seen = new Set();
  return matches
    .map((match) => `${match[1].trim()}!${match[2].toUpperCase()}`)
    .filter((location) => {
      if (seen.has(location)) {
        return false;
      }
      seen.add(location);
      return true;
    });
}

function docxLocations(instruction) {
  const seen = new Set();
  return [...instruction.matchAll(DOCX_LOCATION)]
    .map((match) => `body.paragraph[${match[1] != null ? Number(match[1]) : Number(match[2]) - 1}]`)
    .filter((location) => {
      if (seen.has(location)) {
        return false;
      }
      seen.add(location);
      return true;
    });
}

function naturalComposeTitle(instruction) {
  const match = instruction.match(NATURAL_COMPOSE_TITLE);
  if (!match) {
    return null;
  }
  const title = match[1]
    .replace(/^[\s:：，,、和与及]+|[\s:：，,、和与及]+$/gu, '')
    .trim();
  if (title.length < 3 || GENERIC_COMPOSE_TITLE.test(title)) {
    return null;
  }
  return title.slice(0, 400);
}

/**
 * Resolves only explicit source locations. Values are intentionally absent:
 * the Runtime Inspector reads the authorized bytes and the Verifier checks
 * the resulting value and mapping against the frozen source fact.
 */
export function resolveOfficeComposeAcceptanceAssertions({ files, instruction }) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 2) {
    return null;
  }
  if (typeof instruction !== 'string' || !COMPOSE_INTENT.test(instruction)) {
    return null;
  }
  if (MULTIPLE_OUTPUT_INTENT.test(instruction)) {
    return null;
  }
  const sources = files.map((file) => ({ file, logicalId: sourceLogicalIdForFile(file), kind: sourceKind(file) }));
  if (sources.some((source) => source.kind == null)) {
    return null;
  }
  if (sources.filter((source) => source.kind === 'xlsx').length > 1 || sources.filter((source) => source.kind === 'docx').length > 1) {
    return null;
  }

  const locations = [];
  for (const source of sources) {
    const sourceLocations = source.kind === 'xlsx' ? xlsxLocations(instruction) : docxLocations(instruction);
    if (sourceLocations.length === 0) {
      const title = naturalComposeTitle(instruction);
      if (!title) {
        return null;
      }
      return normalizeOfficeComposeAcceptanceAssertions([{
        type: OFFICE_COMPOSE_ACCEPTANCE_TYPES.SECTION_PRESENT,
        slide: 1,
        title,
      }]);
    }
    for (const sourceLocation of sourceLocations) {
      locations.push({
        sourceLogicalId: source.logicalId,
        sourceLocation,
      });
    }
  }
  if (locations.length === 0 || locations.length > 12) {
    return null;
  }

  const assertions = locations.flatMap(({ sourceLogicalId, sourceLocation }, index) => [
    {
      type: OFFICE_COMPOSE_ACCEPTANCE_TYPES.SECTION_PRESENT,
      slide: index + 1,
      title: index === 0 ? 'Source Facts' : `Source Facts ${index + 1}`,
    },
    {
      type: OFFICE_COMPOSE_ACCEPTANCE_TYPES.SOURCE_MAPPING,
      sourceLogicalId,
      sourceLocation,
      targetSlide: index + 1,
      targetShape: 'body',
    },
  ]);
  return normalizeOfficeComposeAcceptanceAssertions(assertions);
}

export function isOfficeComposeCapabilityProfile(value) {
  return value === OFFICE_COMPOSE_CAPABILITY_PROFILE;
}

export { PPTX_MIME };

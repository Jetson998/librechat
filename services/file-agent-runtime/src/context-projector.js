import { createHash } from 'node:crypto';

import {
  PPTX_CAPABILITY_PROFILE,
  WORD_CAPABILITY_PROFILE,
  XLSX_CAPABILITY_PROFILE,
} from './constants.js';
import { OFFICE_COMPOSE_CAPABILITY_PROFILE } from './deterministic-office-compose-v1.js';
import { normalizeOfficeComposeAcceptanceAssertions } from './office-compose-acceptance.js';
import { normalizePptxAcceptanceAssertions } from './pptx-acceptance.js';
import { normalizeWordAcceptanceAssertions } from './word-acceptance.js';
import { normalizeXlsxAcceptanceAssertions } from './xlsx-acceptance.js';

const DEFAULT_TOTAL_CHARS = 12_000;
const OBJECTIVE_CHARS = 2_000;
const ACCEPTANCE_CHARS = 2_000;
const ITEM_SUMMARY_CHARS = 500;
const MAX_RECENT_ITEMS = 8;
const RESOURCE_CHARS = 3_000;
const DOCUMENT_CHARS = 6_000;

function truncate(value, maxChars) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function projectAcceptance(values) {
  const projected = [];
  let remaining = ACCEPTANCE_CHARS;
  for (const value of values ?? []) {
    if (remaining <= 0 || projected.length >= 20) {
      break;
    }
    const item = typeof value === 'string'
      ? truncate(value, Math.min(500, remaining))
      : truncate(
          JSON.stringify({
            code: value?.code,
            class: value?.class,
            summary: value?.summary,
            expected: value?.expected,
          }),
          Math.min(500, remaining),
        );
    if (item) {
      projected.push(item);
      remaining -= item.length;
    }
  }
  return projected;
}

function projectResources(task) {
  const inputs = (task.manifest.inputs ?? []).map((input) => ({
    name: input.logicalName ?? input.filename ?? 'input',
    sha256: input.sha256 ?? null,
    mimeType: input.mimeType ?? null,
  }));
  const scripts = new Map();
  const outputs = new Map();
  for (const result of Object.values(task.itemResults ?? {})) {
    if (!result || typeof result !== 'object') {
      continue;
    }
    if (typeof result.scriptPath === 'string') {
      scripts.set(result.scriptPath, {
        name: result.scriptPath.split('/').at(-1),
        sha256: result.scriptHash ?? null,
      });
    }
    if (typeof result.outputPath === 'string') {
      outputs.set(result.outputPath, {
        name: result.outputPath.split('/').at(-1),
        sha256: result.outputHash ?? null,
      });
    }
  }
  const resources = {
    inputs: inputs.slice(0, 20),
    scripts: [...scripts.values()].slice(0, 20),
    outputs: [...outputs.values()].slice(0, 20),
  };
  const removalOrder = [resources.outputs, resources.scripts, resources.inputs];
  while (JSON.stringify(resources).length > RESOURCE_CHARS) {
    const target = removalOrder.find((items) => items.length > 0);
    if (!target) {
      break;
    }
    target.pop();
  }
  return resources;
}

function projectRecentItems(task) {
  const completedEvents = (task.events ?? []).filter((event) => event.type === 'item.completed');
  const selected = completedEvents.slice(-MAX_RECENT_ITEMS);
  return {
    items: selected.map((event) => ({
      kind: event.item?.kind ?? 'unknown',
      summary: truncate(event.item?.summary ?? '', ITEM_SUMMARY_CHARS),
      sequence: event.sequence,
    })),
    omitted: Math.max(0, completedEvents.length - selected.length),
  };
}

function projectWordDocument(task) {
  const inspection = Object.values(task.itemResults ?? {})
    .reverse()
    .find((result) => result?.operation === 'inspect');
  if (!inspection) {
    return null;
  }

  const document = {
    sha256: inspection.sha256 ?? null,
    paragraphCount: inspection.paragraphCount ?? 0,
    tableCount: inspection.tableCount ?? 0,
    styleCount: inspection.styleCount ?? 0,
    headerCount: inspection.headerCount ?? 0,
    footerCount: inspection.footerCount ?? 0,
    paragraphs: (inspection.paragraphs ?? []).slice(0, 40).map((entry) => ({
      index: entry.index,
      text: truncate(entry.text ?? '', 400),
      style: truncate(entry.style ?? '', 80) || null,
      location: entry.location ?? 'body',
    })),
    tables: (inspection.tables ?? []).slice(0, 12).map((table) => ({
      index: table.index,
      rows: (table.rows ?? []).slice(0, 20).map((row) => ({
        index: row.index,
        cells: (row.cells ?? []).slice(0, 20).map((cell) => truncate(cell ?? '', 400)),
      })),
    })),
    headers: (inspection.headers ?? []).slice(0, 12).map((entry) => ({
      name: entry.name,
      paragraphs: (entry.paragraphs ?? []).slice(0, 12).map((paragraph) => truncate(paragraph, 400)),
    })),
    footers: (inspection.footers ?? []).slice(0, 12).map((entry) => ({
      name: entry.name,
      paragraphs: (entry.paragraphs ?? []).slice(0, 12).map((paragraph) => truncate(paragraph, 400)),
    })),
    styles: (inspection.styles ?? []).slice(0, 80).map((entry) => ({
      id: entry.id,
      name: truncate(entry.name ?? '', 120) || null,
    })),
  };

  let serialized = JSON.stringify(document);
  while (serialized.length > DOCUMENT_CHARS) {
    if (document.paragraphs.length > 0) {
      document.paragraphs.pop();
    } else if (document.tables.length > 0) {
      document.tables.pop();
    } else if (document.headers.length > 0) {
      document.headers.pop();
    } else if (document.footers.length > 0) {
      document.footers.pop();
    } else if (document.styles.length > 0) {
      document.styles.pop();
    } else {
      break;
    }
    serialized = JSON.stringify(document);
  }
  return document;
}

function projectWordAcceptanceAssertions(task) {
  const assertions = task.manifest.acceptanceAssertions;
  if (!Array.isArray(assertions)) {
    return [];
  }
  return structuredClone(normalizeWordAcceptanceAssertions(assertions));
}

function projectXlsxAcceptanceAssertions(task) {
  const assertions = task.manifest.acceptanceAssertions;
  if (!Array.isArray(assertions)) {
    return [];
  }
  return structuredClone(normalizeXlsxAcceptanceAssertions(assertions));
}

function projectXlsxDocument(task) {
  const inspection = Object.values(task.itemResults ?? {})
    .reverse()
    .find((result) => result?.operation === 'inspect' && result?.sheets);
  if (!inspection) {
    return null;
  }
  const document = {
    sha256: inspection.sha256 ?? null,
    sheetCount: inspection.sheetCount ?? 0,
    sheets: (inspection.sheets ?? []).slice(0, 20).map((sheet) => ({
      title: truncate(sheet.title ?? '', 31),
      maxRow: sheet.maxRow ?? 0,
      maxColumn: sheet.maxColumn ?? 0,
      mergedRanges: (sheet.mergedRanges ?? []).slice(0, 40),
      tableNames: (sheet.tableNames ?? []).slice(0, 40),
      chartCount: sheet.chartCount ?? 0,
      cells: (sheet.cells ?? []).slice(0, 200).map((cell) => ({
        cell: cell.cell,
        value: typeof cell.value === 'string' ? truncate(cell.value, 400) : cell.value,
        dataType: cell.dataType ?? null,
        numberFormat: truncate(cell.numberFormat ?? '', 256),
      })),
    })),
    definedNames: (inspection.definedNames ?? []).slice(0, 80),
  };
  return document;
}

function projectPptxAcceptanceAssertions(task) {
  const assertions = task.manifest.acceptanceAssertions;
  if (!Array.isArray(assertions)) {
    return [];
  }
  return structuredClone(normalizePptxAcceptanceAssertions(assertions));
}

function projectPptxDocument(task) {
  const inspection = Object.values(task.itemResults ?? {})
    .reverse()
    .find((result) => result?.operation === 'inspect' && result?.slides);
  if (!inspection) {
    return null;
  }
  return {
    sha256: inspection.sha256 ?? null,
    slideCount: inspection.slideCount ?? 0,
    slideWidth: inspection.slideWidth ?? 0,
    slideHeight: inspection.slideHeight ?? 0,
    mediaCount: inspection.mediaCount ?? 0,
    slides: (inspection.slides ?? []).slice(0, 20).map((slide) => ({
      index: slide.index,
      shapeCount: slide.shapeCount ?? 0,
      shapes: (slide.shapes ?? []).slice(0, 100).map((shape) => ({
        name: truncate(shape.name ?? '', 128),
        shapeType: shape.shapeType ?? null,
        text: typeof shape.text === 'string' ? truncate(shape.text, 400) : null,
        table: shape.table
          ? {
              rows: shape.table.rows ?? 0,
              columns: shape.table.columns ?? 0,
              cells: (shape.table.cells ?? []).slice(0, 20),
            }
          : null,
      })),
    })),
  };
}

function projectOfficeComposeAcceptanceAssertions(task) {
  const assertions = task.manifest.acceptanceAssertions;
  if (!Array.isArray(assertions)) {
    return [];
  }
  return structuredClone(normalizeOfficeComposeAcceptanceAssertions(assertions));
}

function projectOfficeComposeDocument(task) {
  const inspection = Object.values(task.itemResults ?? {})
    .reverse()
    .find((result) => result?.operation === 'inspect' && result?.sources);
  if (!inspection) {
    return null;
  }
  return {
    sourceFactsHash: inspection.sourceFactsHash ?? null,
    sources: (inspection.sources ?? []).slice(0, 3).map((source) => ({
      logicalId: source.logicalId ?? null,
      kind: source.kind ?? null,
      sha256: source.sha256 ?? null,
      locations: (source.locations ?? []).slice(0, 80).map((entry) => ({
        location: entry.location ?? null,
        value: typeof entry.value === 'string' ? truncate(entry.value, 400) : entry.value,
      })),
    })),
  };
}

export class ContextProjector {
  constructor({ maxChars = DEFAULT_TOTAL_CHARS } = {}) {
    if (!Number.isInteger(maxChars) || maxChars < 2_000) {
      throw new TypeError('ContextProjector maxChars must be an integer of at least 2000');
    }
    this.maxChars = maxChars;
  }

  project(task) {
    const recent = projectRecentItems(task);
    const context = {
      schemaVersion: '1.0',
      objective: truncate(task.manifest.intent, OBJECTIVE_CHARS),
      acceptance: projectAcceptance(task.manifest.acceptance),
      wordAcceptanceAssertions: (!task.manifest.model?.capabilityProfile || task.manifest.model?.capabilityProfile === WORD_CAPABILITY_PROFILE)
        ? projectWordAcceptanceAssertions(task)
        : [],
      xlsxAcceptanceAssertions: task.manifest.model?.capabilityProfile === XLSX_CAPABILITY_PROFILE
        ? projectXlsxAcceptanceAssertions(task)
        : [],
      pptxAcceptanceAssertions: task.manifest.model?.capabilityProfile === PPTX_CAPABILITY_PROFILE
        ? projectPptxAcceptanceAssertions(task)
        : [],
      officeComposeAcceptanceAssertions: task.manifest.model?.capabilityProfile === OFFICE_COMPOSE_CAPABILITY_PROFILE
        ? projectOfficeComposeAcceptanceAssertions(task)
        : [],
      state: {
        phase: task.phase,
        planRevision: task.planRevision,
        instructionRevision: task.instructionRevision,
      },
      resources: projectResources(task),
      document: task.manifest.model?.capabilityProfile === XLSX_CAPABILITY_PROFILE
        ? projectXlsxDocument(task)
        : task.manifest.model?.capabilityProfile === PPTX_CAPABILITY_PROFILE
          ? projectPptxDocument(task)
          : task.manifest.model?.capabilityProfile === OFFICE_COMPOSE_CAPABILITY_PROFILE
            ? projectOfficeComposeDocument(task)
            : projectWordDocument(task),
      recentItems: recent.items,
      verification: task.verification
        ? {
            profile: task.verification.profile ?? null,
            profileVersion: task.verification.profileVersion ?? null,
            passed: task.verification.passed === true,
            passedAssertionCodes: task.verification.passedAssertionCodes ?? [],
            failedAssertionCodes: (task.verification.failedAssertions ?? [])
              .map((assertion) => assertion.code)
              .filter(Boolean),
            artifactLogicalId: task.verification.artifact?.logicalId ?? null,
            metrics: task.verification.metrics ?? {},
            errorClass: task.verification.errorClass ?? null,
            summary: truncate(task.verification.summary ?? '', 1_500),
            fingerprint: task.verification.fingerprint ?? null,
          }
        : null,
      progress: {
        stagnationCount: task.progress?.stagnationCount ?? 0,
        lastFingerprint: task.progress?.lastFailedVerificationFingerprint ?? null,
        vector: task.progress?.vector ?? null,
      },
      constraints: [
        'Reuse the persisted script and workspace.',
        'Choose only actions from the declared capability profile.',
        'Do not emit source code, shell commands, file contents, URLs, credentials, or prices.',
      ],
    };

    let serialized = JSON.stringify(context);
    let additionallyOmitted = 0;
    while (serialized.length > this.maxChars && context.recentItems.length > 0) {
      context.recentItems.shift();
      additionallyOmitted += 1;
      serialized = JSON.stringify(context);
    }
    while (serialized.length > this.maxChars && context.document) {
      const removable = [
        'paragraphs',
        'tables',
        'headers',
        'footers',
        'styles',
        'sheets',
        'definedNames',
        'sources',
      ].find((key) => Array.isArray(context.document[key]) && context.document[key].length > 0);
      if (removable) {
        context.document[removable].pop();
      } else {
        context.document = null;
      }
      serialized = JSON.stringify(context);
    }
    if (serialized.length > this.maxChars) {
      context.objective = truncate(context.objective, Math.max(200, this.maxChars - 2_000));
      serialized = JSON.stringify(context);
    }
    if (serialized.length > this.maxChars) {
      throw new Error('Context projection could not fit within the configured budget');
    }

    const omittedItemCount = recent.omitted + additionallyOmitted;
    return {
      context,
      serialized,
      digest: hashJson(context),
      characters: serialized.length,
      compaction: omittedItemCount > 0
        ? { omittedItemCount, projectionCharacters: serialized.length }
        : null,
    };
  }
}

import { createHash } from 'node:crypto';

const DEFAULT_TOTAL_CHARS = 12_000;
const OBJECTIVE_CHARS = 2_000;
const ACCEPTANCE_CHARS = 2_000;
const ITEM_SUMMARY_CHARS = 500;
const MAX_RECENT_ITEMS = 8;
const RESOURCE_CHARS = 3_000;
const DOCUMENT_CHARS = 6_000;
const WORD_ACCEPTANCE_CHARS = 3_000;

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
  const projected = assertions.slice(0, 16).map((assertion) => {
    if (assertion?.type === 'word.text_replace.v1') {
      return {
        schemaVersion: assertion.schemaVersion ?? '1.0',
        type: assertion.type,
        find: truncate(assertion.find ?? '', 500),
        replace: truncate(assertion.replace ?? '', 500),
        occurrence: assertion.occurrence ?? 1,
      };
    }
    if (assertion?.type === 'word.paragraph_append.v1') {
      return {
        schemaVersion: assertion.schemaVersion ?? '1.0',
        type: assertion.type,
        text: truncate(assertion.text ?? '', 500),
        ...(assertion.style ? { style: truncate(assertion.style, 80) } : {}),
      };
    }
    if (assertion?.type === 'word.table_cell_replace.v1') {
      return {
        schemaVersion: assertion.schemaVersion ?? '1.0',
        type: assertion.type,
        tableIndex: assertion.tableIndex,
        rowIndex: assertion.rowIndex,
        columnIndex: assertion.columnIndex,
        text: truncate(assertion.text ?? '', 500),
      };
    }
    return {
      schemaVersion: assertion?.schemaVersion ?? '1.0',
      type: assertion?.type ?? null,
      logicalId: assertion?.logicalId ?? null,
      mimeType: assertion?.mimeType ?? null,
      maxCount: assertion?.maxCount ?? null,
    };
  });
  let serialized = JSON.stringify(projected);
  while (serialized.length > WORD_ACCEPTANCE_CHARS && projected.length > 1) {
    projected.pop();
    serialized = JSON.stringify(projected);
  }
  return projected;
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
      wordAcceptanceAssertions: projectWordAcceptanceAssertions(task),
      state: {
        phase: task.phase,
        planRevision: task.planRevision,
        instructionRevision: task.instructionRevision,
      },
      resources: projectResources(task),
      document: projectWordDocument(task),
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
      if (context.document.paragraphs.length > 0) {
        context.document.paragraphs.pop();
      } else if (context.document.tables.length > 0) {
        context.document.tables.pop();
      } else if (context.document.headers.length > 0) {
        context.document.headers.pop();
      } else if (context.document.footers.length > 0) {
        context.document.footers.pop();
      } else if (context.document.styles.length > 0) {
        context.document.styles.pop();
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

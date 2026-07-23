import { createHash } from 'node:crypto';

const DEFAULT_TOTAL_CHARS = 12_000;
const OBJECTIVE_CHARS = 2_000;
const ACCEPTANCE_CHARS = 2_000;
const ITEM_SUMMARY_CHARS = 500;
const MAX_RECENT_ITEMS = 8;
const RESOURCE_CHARS = 3_000;

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
    const item = truncate(value, Math.min(500, remaining));
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
      state: {
        phase: task.phase,
        planRevision: task.planRevision,
        instructionRevision: task.instructionRevision,
      },
      resources: projectResources(task),
      recentItems: recent.items,
      verification: task.verification
        ? {
            passed: task.verification.passed === true,
            summary: truncate(task.verification.summary ?? '', 1_500),
            fingerprint: task.verification.fingerprint ?? null,
          }
        : null,
      progress: {
        stagnationCount: task.progress?.stagnationCount ?? 0,
        lastFingerprint: task.progress?.lastFailedVerificationFingerprint ?? null,
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

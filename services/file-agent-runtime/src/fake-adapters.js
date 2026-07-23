import { setTimeout as delay } from 'node:timers/promises';

import { ExecutorAdapter } from './executor-adapter.js';

function normalizeActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return [
      { kind: 'inspect', summary: 'Inspect the authorized input manifest' },
      { kind: 'transform', summary: 'Produce the requested deterministic output' },
    ];
  }

  return actions.map((action, index) => ({
    kind: action?.kind ?? `action_${index + 1}`,
    summary: action?.summary ?? `Execute action ${index + 1}`,
    input: action?.input ?? null,
  }));
}

async function wait(milliseconds, signal) {
  if (!milliseconds) {
    signal?.throwIfAborted();
    return;
  }
  await delay(milliseconds, undefined, { signal });
}

export class FakeProvider {
  constructor({ delayMs = 0 } = {}) {
    this.delayMs = delayMs;
  }

  async plan({ task, signal }) {
    await wait(this.delayMs, signal);

    if (task.manifest.testScenario === 'needs_input' && task.instructions.length === 0) {
      return {
        needsInput: true,
        question: 'Additional task instructions are required before execution.',
      };
    }

    return {
      needsInput: false,
      summary: `Plan revision ${task.planRevision + 1}`,
      actions: normalizeActions(task.manifest.fakePlan),
    };
  }

  async repair({ task, verification, signal }) {
    await wait(this.delayMs, signal);
    return {
      needsInput: false,
      summary: `Repair plan revision ${task.planRevision + 1}`,
      actions: [
        {
          kind: 'repair',
          summary: `Repair failed verification: ${verification.summary}`,
        },
      ],
    };
  }
}

export class FakeExecutor extends ExecutorAdapter {
  constructor({ delayMs = 0 } = {}) {
    super();
    this.delayMs = delayMs;
    this.invocations = [];
  }

  async prepare({ itemId, task, signal }) {
    await wait(this.delayMs, signal);
    this.#record(itemId, 'prepare');
    return {
      workspaceRoot: task.manifest.execution?.workspaceRoot ?? `/tmp/file-agent/${task.taskId}`,
    };
  }

  async execute({ itemId, action, task, signal }) {
    await wait(this.delayMs, signal);
    this.#record(itemId, action.kind);

    if (task.manifest.failActionKind === action.kind) {
      throw new Error(`Fake executor failure for action kind: ${action.kind}`);
    }

    return {
      actionKind: action.kind,
      summary: action.summary,
      outputRef: `workspace://items/${itemId}.json`,
    };
  }

  async verify({ itemId, task, signal }) {
    await wait(this.delayMs, signal);
    this.#record(itemId, 'verify');

    if (task.manifest.testScenario === 'repair_once' && task.planRevision === 1) {
      return {
        passed: false,
        summary: 'The first verification requires one repair pass.',
      };
    }

    return { passed: true, summary: 'Fake verification passed.' };
  }

  async publish({ itemId, task, signal }) {
    await wait(this.delayMs, signal);
    this.#record(itemId, 'publish');

    const artifacts = Array.isArray(task.manifest.fakeArtifacts)
      ? task.manifest.fakeArtifacts
      : [
          {
            name: 'phase0-result.json',
            mimeType: 'application/json',
            codeEnvRef: {
              storage_session_id: 'phase0-session',
              file_id: `phase0-${task.taskId}`,
            },
          },
        ];

    return { artifacts };
  }

  #record(itemId, operation) {
    this.invocations.push({ itemId, operation });
  }
}

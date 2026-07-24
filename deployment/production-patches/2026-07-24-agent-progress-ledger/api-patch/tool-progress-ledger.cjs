'use strict';

const { createHash } = require('node:crypto');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ACTIVE_RUNS = 1000;
const DEFAULT_MAX_OBSERVATIONS_PER_RUN = 64;
const DEFAULT_MAX_HASH_INPUT_CHARS = 32_000;

const WARNING_CODE = 'NO_PROGRESS_WARNING';
const STOP_CODE = 'NO_PROGRESS_STOP';
const ABORT_CODE = 'AGENT_NO_PROGRESS';

const WARNING_MESSAGE =
  '检测到本轮已经观察过相同状态，且没有新的文件或任务状态变化。不要重复等价检查；请改用不同策略、根据已有证据作答，或明确说明当前能力不可用。';
const STOP_MESSAGE =
  '检测到换策略后仍未产生新结果，系统已停止继续执行工具。请使用已有结果完成回复；已生成文件仍然保留。';
const ABORT_MESSAGE =
  '检测到重复执行但没有产生新结果，系统已停止继续尝试。已生成文件仍然保留。';

class AgentNoProgressError extends Error {
  constructor(message = ABORT_MESSAGE) {
    super(message);
    this.name = 'AgentNoProgressError';
    this.code = ABORT_CODE;
  }
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }

  const result = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (typeof item === 'function' || typeof item === 'symbol') continue;
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function parseStructuredOutput(value) {
  const candidates = [value];
  const stdoutMatch = value.match(/(?:^|\n)stdout:\s*\n([\s\S]*)$/i);
  if (stdoutMatch) candidates.push(stdoutMatch[1].trim());

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      const objectStart = trimmed.indexOf('{');
      const arrayStart = trimmed.indexOf('[');
      const starts = [objectStart, arrayStart].filter((index) => index >= 0);
      if (starts.length === 0) continue;
      const start = Math.min(...starts);
      const closing = trimmed[start] === '{' ? '}' : ']';
      const end = trimmed.lastIndexOf(closing);
      if (end <= start) continue;
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch (_) {
        // Fall back to bounded normalized text.
      }
    }
  }
  return null;
}

function normalizeContent(value, maxChars = DEFAULT_MAX_HASH_INPUT_CHARS) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return stableJson(value).slice(0, maxChars);

  const bounded = stripAnsi(value).replace(/\r\n/g, '\n').slice(0, maxChars).trim();
  const structured = parseStructuredOutput(bounded);
  if (structured !== null) return stableJson(structured).slice(0, maxChars);
  return bounded.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
}

function callFingerprint(toolCall, maxChars = DEFAULT_MAX_HASH_INPUT_CHARS) {
  return hashText(
    stableJson({
      name: toolCall?.name ?? '',
      args: toolCall?.args ?? {},
    }).slice(0, maxChars),
  );
}

function observationFingerprint(result, maxChars = DEFAULT_MAX_HASH_INPUT_CHARS) {
  return hashText(
    stableJson({
      status: result?.status ?? 'success',
      content: normalizeContent(result?.content, maxChars),
      error: normalizeContent(result?.errorMessage, maxChars),
    }).slice(0, maxChars),
  );
}

function artifactFingerprint(artifact, maxChars = DEFAULT_MAX_HASH_INPUT_CHARS) {
  if (artifact === null || artifact === undefined) return null;
  return hashText(stableJson(artifact).slice(0, maxChars));
}

function appendMarker(result, code, message, stop) {
  const marker = `[${code}] ${message}`;
  const next = { ...result };
  if (stop) {
    next.status = 'error';
    next.errorMessage = marker;
    return next;
  }
  if (typeof next.content === 'string' && next.content.length > 0) {
    next.content = `${next.content}\n\n${marker}`;
  } else {
    const prior = typeof next.errorMessage === 'string' ? next.errorMessage.trim() : '';
    next.errorMessage = prior ? `${prior}\n\n${marker}` : marker;
  }
  return next;
}

class ToolProgressLedger {
  constructor({
    now = () => Date.now(),
    onDiagnostic = () => {},
    ttlMs = DEFAULT_TTL_MS,
    maxActiveRuns = DEFAULT_MAX_ACTIVE_RUNS,
    maxObservationsPerRun = DEFAULT_MAX_OBSERVATIONS_PER_RUN,
    maxHashInputChars = DEFAULT_MAX_HASH_INPUT_CHARS,
  } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError('ttlMs must be positive');
    if (!Number.isSafeInteger(maxActiveRuns) || maxActiveRuns < 1) {
      throw new TypeError('maxActiveRuns must be positive');
    }
    if (!Number.isSafeInteger(maxObservationsPerRun) || maxObservationsPerRun < 1) {
      throw new TypeError('maxObservationsPerRun must be positive');
    }
    if (!Number.isSafeInteger(maxHashInputChars) || maxHashInputChars < 256) {
      throw new TypeError('maxHashInputChars must be at least 256');
    }
    this.now = now;
    this.onDiagnostic = onDiagnostic;
    this.ttlMs = ttlMs;
    this.maxActiveRuns = maxActiveRuns;
    this.maxObservationsPerRun = maxObservationsPerRun;
    this.maxHashInputChars = maxHashInputChars;
    this.runs = new Map();
  }

  #runKey(context) {
    return typeof context?.runId === 'string' && context.runId.length > 0 ? context.runId : null;
  }

  #prune(now) {
    for (const [key, entry] of this.runs) {
      if (entry.expiresAt <= now) this.runs.delete(key);
    }
  }

  #evictOldest() {
    let oldestKey;
    let oldestAccess = Infinity;
    for (const [key, entry] of this.runs) {
      if (entry.lastAccessedAt < oldestAccess) {
        oldestAccess = entry.lastAccessedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.runs.delete(oldestKey);
  }

  #entry(context) {
    const key = this.#runKey(context);
    if (!key) return null;
    const now = this.now();
    this.#prune(now);
    let entry = this.runs.get(key);
    if (!entry) {
      while (this.runs.size >= this.maxActiveRuns) this.#evictOldest();
      entry = {
        runId: key,
        threadId: context.threadId ?? '',
        agentId: context.agentId ?? '',
        artifactEpoch: 0,
        artifactHash: null,
        observations: new Map(),
        lastCallHash: null,
        state: 'normal',
        step: 0,
        lastToolName: '',
        lastAccessedAt: now,
        expiresAt: now + this.ttlMs,
      };
      this.runs.set(key, entry);
    } else {
      entry.threadId ||= context.threadId ?? '';
      entry.agentId ||= context.agentId ?? '';
      entry.lastAccessedAt = now;
      entry.expiresAt = now + this.ttlMs;
    }
    return entry;
  }

  #diagnostic(entry, reasonCode, extra = {}) {
    const payload = {
      reasonCode,
      runId: entry.runId,
      threadId: entry.threadId,
      agentId: entry.agentId,
      toolName: extra.toolName ?? entry.lastToolName,
      step: entry.step,
      state: entry.state,
      artifactEpoch: entry.artifactEpoch,
      callHash: extra.callHash ?? entry.lastCallHash,
      observationHash: extra.observationHash ?? null,
      repeatCount: extra.repeatCount ?? null,
      firstSeenStep: extra.firstSeenStep ?? null,
      lastSeenStep: extra.lastSeenStep ?? entry.step,
    };
    try {
      this.onDiagnostic(payload);
    } catch (_) {
      // Diagnostics must never break tool execution.
    }
    return payload;
  }

  assertCanExecute(context) {
    const entry = this.#entry(context);
    if (!entry || entry.state !== 'stop_requested') return;
    this.#diagnostic(entry, ABORT_CODE);
    throw new AgentNoProgressError();
  }

  observe({ context, toolCall, result, batchSize = 1, batchId = '' }) {
    const entry = this.#entry(context);
    if (!entry) return { action: 'continue', result };

    entry.step += 1;
    entry.lastToolName = toolCall?.name ?? '';
    const callHash = callFingerprint(toolCall, this.maxHashInputChars);
    const observationHash = observationFingerprint(result, this.maxHashInputChars);
    const nextArtifactHash = artifactFingerprint(result?.artifact, this.maxHashInputChars);
    entry.lastCallHash = callHash;

    if (nextArtifactHash !== null && nextArtifactHash !== entry.artifactHash) {
      entry.artifactHash = nextArtifactHash;
      entry.artifactEpoch += 1;
      entry.observations.clear();
      entry.state = 'normal';
    }

    let observation = entry.observations.get(observationHash);
    if (!observation) {
      if (entry.observations.size >= this.maxObservationsPerRun) {
        const oldestHash = entry.observations.keys().next().value;
        entry.observations.delete(oldestHash);
      }
      observation = {
        firstSeenStep: entry.step,
        lastSeenStep: entry.step,
        repeatCount: 1,
        lastBatchId: batchId,
      };
      entry.observations.set(observationHash, observation);
      if (entry.state === 'warned') entry.state = 'normal';
      return { action: 'continue', result };
    }

    observation.lastSeenStep = entry.step;
    observation.repeatCount += 1;
    const sameBatch = batchId && observation.lastBatchId === batchId;
    observation.lastBatchId = batchId;

    if (batchSize > 1 || sameBatch) {
      return { action: 'continue', result };
    }

    if (entry.state === 'normal') {
      entry.state = 'warned';
      const diagnostic = this.#diagnostic(entry, WARNING_CODE, {
        toolName: toolCall?.name,
        callHash,
        observationHash,
        repeatCount: observation.repeatCount,
        firstSeenStep: observation.firstSeenStep,
        lastSeenStep: observation.lastSeenStep,
      });
      return {
        action: 'warn',
        result: appendMarker(result, WARNING_CODE, WARNING_MESSAGE, false),
        diagnostic,
      };
    }

    entry.state = 'stop_requested';
    const diagnostic = this.#diagnostic(entry, STOP_CODE, {
      toolName: toolCall?.name,
      callHash,
      observationHash,
      repeatCount: observation.repeatCount,
      firstSeenStep: observation.firstSeenStep,
      lastSeenStep: observation.lastSeenStep,
    });
    return {
      action: 'stop',
      result: appendMarker(result, STOP_CODE, STOP_MESSAGE, true),
      diagnostic,
    };
  }

  clear(runId) {
    this.runs.delete(runId);
  }

  snapshot(runId) {
    const entry = this.runs.get(runId);
    if (!entry) return null;
    return {
      runId: entry.runId,
      threadId: entry.threadId,
      agentId: entry.agentId,
      artifactEpoch: entry.artifactEpoch,
      artifactHash: entry.artifactHash,
      observationCount: entry.observations.size,
      lastCallHash: entry.lastCallHash,
      state: entry.state,
      step: entry.step,
      expiresAt: entry.expiresAt,
    };
  }
}

function createToolProgressLedger(options) {
  return new ToolProgressLedger(options);
}

module.exports = {
  ABORT_CODE,
  ABORT_MESSAGE,
  AgentNoProgressError,
  DEFAULT_MAX_ACTIVE_RUNS,
  DEFAULT_MAX_HASH_INPUT_CHARS,
  DEFAULT_MAX_OBSERVATIONS_PER_RUN,
  DEFAULT_TTL_MS,
  STOP_CODE,
  STOP_MESSAGE,
  ToolProgressLedger,
  WARNING_CODE,
  WARNING_MESSAGE,
  artifactFingerprint,
  callFingerprint,
  createToolProgressLedger,
  normalizeContent,
  observationFingerprint,
  stableJson,
};

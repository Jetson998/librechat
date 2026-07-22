'use strict';

const GPT_MODEL = 'gpt-5.6-sol';
const FABLE_MODEL = 'claude-fable-5';

const GPT_OLD_TOOL_SENTENCE =
  '你运行在 LibreChat 网页会话里，不是 Codex 或 Claude Code CLI。需要读写、分析或生成文件时，使用本会话实际提供的代码执行工具；工具名通常显示为 Bash 或 execute_code。只调用界面实际提供的工具，不要臆造 Glob、Read、Edit、LS 这类 CLI 专用工具名。';
const GPT_NEUTRAL_SENTENCE = '你运行在 LibreChat 网页会话里，不是 Codex 或 Claude Code CLI。';

const FABLE_OLD_TOOL_SENTENCE =
  '你运行在 LibreChat 网页会话里，不是 Claude Code CLI。需要读写、分析或生成文件时，使用本会话实际提供的代码执行工具；当前 Anthropic 端可用的代码工具名通常显示为 Bash。不要调用 Glob、Read、Edit、LS 这类 Claude Code 专用工具名。';
const FABLE_CANONICAL_TOOL_SENTENCE =
  '你运行在 LibreChat 网页会话里，不是 Claude Code CLI。需要读写、分析或生成文件时，只使用本会话实际提供的 bash_tool、read_file 和 skill。不要调用 Bash、Read、Skill、Grep、Glob、Edit、LS 等 Claude Code CLI 专用工具名。';
const FABLE_NEUTRAL_SENTENCE = '你运行在 LibreChat 网页会话里，不是 Claude Code CLI。';

const OLD_PROGRESS_SENTENCE = '然后在同一轮紧接着调用 Bash 运行 Python。';
const CANONICAL_PROGRESS_SENTENCE = '然后在同一轮紧接着调用 bash_tool 运行 Python。';
const NEUTRAL_PROGRESS_SENTENCE = '然后在同一轮紧接着调用本轮已注册的代码工具运行 Python。';

function clone(value) {
  if (typeof EJSON !== 'undefined') return EJSON.parse(EJSON.stringify(value));
  return JSON.parse(JSON.stringify(value));
}

function countOccurrences(value, needle) {
  return String(value || '').split(needle).length - 1;
}

function getBaseDocument(database) {
  const query = { principalType: 'role', principalId: '__base__', isActive: true };
  const matches = database.configs.find(query).toArray();
  if (matches.length !== 1) {
    throw new Error(`active base config must be unique, found ${matches.length}`);
  }
  return matches[0];
}

function getModelSpec(document, modelName) {
  const specs = document?.overrides?.modelSpecs?.list;
  if (!Array.isArray(specs)) throw new Error('active base modelSpecs.list is missing');
  const matches = specs.filter((spec) => spec?.name === modelName);
  if (matches.length !== 1) {
    throw new Error(`expected one ${modelName} model spec, found ${matches.length}`);
  }
  return matches[0];
}

function replaceOneState(prompt, modelName, states, replacement) {
  const matches = states.filter((state) => countOccurrences(prompt, state) === 1);
  if (matches.length === 1) return prompt.replace(matches[0], replacement);
  if (matches.length === 0 && countOccurrences(prompt, replacement) === 1) return prompt;
  throw new Error(`unexpected ${modelName} prompt state`);
}

function transformGptPrompt(prompt) {
  if (typeof prompt !== 'string') throw new Error(`${GPT_MODEL} promptPrefix must be a string`);
  return replaceOneState(prompt, GPT_MODEL, [GPT_OLD_TOOL_SENTENCE], GPT_NEUTRAL_SENTENCE);
}

function transformFablePrompt(prompt) {
  if (typeof prompt !== 'string') throw new Error(`${FABLE_MODEL} promptPrefix must be a string`);
  let next = replaceOneState(
    prompt,
    FABLE_MODEL,
    [FABLE_OLD_TOOL_SENTENCE, FABLE_CANONICAL_TOOL_SENTENCE],
    FABLE_NEUTRAL_SENTENCE,
  );
  next = replaceOneState(
    next,
    FABLE_MODEL,
    [OLD_PROGRESS_SENTENCE, CANONICAL_PROGRESS_SENTENCE],
    NEUTRAL_PROGRESS_SENTENCE,
  );
  return next;
}

function applyContract(document) {
  const candidate = clone(document);
  const gpt = getModelSpec(candidate, GPT_MODEL);
  const fable = getModelSpec(candidate, FABLE_MODEL);
  gpt.preset ??= {};
  fable.preset ??= {};
  gpt.preset.promptPrefix = transformGptPrompt(gpt.preset.promptPrefix);
  fable.preset.promptPrefix = transformFablePrompt(fable.preset.promptPrefix);
  return candidate;
}

function assertConfigured(document) {
  const gptPrompt = getModelSpec(document, GPT_MODEL)?.preset?.promptPrefix;
  const fablePrompt = getModelSpec(document, FABLE_MODEL)?.preset?.promptPrefix;

  if (countOccurrences(gptPrompt, GPT_NEUTRAL_SENTENCE) !== 1) {
    throw new Error('GPT neutral environment sentence mismatch');
  }
  if (countOccurrences(fablePrompt, FABLE_NEUTRAL_SENTENCE) !== 1) {
    throw new Error('Fable neutral environment sentence mismatch');
  }
  if (countOccurrences(fablePrompt, NEUTRAL_PROGRESS_SENTENCE) !== 1) {
    throw new Error('Fable neutral progress sentence mismatch');
  }

  for (const [modelName, prompt] of [
    [GPT_MODEL, gptPrompt],
    [FABLE_MODEL, fablePrompt],
  ]) {
    for (const stale of [
      GPT_OLD_TOOL_SENTENCE,
      FABLE_OLD_TOOL_SENTENCE,
      FABLE_CANONICAL_TOOL_SENTENCE,
      OLD_PROGRESS_SENTENCE,
      CANONICAL_PROGRESS_SENTENCE,
    ]) {
      if (countOccurrences(prompt, stale) !== 0) {
        throw new Error(`${modelName} still contains model-specific tool contract`);
      }
    }
  }
}

function isConfigured(document) {
  try {
    assertConfigured(document);
    return true;
  } catch (_) {
    return false;
  }
}

function runMongoMode() {
  const mode = process.env.PUBLIC_CODE_TOOL_CONTRACT_MODE || 'preflight';
  const backupId = process.env.PUBLIC_CODE_TOOL_CONTRACT_BACKUP_ID || '';

  if (mode === 'rollback') {
    if (!backupId) throw new Error('backup id is required for rollback');
    const backup = db.codexConfigBackups.findOne({ backupId });
    if (!backup?.document) throw new Error('rollback backup is missing');
    const result = db.configs.replaceOne({ _id: backup.document._id }, backup.document, {
      upsert: true,
    });
    if (result.acknowledged !== true) throw new Error('rollback replace failed');
    print(`rollback=ok backup_id=${backupId}`);
    return;
  }

  const current = getBaseDocument(db);
  if (mode === 'preflight') {
    const candidate = applyContract(current);
    assertConfigured(candidate);
    print(
      `preflight=ok config_version=${current.configVersion || 0} already_configured=${isConfigured(current)}`,
    );
    return;
  }
  if (mode === 'verify') {
    assertConfigured(current);
    print(`verify=ok config_version=${current.configVersion || 0}`);
    return;
  }
  if (mode !== 'apply') throw new Error(`unsupported mode: ${mode}`);
  if (!backupId) throw new Error('backup id is required for apply');
  if (isConfigured(current)) {
    print(`apply=already_configured config_version=${current.configVersion || 0}`);
    return;
  }
  if (db.codexConfigBackups.countDocuments({ backupId }) !== 0) {
    throw new Error('backup id already exists');
  }

  db.codexConfigBackups.insertOne({
    backupId,
    reason: 'Move model-specific code tool names into the public Agent contract',
    createdAt: new Date(),
    document: current,
  });

  const candidate = applyContract(current);
  candidate.configVersion = (Number(current.configVersion) || 0) + 1;
  candidate.updatedAt = new Date();
  const result = db.configs.replaceOne({ _id: current._id }, candidate);
  if (result.acknowledged !== true || result.matchedCount !== 1) {
    throw new Error('config replacement failed');
  }
  assertConfigured(getBaseDocument(db));
  print(`apply=ok config_version=${candidate.configVersion} backup_id=${backupId}`);
}

if (typeof db !== 'undefined') runMongoMode();

if (typeof module !== 'undefined') {
  module.exports = {
    GPT_MODEL,
    FABLE_MODEL,
    GPT_OLD_TOOL_SENTENCE,
    GPT_NEUTRAL_SENTENCE,
    FABLE_OLD_TOOL_SENTENCE,
    FABLE_CANONICAL_TOOL_SENTENCE,
    FABLE_NEUTRAL_SENTENCE,
    OLD_PROGRESS_SENTENCE,
    CANONICAL_PROGRESS_SENTENCE,
    NEUTRAL_PROGRESS_SENTENCE,
    applyContract,
    assertConfigured,
  };
}

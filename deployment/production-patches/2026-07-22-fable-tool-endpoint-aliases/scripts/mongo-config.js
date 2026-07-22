'use strict';

const MODEL_NAME = 'claude-fable-5';
const OLD_TOOL_SENTENCE =
  '你运行在 LibreChat 网页会话里，不是 Claude Code CLI。需要读写、分析或生成文件时，使用本会话实际提供的代码执行工具；当前 Anthropic 端可用的代码工具名通常显示为 Bash。不要调用 Glob、Read、Edit、LS 这类 Claude Code 专用工具名。';
const NEW_TOOL_SENTENCE =
  '你运行在 LibreChat 网页会话里，不是 Claude Code CLI。需要读写、分析或生成文件时，只使用本会话实际提供的 bash_tool、read_file 和 skill。不要调用 Bash、Read、Skill、Grep、Glob、Edit、LS 等 Claude Code CLI 专用工具名。';
const OLD_PROGRESS_SENTENCE = '然后在同一轮紧接着调用 Bash 运行 Python。';
const NEW_PROGRESS_SENTENCE = '然后在同一轮紧接着调用 bash_tool 运行 Python。';

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

function getFableSpec(document) {
  const specs = document?.overrides?.modelSpecs?.list;
  if (!Array.isArray(specs)) throw new Error('active base modelSpecs.list is missing');
  const matches = specs.filter((spec) => spec?.name === MODEL_NAME);
  if (matches.length !== 1) {
    throw new Error(`expected one ${MODEL_NAME} model spec, found ${matches.length}`);
  }
  return matches[0];
}

function transformPrompt(prompt) {
  if (typeof prompt !== 'string') throw new Error(`${MODEL_NAME} promptPrefix must be a string`);

  let next = prompt;
  const oldToolCount = countOccurrences(next, OLD_TOOL_SENTENCE);
  const newToolCount = countOccurrences(next, NEW_TOOL_SENTENCE);
  if (oldToolCount === 1 && newToolCount === 0) {
    next = next.replace(OLD_TOOL_SENTENCE, NEW_TOOL_SENTENCE);
  } else if (!(oldToolCount === 0 && newToolCount === 1)) {
    throw new Error(`unexpected Fable tool sentence state: old=${oldToolCount} new=${newToolCount}`);
  }

  const oldProgressCount = countOccurrences(next, OLD_PROGRESS_SENTENCE);
  const newProgressCount = countOccurrences(next, NEW_PROGRESS_SENTENCE);
  if (oldProgressCount === 1 && newProgressCount === 0) {
    next = next.replace(OLD_PROGRESS_SENTENCE, NEW_PROGRESS_SENTENCE);
  } else if (!(oldProgressCount === 0 && newProgressCount === 1)) {
    throw new Error(
      `unexpected Fable progress sentence state: old=${oldProgressCount} new=${newProgressCount}`,
    );
  }

  return next;
}

function applyContract(document) {
  const candidate = clone(document);
  const spec = getFableSpec(candidate);
  spec.preset ??= {};
  spec.preset.promptPrefix = transformPrompt(spec.preset.promptPrefix);
  return candidate;
}

function assertConfigured(document) {
  const prompt = getFableSpec(document)?.preset?.promptPrefix;
  if (countOccurrences(prompt, OLD_TOOL_SENTENCE) !== 0) throw new Error('old tool sentence remains');
  if (countOccurrences(prompt, NEW_TOOL_SENTENCE) !== 1) throw new Error('new tool sentence mismatch');
  if (countOccurrences(prompt, OLD_PROGRESS_SENTENCE) !== 0) {
    throw new Error('old progress sentence remains');
  }
  if (countOccurrences(prompt, NEW_PROGRESS_SENTENCE) !== 1) {
    throw new Error('new progress sentence mismatch');
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
  const mode = process.env.FABLE_TOOL_ALIAS_MODE || 'preflight';
  const backupId = process.env.FABLE_TOOL_ALIAS_BACKUP_ID || '';

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
    reason: 'Normalize Fable legacy Claude Code tool aliases',
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

runMongoMode();

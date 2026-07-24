'use strict';

const MARKER_START = '[IMAGE_GENERATION_UNSUPPORTED_V1]';
const MARKER_END = '[/IMAGE_GENERATION_UNSUPPORTED_V1]';
const TARGET_MODELS = ['gpt-5.6-sol', 'claude-fable-5'];
const CONTRACT_TEXT = `[IMAGE_GENERATION_UNSUPPORTED_V1]
当前产品不支持生成图片，也没有可调用的 image_gen、image_gen_oai、gemini_image_gen 或其他生图工具。不得声称已经调用图片模型或已经生成图片，不得使用 bash_tool、read_file 或目录扫描寻找并不存在的图片产物。
当用户明确要求生成图片时，直接说明：“当前产品暂不支持生成图片。你可以上传已有图片，继续用于 PPT 或其他文档制作。”
用户已经上传图片时，可以使用本会话实际提供的文件和代码工具读取、编辑或嵌入该图片；该限制不影响已有图片处理。
[/IMAGE_GENERATION_UNSUPPORTED_V1]`;

function clone(value) {
  if (typeof EJSON !== 'undefined') return EJSON.parse(EJSON.stringify(value));
  return JSON.parse(JSON.stringify(value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeContract(value) {
  const pattern = new RegExp(
    `\\n?${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}\\n?`,
    'g',
  );
  return String(value || '').replace(pattern, '\n').trimEnd();
}

function appendContract(value) {
  const base = removeContract(value);
  return `${base}${base ? '\n\n' : ''}${CONTRACT_TEXT}`;
}

function getBaseDocument(database) {
  const matches = database.configs
    .find({ principalType: 'role', principalId: '__base__', isActive: true })
    .toArray();
  if (matches.length !== 1) {
    throw new Error(`active base config must be unique, found ${matches.length}`);
  }
  return matches[0];
}

function applyContractToDocument(document) {
  const candidate = clone(document);
  const specs = candidate?.overrides?.modelSpecs?.list;
  if (!Array.isArray(specs)) throw new Error('active base modelSpecs.list is missing');

  for (const modelName of TARGET_MODELS) {
    const matches = specs.filter((spec) => spec?.name === modelName);
    if (matches.length !== 1) {
      throw new Error(`expected one ${modelName} base model spec, found ${matches.length}`);
    }
    const prompt = matches[0]?.preset?.promptPrefix;
    if (typeof prompt !== 'string') {
      throw new Error(`${modelName} base preset.promptPrefix must be a string`);
    }
    matches[0].preset.promptPrefix = appendContract(prompt);
  }
  return candidate;
}

function assertConfigured(document) {
  const specs = document?.overrides?.modelSpecs?.list;
  if (!Array.isArray(specs)) throw new Error('modelSpecs.list is missing');
  for (const modelName of TARGET_MODELS) {
    const matches = specs.filter((spec) => spec?.name === modelName);
    if (matches.length !== 1) throw new Error(`${modelName} count mismatch`);
    const prompt = matches[0]?.preset?.promptPrefix;
    if (typeof prompt !== 'string') throw new Error(`${modelName} prompt missing`);
    if (prompt.split(MARKER_START).length - 1 !== 1) {
      throw new Error(`${modelName} start marker count mismatch`);
    }
    if (prompt.split(MARKER_END).length - 1 !== 1) {
      throw new Error(`${modelName} end marker count mismatch`);
    }
    if (!prompt.includes('不得声称已经调用图片模型或已经生成图片')) {
      throw new Error(`${modelName} unsupported image claim contract missing`);
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
  const mode = process.env.AGENT_PROGRESS_LEDGER_MODE || 'preflight';
  const backupId = process.env.AGENT_PROGRESS_LEDGER_BACKUP_ID || '';

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
    const candidate = applyContractToDocument(current);
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
    reason: 'LibreChat unsupported image generation capability contract',
    createdAt: new Date(),
    document: current,
  });
  const candidate = applyContractToDocument(current);
  candidate.configVersion = (Number(current.configVersion) || 0) + 1;
  candidate.updatedAt = new Date();
  const result = db.configs.replaceOne({ _id: current._id }, candidate);
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
    throw new Error('base config update did not modify one document');
  }
  assertConfigured(getBaseDocument(db));
  print(`apply=ok backup_id=${backupId} config_version=${candidate.configVersion}`);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONTRACT_TEXT,
    MARKER_END,
    MARKER_START,
    TARGET_MODELS,
    appendContract,
    applyContractToDocument,
    assertConfigured,
    isConfigured,
    removeContract,
  };
}

if (typeof db !== 'undefined') {
  runMongoMode();
}

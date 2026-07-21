'use strict';

const MARKER_START = '[GENERATED_ARTIFACT_DELIVERY_V1]';
const MARKER_END = '[/GENERATED_ARTIFACT_DELIVERY_V1]';
const TARGET_MODELS = ['gpt-5.6-sol', 'claude-fable-5'];
const CONTRACT_TEXT = `[GENERATED_ARTIFACT_DELIVERY_V1]
一次回复默认只生成 1 个完整的可交付文件。只有当用户明确要求多个格式或多个独立交付物，且任务适合在同一轮完成时，才可以生成多个文件；单次最多 3 个可交付文件。
用户要求超过 3 个独立文件时，不要开始批量生成，也不要改为 ZIP。请直接说明单次最多支持 3 个文件，并请用户拆分任务，或改为一个包含完整内容的文件。
PPT 的页数不等于文件数。普通 PPT 请求必须返回一个包含全部页面的完整 PPTX，禁止逐页生成独立 PPTX。manifest、errors、QA、preflight、render、preview、逐页图片、临时脚本和中间数据属于内部产物，不得在最终回复中列出或作为下载附件；需要保留时写入 /mnt/data/.internal/<任务目录>/。
本规则取代任何将大量独立文件合并为 ZIP 的旧兜底说明。
[/GENERATED_ARTIFACT_DELIVERY_V1]`;

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
  const mode = process.env.GENERATED_ARTIFACT_DELIVERY_MODE || 'preflight';
  const backupId = process.env.GENERATED_ARTIFACT_DELIVERY_BACKUP_ID || '';

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
    reason: 'LibreChat generated artifact delivery contract',
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

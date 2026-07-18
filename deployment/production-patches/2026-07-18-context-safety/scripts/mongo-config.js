'use strict';

const MARKER_START = '[CONTEXT_SAFETY_BATCH_V1]';
const MARKER_END = '[/CONTEXT_SAFETY_BATCH_V1]';
const TARGET_MODELS = ['gpt-5.6-sol', 'claude-fable-5'];
const CONTRACT_TEXT = `[CONTEXT_SAFETY_BATCH_V1]
处理大文件或大量 JSON、CSV、Excel、Word、PowerPoint 记录时，只允许一次轻量预检，输出文件大小、结构、Sheet 或字段、记录数和受控样本。主处理必须使用一个确定性的 Python 批处理程序；程序内部可以流式读取、分块处理、重试和断点续跑，不要求把全部内容一次载入内存。大型 Excel 优先使用 openpyxl(read_only=True)，大型 JSON 优先使用流式解析器，避免整体 json.load。
禁止完整 print、pprint 或 repr 原始数据、聊天历史、工具载荷、响应体和整份文档。stdout 主动控制在 8000 字符以内；默认样本最多 5 行，异常最多 20 项。完整结果写入 /mnt/data/<任务目录>/，包括 manifest.json、用户要求的 Markdown、Excel、Word、PowerPoint、PDF 或 ZIP 成果、errors.json 和必要检查点。不要为了持久化而默认创建冗余 full_dump；原文件能作为数据源时保留原文件。
最终工具输出只返回处理数量、成功和失败数量、关键警告及生成文件路径。结果超过可返回范围时，必须先保存完整成果，再仅返回摘要和文件卡；需要细节时按 Sheet/范围、章节/页码、记录 ID 或 JSON 字段定向读取，禁止重新把完整结果注入上下文。
预检后向用户说明“检测到较大文件，将分块处理。原始内容不会全部加入对话上下文，请稍候。”；处理时说明“正在处理文件并生成结果，详细内容会保存为可下载文件。”；结果受限时说明“为保证对话稳定，当前回复仅保留摘要；完整结果已保存并附在下方文件中。”；完成时报告处理、成功、失败数量和文件清单。不得向用户显示 stdout、maxToolResultChars、LangGraph、递归栈或内部错误术语。
[/CONTEXT_SAFETY_BATCH_V1]`;

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
  const query = { principalType: 'role', principalId: '__base__', isActive: true };
  const matches = database.configs.find(query).toArray();
  if (matches.length !== 1) {
    throw new Error(`active base config must be unique, found ${matches.length}`);
  }
  return matches[0];
}

function applyContractToDocument(document) {
  const doc = clone(document);
  doc.overrides ??= {};
  doc.overrides.endpoints ??= {};
  doc.overrides.endpoints.agents ??= {};
  doc.overrides.endpoints.agents.maxToolResultChars = 32000;
  doc.overrides.endpoints.agents.recursionLimit = 50;
  doc.overrides.endpoints.agents.maxRecursionLimit = 50;

  const specs = doc.overrides?.modelSpecs?.list;
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
  return doc;
}

function assertConfigured(document) {
  const agents = document?.overrides?.endpoints?.agents;
  if (agents?.maxToolResultChars !== 32000) throw new Error('maxToolResultChars mismatch');
  if (agents?.recursionLimit !== 50) throw new Error('recursionLimit mismatch');
  if (agents?.maxRecursionLimit !== 50) throw new Error('maxRecursionLimit mismatch');
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

function stripTargetedFields(document) {
  const doc = clone(document);
  const agents = doc?.overrides?.endpoints?.agents;
  if (agents && typeof agents === 'object') {
    delete agents.maxToolResultChars;
    delete agents.recursionLimit;
    delete agents.maxRecursionLimit;
  }
  const specs = doc?.overrides?.modelSpecs?.list;
  if (Array.isArray(specs)) {
    for (const modelName of TARGET_MODELS) {
      const matches = specs.filter((spec) => spec?.name === modelName);
      if (matches.length === 1 && typeof matches[0]?.preset?.promptPrefix === 'string') {
        matches[0].preset.promptPrefix = removeContract(matches[0].preset.promptPrefix);
      }
    }
  }
  delete doc.configVersion;
  delete doc.updatedAt;
  return doc;
}

function isConfigured(document) {
  try {
    assertConfigured(document);
    return true;
  } catch (_) {
    return false;
  }
}

function serialize(value) {
  return typeof EJSON !== 'undefined' ? EJSON.stringify(value) : JSON.stringify(value);
}

function runMongoMode() {
  const mode = process.env.CONTEXT_SAFETY_MODE || 'preflight';
  const backupId = process.env.CONTEXT_SAFETY_BACKUP_ID || '';
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
  if (mode === 'dump') {
    print(serialize(current));
    return;
  }
  if (mode === 'preservation') {
    print(serialize(stripTargetedFields(current)));
    return;
  }
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
    reason: 'LibreChat context safety Stage A',
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
    stripTargetedFields,
  };
}

if (typeof db !== 'undefined') {
  runMongoMode();
}

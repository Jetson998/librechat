'use strict';

const TARGET_MODELS = [
  'claude-fable-5-1',
  'claude-opus-5',
  'claude-opus-4-8',
  'gpt-5.6-sol',
  'claude-fable-5',
];

function clone(value) {
  if (typeof EJSON !== 'undefined') return EJSON.parse(EJSON.stringify(value));
  return JSON.parse(JSON.stringify(value));
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

function getTargets(document) {
  const specs = document?.overrides?.modelSpecs?.list;
  if (!Array.isArray(specs)) throw new Error('active base modelSpecs.list is missing');
  return TARGET_MODELS.map((name) => {
    const matches = specs.filter((spec) => spec?.name === name);
    if (matches.length !== 1) throw new Error(`expected one ${name} base model spec, found ${matches.length}`);
    return matches[0];
  });
}

function snapshot(document) {
  return getTargets(document).map((spec) => ({
    name: spec.name,
    effort: spec.preset?.effort,
    reasoning_effort: spec.preset?.reasoning_effort,
    thinking: spec.preset?.thinking,
    thinkingDisplay: spec.preset?.thinkingDisplay,
  }));
}

function clearPresetEffort(document) {
  const candidate = clone(document);
  for (const spec of getTargets(candidate)) {
    if (!spec.preset || typeof spec.preset !== 'object') {
      throw new Error(`${spec.name} base preset is missing`);
    }
    delete spec.preset.effort;
    delete spec.preset.reasoning_effort;
  }
  return candidate;
}

function assertCleared(document) {
  for (const spec of getTargets(document)) {
    if (Object.prototype.hasOwnProperty.call(spec.preset, 'effort')) {
      throw new Error(`${spec.name} preset.effort is still set`);
    }
    if (Object.prototype.hasOwnProperty.call(spec.preset, 'reasoning_effort')) {
      throw new Error(`${spec.name} preset.reasoning_effort is still set`);
    }
  }
}

function runMongoMode() {
  const mode = process.env.CLEAR_MODEL_EFFORT_MODE || 'preflight';
  const backupId = process.env.CLEAR_MODEL_EFFORT_BACKUP_ID || '';

  if (mode === 'rollback') {
    if (!backupId) throw new Error('backup id is required for rollback');
    const backup = db.codexConfigBackups.findOne({ backupId });
    if (!backup?.document) throw new Error('rollback backup is missing');
    const result = db.configs.replaceOne({ _id: backup.document._id }, backup.document, { upsert: true });
    if (result.acknowledged !== true || result.matchedCount + result.upsertedCount !== 1) {
      throw new Error('rollback replace failed');
    }
    print(JSON.stringify({ mode, backupId, status: 'passed' }));
    return;
  }

  const current = getBaseDocument(db);
  const before = snapshot(current);
  const candidate = clearPresetEffort(current);
  const after = snapshot(candidate);

  if (mode === 'preflight') {
    assertCleared(candidate);
    print(JSON.stringify({
      mode,
      status: 'passed',
      configVersion: current.configVersion || 0,
      alreadyCleared: JSON.stringify(before) === JSON.stringify(after),
      before,
      after,
    }));
    return;
  }
  if (mode !== 'apply') throw new Error(`unsupported mode: ${mode}`);
  if (!backupId) throw new Error('backup id is required for apply');
  if (db.codexConfigBackups.countDocuments({ backupId }) !== 0) {
    throw new Error('backup id already exists');
  }

  db.codexConfigBackups.insertOne({
    backupId,
    reason: 'Clear global model reasoning-strength presets; vendor-managed default',
    createdAt: new Date(),
    document: current,
  });

  candidate.configVersion = (Number(current.configVersion) || 0) + 1;
  candidate.updatedAt = new Date();
  const result = db.configs.replaceOne({ _id: current._id }, candidate);
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
    throw new Error('base config update did not modify one document');
  }
  const updated = getBaseDocument(db);
  assertCleared(updated);
  print(JSON.stringify({
    mode,
    status: 'passed',
    backupId,
    configVersion: updated.configVersion || 0,
    before,
    after: snapshot(updated),
  }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TARGET_MODELS, assertCleared, clearPresetEffort, snapshot };
}

if (typeof db !== 'undefined') runMongoMode();

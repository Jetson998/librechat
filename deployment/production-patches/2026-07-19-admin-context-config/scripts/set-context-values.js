const releaseCommit = process.env.RELEASE_COMMIT;
const backupId = process.env.BACKUP_ID;
if (!releaseCommit || !backupId) throw new Error('release metadata is required');

const query = { principalType: 'role', principalId: '__base__', isActive: true };
if (db.configs.countDocuments(query) !== 1) {
  throw new Error('active base override must be unique');
}
if (db.codexConfigBackups.countDocuments({ backupId }) !== 0) {
  throw new Error('backup id already exists');
}

const current = db.configs.findOne(query);
const candidate = EJSON.parse(EJSON.stringify(current));
const targets = [
  { endpoint: 'MuskAPI', model: 'gpt-5.6-sol' },
  { endpoint: 'MuskAPI-Anthropic', model: 'claude-fable-5' },
];
const custom = candidate?.overrides?.endpoints?.custom;
if (!Array.isArray(custom)) throw new Error('custom endpoints are missing');

function withoutContext(value) {
  const copy = EJSON.parse(EJSON.stringify(value));
  delete copy.context;
  return copy;
}

const beforeModels = new Map();
for (const target of targets) {
  const matches = custom.filter((endpoint) => endpoint?.name === target.endpoint);
  if (matches.length !== 1) throw new Error(`endpoint must be unique: ${target.endpoint}`);
  const modelConfig = matches[0]?.tokenConfig?.[target.model];
  if (!modelConfig || typeof modelConfig !== 'object' || Array.isArray(modelConfig)) {
    throw new Error(`model config is missing: ${target.endpoint}/${target.model}`);
  }
  beforeModels.set(`${target.endpoint}\u0000${target.model}`, EJSON.parse(EJSON.stringify(modelConfig)));
  modelConfig.context = 1000000;
}

db.codexConfigBackups.insertOne({
  backupId,
  createdAt: new Date(),
  releaseCommit,
  reason: 'seed model context limits for the user model market',
  document: current,
});

const result = db.configs.replaceOne({ _id: current._id }, candidate);
if (result.modifiedCount !== 1) throw new Error('config update did not modify exactly one document');

const persisted = db.configs.findOne(query);
const persistedCustom = persisted?.overrides?.endpoints?.custom;
for (const target of targets) {
  const endpoint = persistedCustom.find((item) => item?.name === target.endpoint);
  const modelConfig = endpoint?.tokenConfig?.[target.model];
  if (modelConfig?.context !== 1000000) {
    throw new Error(`context was not persisted: ${target.endpoint}/${target.model}`);
  }
  const before = beforeModels.get(`${target.endpoint}\u0000${target.model}`);
  if (EJSON.stringify(withoutContext(modelConfig)) !== EJSON.stringify(withoutContext(before))) {
    throw new Error(`non-context model fields changed: ${target.endpoint}/${target.model}`);
  }
  print(`context=${target.endpoint}/${target.model}=1000000`);
}
print(`backup_id=${backupId}`);


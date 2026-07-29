if (typeof COMPILED === 'undefined' || typeof BACKUP === 'undefined') {
  throw new Error('COMPILED catalog and BACKUP snapshot are required');
}

const globalScope = { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };
const targetAgentIds = COMPILED.agents.map((agent) => agent.id);
const targetCategoryValues = [
  COMPILED.category.value,
  ...COMPILED.defaultCategoriesToDisable,
];
const currentAgents = db.agents
  .find({ id: { $in: targetAgentIds }, ...globalScope }, { _id: 1 })
  .toArray();
const backupAgents = BACKUP.agents || [];
const resourceIds = [
  ...currentAgents.map((agent) => agent._id),
  ...backupAgents.map((agent) => agent._id),
];

if (resourceIds.length > 0) {
  db.aclentries.deleteMany({
    resourceType: 'agent',
    resourceId: { $in: resourceIds },
    ...globalScope,
  });
}
db.agents.deleteMany({ id: { $in: targetAgentIds }, ...globalScope });
db.agentcategories.deleteMany({ value: { $in: targetCategoryValues }, ...globalScope });

if (backupAgents.length > 0) db.agents.insertMany(backupAgents, { ordered: true });
if ((BACKUP.aclEntries || []).length > 0) {
  db.aclentries.insertMany(BACKUP.aclEntries, { ordered: true });
}
if ((BACKUP.categories || []).length > 0) {
  db.agentcategories.insertMany(BACKUP.categories, { ordered: true });
}

const restoredAgents = db.agents
  .find({ id: { $in: targetAgentIds }, ...globalScope })
  .sort({ id: 1 })
  .toArray();
const restoredCategories = db.agentcategories
  .find({ value: { $in: targetCategoryValues }, ...globalScope })
  .sort({ value: 1 })
  .toArray();

if (restoredAgents.length !== backupAgents.length) {
  throw new Error('Rollback Agent count does not match the backup');
}
if (restoredCategories.length !== (BACKUP.categories || []).length) {
  throw new Error('Rollback category count does not match the backup');
}

print(
  EJSON.stringify({
    status: 'passed',
    restoredAgents: restoredAgents.length,
    restoredAclEntries: (BACKUP.aclEntries || []).length,
    restoredCategories: restoredCategories.length,
  }),
);

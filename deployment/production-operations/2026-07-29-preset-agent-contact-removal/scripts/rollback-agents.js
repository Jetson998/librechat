if (typeof COMPILED === 'undefined' || typeof BACKUP === 'undefined') {
  throw new Error('COMPILED catalog and BACKUP snapshot are required');
}

const MANAGED_BY = 'librechat-preset-workflow-agents';
const globalScope = { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };
const targetIds = COMPILED.agents.map((agent) => agent.id).sort();
const backupAgents = (BACKUP.agents || []).sort((left, right) => left.id.localeCompare(right.id));

if (backupAgents.length !== 7 || JSON.stringify(backupAgents.map((agent) => agent.id)) !== JSON.stringify(targetIds)) {
  throw new Error('Backup does not contain the exact seven target Agents');
}

const currentAgents = db.agents
  .find({ id: { $in: targetIds }, ...globalScope })
  .sort({ id: 1 })
  .toArray();
if (currentAgents.length !== 7) {
  throw new Error('Current target Agent count is not seven');
}

for (const backupAgent of backupAgents) {
  if (backupAgent.managedBy !== MANAGED_BY) {
    throw new Error(`${backupAgent.id} backup is not managed by this release`);
  }
  const result = db.agents.replaceOne(
    {
      _id: backupAgent._id,
      id: backupAgent.id,
      managedBy: MANAGED_BY,
      ...globalScope,
    },
    backupAgent,
  );
  if (result.matchedCount !== 1 || ![0, 1].includes(result.modifiedCount)) {
    throw new Error(`Failed to restore ${backupAgent.id}`);
  }
}

print(
  EJSON.stringify({
    status: 'passed',
    restoredAgents: backupAgents.length,
    writes: ['agents'],
  }),
);

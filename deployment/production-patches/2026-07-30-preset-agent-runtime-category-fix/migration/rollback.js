if (typeof BACKUP === 'undefined') {
  throw new Error('BACKUP is required');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const backupAgents = BACKUP.agents || [];
const backupAclEntries = BACKUP.aclEntries || [];
assert(backupAgents.length === 7, 'Rollback backup must contain seven Agents');
assert(backupAclEntries.length === 14, 'Rollback backup must contain 14 ACL entries');

for (const agent of backupAgents) {
  const result = db.agents.replaceOne({ _id: agent._id }, agent, { upsert: false });
  assert(result.matchedCount === 1, `Rollback target Agent is missing: ${agent.id}`);
}

const resourceIds = backupAgents.map((agent) => agent._id);
const restoredAgents = db.agents
  .find({ _id: { $in: resourceIds } })
  .sort({ id: 1, _id: 1 })
  .toArray();
const currentAclEntries = db.aclentries
  .find({ resourceType: 'agent', resourceId: { $in: resourceIds } })
  .sort({ resourceId: 1, principalType: 1, principalId: 1, _id: 1 })
  .toArray();

assert(EJSON.stringify(restoredAgents) === EJSON.stringify(backupAgents), 'Agent rollback mismatch');
assert(EJSON.stringify(currentAclEntries) === EJSON.stringify(backupAclEntries), 'ACL drift detected during rollback');

print(EJSON.stringify({ status: 'passed', restoredAgents: restoredAgents.length, aclCount: currentAclEntries.length }));

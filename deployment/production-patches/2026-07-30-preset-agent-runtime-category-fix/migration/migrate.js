if (typeof MAPPING === 'undefined') {
  throw new Error('MAPPING is required');
}

const MANAGED_BY = 'librechat-preset-workflow-agents';
const globalScope = { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const legacyIds = MAPPING.map(([legacyId]) => legacyId);
const nextIds = MAPPING.map(([, nextId]) => nextId);
assert(new Set(legacyIds).size === 7, 'Expected seven unique legacy Agent IDs');
assert(new Set(nextIds).size === 7, 'Expected seven unique new Agent IDs');
assert(nextIds.every((id) => id.startsWith('agent_workflow_')), 'New IDs must use agent_workflow_');

const legacyAgents = db.agents
  .find({ id: { $in: legacyIds }, ...globalScope })
  .sort({ id: 1 })
  .toArray();
assert(legacyAgents.length === 7, `Expected seven legacy Agents, found ${legacyAgents.length}`);
assert(
  db.agents.countDocuments({ id: { $in: nextIds }, ...globalScope }) === 0,
  'One or more target Agent IDs already exist',
);

const resourceIds = legacyAgents.map((agent) => agent._id);
const aclBefore = db.aclentries
  .find({ resourceType: 'agent', resourceId: { $in: resourceIds }, ...globalScope })
  .sort({ resourceId: 1, principalType: 1, principalId: 1, _id: 1 })
  .toArray();
assert(aclBefore.length === 14, `Expected 14 ACL entries, found ${aclBefore.length}`);

const migrated = [];
for (const [legacyId, nextId] of MAPPING) {
  const agent = db.agents.findOne({ id: legacyId, ...globalScope });
  assert(agent, `Missing legacy Agent ${legacyId}`);
  assert(agent.managedBy === MANAGED_BY, `${legacyId} is not managed by ${MANAGED_BY}`);
  assert(Array.isArray(agent.versions) && agent.versions.length > 0, `${legacyId} has no versions`);
  assert(
    agent.versions.every((version) => version.id === legacyId),
    `${legacyId} has a version with an unexpected ID`,
  );
  const versions = agent.versions.map((version) => ({ ...version, id: nextId }));
  const result = db.agents.updateOne(
    { _id: agent._id, id: legacyId, managedBy: MANAGED_BY },
    { $set: { id: nextId, versions } },
  );
  assert(result.matchedCount === 1 && result.modifiedCount === 1, `Failed to migrate ${legacyId}`);
  const updated = db.agents.findOne({ _id: agent._id });
  assert(updated.id === nextId, `${legacyId} top-level ID did not migrate`);
  assert(updated.versions.every((version) => version.id === nextId), `${legacyId} versions did not migrate`);
  assert(String(updated.author) === String(agent.author), `${legacyId} owner changed`);
  assert(updated.provider === agent.provider && updated.model === agent.model, `${legacyId} model routing changed`);
  migrated.push({ legacyId, nextId, resourceId: agent._id, versionCount: versions.length });
}

assert(
  db.agents.countDocuments({ id: { $in: legacyIds }, ...globalScope }) === 0,
  'Legacy Agent IDs remain after migration',
);
assert(
  db.agents.countDocuments({ id: { $in: nextIds }, ...globalScope }) === 7,
  'New Agent ID count is not seven after migration',
);
const aclAfter = db.aclentries
  .find({ resourceType: 'agent', resourceId: { $in: resourceIds }, ...globalScope })
  .sort({ resourceId: 1, principalType: 1, principalId: 1, _id: 1 })
  .toArray();
assert(EJSON.stringify(aclAfter) === EJSON.stringify(aclBefore), 'Agent ACL entries changed');

print(EJSON.stringify({ status: 'passed', migrated, aclCount: aclAfter.length }));

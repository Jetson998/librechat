if (typeof COMPILED === 'undefined') {
  throw new Error('COMPILED catalog is required');
}

const targetAgentIds = COMPILED.agents.map((agent) => agent.id).sort();
const targetCategoryValues = [
  COMPILED.category.value,
  ...COMPILED.defaultCategoriesToDisable,
].sort();
const globalScope = { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };

const agents = db.agents
  .find({ id: { $in: targetAgentIds }, ...globalScope })
  .sort({ id: 1 })
  .toArray();
const resourceIds = agents.map((agent) => agent._id);
const aclEntries = resourceIds.length
  ? db.aclentries
      .find({ resourceType: 'agent', resourceId: { $in: resourceIds }, ...globalScope })
      .sort({ resourceId: 1, principalType: 1, principalId: 1, _id: 1 })
      .toArray()
  : [];
const categories = db.agentcategories
  .find({ value: { $in: targetCategoryValues }, ...globalScope })
  .sort({ value: 1, _id: 1 })
  .toArray();
const ownerCandidates = db.users
  .find(
    { username: 'admin' },
    { _id: 1, username: 1, name: 1, role: 1 },
  )
  .sort({ _id: 1 })
  .toArray();
const accessRoles = db.accessroles
  .find(
    { accessRoleId: { $in: ['agent_owner', 'agent_viewer'] } },
    { _id: 1, accessRoleId: 1, resourceType: 1, permBits: 1 },
  )
  .sort({ accessRoleId: 1 })
  .toArray();

print(
  EJSON.stringify({
    schemaVersion: 1,
    catalogDigest: COMPILED.compiledDigest,
    targetAgentIds,
    targetCategoryValues,
    ownerCandidates,
    accessRoles,
    agents,
    aclEntries,
    categories,
  }),
);

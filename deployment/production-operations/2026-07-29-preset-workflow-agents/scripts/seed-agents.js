if (typeof COMPILED === 'undefined') {
  throw new Error('COMPILED catalog is required');
}

const crypto = require('crypto');
const MANAGED_BY = 'librechat-preset-workflow-agents';
const globalScope = { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function withoutPersistedDigest(workflowTemplate) {
  const copy = { ...(workflowTemplate || {}) };
  delete copy.persistedDigest;
  return copy;
}

function persistedPayload(compiledAgent) {
  const workflowTemplate = {
    templateId: compiledAgent.templateId,
    templateVersion: compiledAgent.templateVersion,
    engine: compiledAgent.engine,
    manifestDigest: compiledAgent.manifestDigest,
    sourceAgentDigest: compiledAgent.agentDigest,
    domain: compiledAgent.domain,
    priority: compiledAgent.priority,
    limits: compiledAgent.limits,
    inputContract: compiledAgent.inputContract,
    outputContract: compiledAgent.outputContract,
    acceptanceFixtures: compiledAgent.acceptanceFixtures,
  };
  const payload = {
    id: compiledAgent.id,
    name: compiledAgent.name,
    description: compiledAgent.description,
    instructions: compiledAgent.instructions,
    provider: compiledAgent.provider,
    model: compiledAgent.model,
    model_parameters: compiledAgent.model_parameters || {},
    recursion_limit: compiledAgent.recursion_limit,
    tools: compiledAgent.tools,
    skills_enabled: compiledAgent.skills_enabled,
    category: compiledAgent.category,
    is_promoted: compiledAgent.is_promoted,
    hide_sequential_outputs: compiledAgent.hide_sequential_outputs,
    end_after_tools: compiledAgent.end_after_tools,
    conversation_starters: compiledAgent.conversation_starters,
    support_contact: compiledAgent.support_contact,
    authorName: 'LibreChat',
    edges: [],
    tool_resources: {},
    mcpServerNames: [],
    managedBy: MANAGED_BY,
    workflowTemplate,
  };
  const persistedDigest = digest(payload);
  payload.workflowTemplate = { ...workflowTemplate, persistedDigest };
  return payload;
}

function comparableExisting(existing) {
  return {
    id: existing.id,
    name: existing.name,
    description: existing.description,
    instructions: existing.instructions,
    provider: existing.provider,
    model: existing.model,
    model_parameters: existing.model_parameters || {},
    recursion_limit: existing.recursion_limit,
    tools: existing.tools || [],
    skills_enabled: existing.skills_enabled,
    category: existing.category,
    is_promoted: existing.is_promoted,
    hide_sequential_outputs: existing.hide_sequential_outputs,
    end_after_tools: existing.end_after_tools,
    conversation_starters: existing.conversation_starters || [],
    support_contact: existing.support_contact,
    authorName: existing.authorName,
    edges: existing.edges || [],
    tool_resources: existing.tool_resources || {},
    mcpServerNames: existing.mcpServerNames || [],
    managedBy: existing.managedBy,
    workflowTemplate: withoutPersistedDigest(existing.workflowTemplate),
  };
}

function versionSnapshot(payload, now) {
  return {
    ...payload,
    createdAt: now,
    updatedAt: now,
  };
}

const owner = db.users.findOne({ username: 'admin', role: 'ADMIN' });
assert(owner, 'Expected one ADMIN user named admin');
assert(db.users.countDocuments({ username: 'admin' }) === 1, 'admin username is not unique');

const ownerRole = db.accessroles.findOne({ accessRoleId: 'agent_owner', resourceType: 'agent' });
const viewerRole = db.accessroles.findOne({ accessRoleId: 'agent_viewer', resourceType: 'agent' });
assert(ownerRole && ownerRole.permBits === 15, 'agent_owner role is missing or invalid');
assert(viewerRole && viewerRole.permBits === 1, 'agent_viewer role is missing or invalid');

const now = new Date();
let created = 0;
let updated = 0;
let unchanged = 0;
let ownerAclUpserts = 0;
let publicAclUpserts = 0;

for (const compiledAgent of COMPILED.agents) {
  const existing = db.agents.findOne({ id: compiledAgent.id, ...globalScope });
  const payload = persistedPayload(compiledAgent);
  const expectedDigest = payload.workflowTemplate.persistedDigest;

  if (existing) {
    assert(existing.managedBy === MANAGED_BY, `${compiledAgent.id} is not managed by this release`);
    assert(String(existing.author) === String(owner._id), `${compiledAgent.id} has a different owner`);
    assert(
      existing.workflowTemplate?.templateId === compiledAgent.templateId,
      `${compiledAgent.id} has a conflicting template identity`,
    );
    const storedDigest = existing.workflowTemplate?.persistedDigest;
    assert(storedDigest, `${compiledAgent.id} has no persisted drift digest`);
    assert(
      storedDigest === digest(comparableExisting(existing)),
      `${compiledAgent.id} was edited outside the managed release`,
    );

    if (storedDigest === expectedDigest) {
      unchanged += 1;
    } else {
      const updateResult = db.agents.updateOne(
        { _id: existing._id, managedBy: MANAGED_BY },
        {
          $set: { ...payload, author: owner._id, updatedAt: now },
          $push: { versions: versionSnapshot(payload, now) },
          $inc: { __v: 1 },
        },
      );
      assert(updateResult.modifiedCount === 1, `Failed to update ${compiledAgent.id}`);
      updated += 1;
    }
  } else {
    const inserted = db.agents.insertOne({
      ...payload,
      author: owner._id,
      versions: [versionSnapshot(payload, now)],
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });
    assert(inserted.acknowledged, `Failed to insert ${compiledAgent.id}`);
    created += 1;
  }

  const agent = db.agents.findOne({ id: compiledAgent.id, ...globalScope });
  assert(agent, `Missing ${compiledAgent.id} after upsert`);
  const aclEntries = db.aclentries
    .find({ resourceType: 'agent', resourceId: agent._id, ...globalScope })
    .toArray();
  const ownerEntries = aclEntries.filter(
    (entry) => entry.principalType === 'user' && String(entry.principalId) === String(owner._id),
  );
  const publicEntries = aclEntries.filter((entry) => entry.principalType === 'public');
  const otherEntries = aclEntries.filter(
    (entry) => !ownerEntries.includes(entry) && !publicEntries.includes(entry),
  );
  assert(ownerEntries.length <= 1, `${compiledAgent.id} has duplicate owner ACL entries`);
  assert(publicEntries.length <= 1, `${compiledAgent.id} has duplicate PUBLIC ACL entries`);
  assert(otherEntries.length === 0, `${compiledAgent.id} has unexpected ACL entries`);

  const ownerAcl = db.aclentries.updateOne(
    {
      resourceType: 'agent',
      resourceId: agent._id,
      principalType: 'user',
      principalId: owner._id,
      ...globalScope,
    },
    {
      $set: {
        principalModel: 'User',
        permBits: ownerRole.permBits,
        roleId: ownerRole._id,
        grantedBy: owner._id,
        grantedAt: now,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now, __v: 0 },
    },
    { upsert: true },
  );
  ownerAclUpserts += ownerAcl.upsertedCount;

  const publicAcl = db.aclentries.updateOne(
    {
      resourceType: 'agent',
      resourceId: agent._id,
      principalType: 'public',
      ...globalScope,
    },
    {
      $unset: { principalId: '', principalModel: '' },
      $set: {
        permBits: viewerRole.permBits,
        roleId: viewerRole._id,
        grantedBy: owner._id,
        grantedAt: now,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now, __v: 0 },
    },
    { upsert: true },
  );
  publicAclUpserts += publicAcl.upsertedCount;
}

const existingWorkflowCategory = db.agentcategories.findOne({
  value: COMPILED.category.value,
  ...globalScope,
});
assert(
  !existingWorkflowCategory || existingWorkflowCategory.custom !== true,
  'automation-workflow conflicts with a custom category',
);
db.agentcategories.updateOne(
  { value: COMPILED.category.value, ...globalScope },
  {
    $set: {
      label: COMPILED.category.label,
      description: COMPILED.category.description,
      order: COMPILED.category.order,
      isActive: true,
      custom: false,
      updatedAt: now,
    },
    $setOnInsert: { createdAt: now, __v: 0 },
  },
  { upsert: true },
);

const categoriesDisabled = db.agentcategories.updateMany(
  {
    value: { $in: COMPILED.defaultCategoriesToDisable },
    custom: { $ne: true },
    ...globalScope,
  },
  { $set: { isActive: false, updatedAt: now } },
).modifiedCount;

const targetIds = COMPILED.agents.map((agent) => agent.id);
const finalAgents = db.agents.find({ id: { $in: targetIds }, ...globalScope }).toArray();
assert(finalAgents.length === COMPILED.agents.length, 'Final Agent count is not 7');
for (const agent of finalAgents) {
  assert(agent.category === COMPILED.category.value, `${agent.id} has the wrong category`);
  assert(agent.is_promoted === true, `${agent.id} is not promoted`);
  assert(
    db.aclentries.countDocuments({
      resourceType: 'agent',
      resourceId: agent._id,
      principalType: 'public',
      permBits: 1,
      ...globalScope,
    }) === 1,
    `${agent.id} PUBLIC ACL is invalid`,
  );
}

print(
  EJSON.stringify({
    status: 'passed',
    catalogDigest: COMPILED.compiledDigest,
    created,
    updated,
    unchanged,
    ownerAclUpserts,
    publicAclUpserts,
    categoriesDisabled,
    finalAgentCount: finalAgents.length,
    activeCategoryCount: db.agentcategories.countDocuments({ isActive: true, ...globalScope }),
  }),
);

if (typeof COMPILED === 'undefined') {
  throw new Error('COMPILED catalog is required');
}

const crypto = require('crypto');
const MANAGED_BY = 'librechat-preset-workflow-agents';
const LEGACY_CONTACT = { name: 'LibreChat Workflow Agent', email: '' };
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
  return { ...payload, createdAt: now, updatedAt: now };
}

const targetIds = COMPILED.agents.map((agent) => agent.id);
assert(targetIds.length === 7, 'Expected exactly seven compiled Agents');
assert(new Set(targetIds).size === 7, 'Compiled Agent IDs must be unique');

const existingAgents = db.agents
  .find({ id: { $in: targetIds }, ...globalScope })
  .sort({ id: 1 })
  .toArray();
assert(existingAgents.length === 7, 'All seven preset Agents must exist');

const existingById = new Map(existingAgents.map((agent) => [agent.id, agent]));
const now = new Date();
let updated = 0;
let unchanged = 0;

for (const compiledAgent of COMPILED.agents) {
  const existing = existingById.get(compiledAgent.id);
  assert(existing, `Missing ${compiledAgent.id}`);
  assert(existing.managedBy === MANAGED_BY, `${compiledAgent.id} is not managed by this release`);
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

  const payload = persistedPayload(compiledAgent);
  const expectedDigest = payload.workflowTemplate.persistedDigest;
  if (storedDigest === expectedDigest) {
    assert(existing.support_contact === undefined, `${compiledAgent.id} has a contact with the new digest`);
    unchanged += 1;
    continue;
  }

  const contact = existing.support_contact;
  assert(
    contact &&
      contact.name === LEGACY_CONTACT.name &&
      contact.email === LEGACY_CONTACT.email &&
      Object.keys(contact).every((key) => ['name', 'email'].includes(key)),
    `${compiledAgent.id} does not have the exact legacy contact`,
  );
  const normalized = comparableExisting(existing);
  delete normalized.support_contact;
  normalized.workflowTemplate.sourceAgentDigest = compiledAgent.agentDigest;
  assert(
    digest(normalized) === expectedDigest,
    `${compiledAgent.id} differs from the new catalog beyond the contact field`,
  );

  const result = db.agents.updateOne(
    {
      _id: existing._id,
      id: compiledAgent.id,
      managedBy: MANAGED_BY,
      'workflowTemplate.persistedDigest': storedDigest,
      'support_contact.name': LEGACY_CONTACT.name,
      'support_contact.email': LEGACY_CONTACT.email,
      ...globalScope,
    },
    {
      $set: {
        workflowTemplate: payload.workflowTemplate,
        updatedAt: now,
      },
      $unset: { support_contact: '' },
      $push: { versions: versionSnapshot(payload, now) },
      $inc: { __v: 1 },
    },
  );
  assert(result.matchedCount === 1 && result.modifiedCount === 1, `Failed to update ${compiledAgent.id}`);
  updated += 1;
}

const finalAgents = db.agents.find({ id: { $in: targetIds }, ...globalScope }).toArray();
assert(finalAgents.length === 7, 'Final Agent count is not seven');
for (const agent of finalAgents) {
  const compiledAgent = COMPILED.agents.find((entry) => entry.id === agent.id);
  assert(compiledAgent, `Unexpected final Agent ${agent.id}`);
  assert(agent.support_contact === undefined, `${agent.id} still has support_contact`);
  assert(
    agent.workflowTemplate?.sourceAgentDigest === compiledAgent.agentDigest,
    `${agent.id} has the wrong source Agent digest`,
  );
  assert(
    agent.workflowTemplate?.persistedDigest === digest(comparableExisting(agent)),
    `${agent.id} has an invalid persisted digest after update`,
  );
}

print(
  EJSON.stringify({
    status: 'passed',
    catalogDigest: COMPILED.compiledDigest,
    updated,
    unchanged,
    finalAgentCount: finalAgents.length,
    writes: ['agents'],
  }),
);

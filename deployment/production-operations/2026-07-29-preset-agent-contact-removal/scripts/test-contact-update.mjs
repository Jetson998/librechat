#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '../../../..');
const compiled = JSON.parse(
  await readFile(resolve(root, 'workflow-templates/preset-agents/compiled-agents.json'), 'utf8'),
);
const updateSource = await readFile(resolve(scriptDir, 'remove-support-contact.js'), 'utf8');
const rollbackSource = await readFile(resolve(scriptDir, 'rollback-agents.js'), 'utf8');
const require = createRequire(import.meta.url);
const legacyContact = { name: 'LibreChat Workflow Agent', email: '' };

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
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

function persistedPayload(agent) {
  const workflowTemplate = {
    templateId: agent.templateId,
    templateVersion: agent.templateVersion,
    engine: agent.engine,
    manifestDigest: agent.manifestDigest,
    sourceAgentDigest: agent.agentDigest,
    domain: agent.domain,
    priority: agent.priority,
    limits: agent.limits,
    inputContract: agent.inputContract,
    outputContract: agent.outputContract,
    acceptanceFixtures: agent.acceptanceFixtures,
  };
  const payload = {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    provider: agent.provider,
    model: agent.model,
    model_parameters: agent.model_parameters || {},
    recursion_limit: agent.recursion_limit,
    tools: agent.tools,
    skills_enabled: agent.skills_enabled,
    category: agent.category,
    is_promoted: agent.is_promoted,
    hide_sequential_outputs: agent.hide_sequential_outputs,
    end_after_tools: agent.end_after_tools,
    conversation_starters: agent.conversation_starters,
    support_contact: legacyContact,
    authorName: 'LibreChat',
    edges: [],
    tool_resources: {},
    mcpServerNames: [],
    managedBy: 'librechat-preset-workflow-agents',
    workflowTemplate,
  };
  workflowTemplate.persistedDigest = digest(payload);
  return payload;
}

function legacyAgent(agent) {
  const source = { ...agent };
  delete source.agentDigest;
  source.support_contact = legacyContact;
  source.agentDigest = digest(source);
  return source;
}

const documents = compiled.agents.map((agent, index) => {
  const payload = persistedPayload(legacyAgent(agent));
  return {
    _id: `agent-${index}`,
    ...payload,
    author: 'admin-id',
    versions: [{ ...payload }],
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    __v: 0,
  };
});
const backupDocuments = clone(documents);

function getPath(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function matches(document, query) {
  for (const [key, expected] of Object.entries(query)) {
    if (key === '$or') continue;
    const actual = getPath(document, key);
    if (expected && typeof expected === 'object' && '$in' in expected) {
      if (!expected.$in.includes(actual)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function setPath(object, path, value) {
  const keys = path.split('.');
  let target = object;
  for (const key of keys.slice(0, -1)) {
    target[key] ??= {};
    target = target[key];
  }
  target[keys.at(-1)] = clone(value);
}

const collection = {
  find(query) {
    const found = documents.filter((document) => matches(document, query));
    return {
      sort() {
        return {
          toArray() {
            return found.sort((left, right) => left.id.localeCompare(right.id));
          },
        };
      },
      toArray() {
        return found;
      },
    };
  },
  updateOne(query, update) {
    const document = documents.find((entry) => matches(entry, query));
    if (!document) return { matchedCount: 0, modifiedCount: 0 };
    for (const [path, value] of Object.entries(update.$set || {})) setPath(document, path, value);
    for (const path of Object.keys(update.$unset || {})) delete document[path];
    for (const [path, value] of Object.entries(update.$push || {})) document[path].push(clone(value));
    for (const [path, value] of Object.entries(update.$inc || {})) document[path] += value;
    return { matchedCount: 1, modifiedCount: 1 };
  },
  replaceOne(query, replacement) {
    const index = documents.findIndex((entry) => matches(entry, query));
    if (index < 0) return { matchedCount: 0, modifiedCount: 0 };
    const modifiedCount = JSON.stringify(documents[index]) === JSON.stringify(replacement) ? 0 : 1;
    documents[index] = clone(replacement);
    return { matchedCount: 1, modifiedCount };
  },
};

const outputs = [];
const context = {
  COMPILED: compiled,
  EJSON: { stringify: JSON.stringify },
  db: { agents: collection },
  print(value) {
    outputs.push(JSON.parse(value));
  },
  require,
};

const wrappedUpdateSource = `(() => {\n${updateSource}\n})()`;

vm.runInNewContext(wrappedUpdateSource, context, { filename: 'remove-support-contact.js' });
const first = outputs.at(-1);
if (first.updated !== 7 || first.unchanged !== 0) {
  throw new Error(`unexpected first run result: ${JSON.stringify(first)}`);
}
for (const document of documents) {
  if ('support_contact' in document) throw new Error(`${document.id} still has support_contact`);
  if (document.versions.length !== 2 || document.__v !== 1) {
    throw new Error(`${document.id} version state is invalid after migration`);
  }
}

vm.runInNewContext(wrappedUpdateSource, context, { filename: 'remove-support-contact.js' });
const second = outputs.at(-1);
if (second.updated !== 0 || second.unchanged !== 7) {
  throw new Error(`unexpected second run result: ${JSON.stringify(second)}`);
}

context.BACKUP = { agents: clone(backupDocuments) };
const wrappedRollbackSource = `(() => {\n${rollbackSource}\n})()`;
vm.runInNewContext(wrappedRollbackSource, context, { filename: 'rollback-agents.js' });
const rollback = outputs.at(-1);
if (rollback.restoredAgents !== 7 || rollback.writes?.[0] !== 'agents') {
  throw new Error(`unexpected rollback result: ${JSON.stringify(rollback)}`);
}
if (JSON.stringify(canonicalize(documents)) !== JSON.stringify(canonicalize(backupDocuments))) {
  throw new Error('rollback did not restore the exact seven Agent documents');
}

console.log('contact removal fixture passed: 7 updated, 7 unchanged, exact rollback');

#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const migrateSource = readFileSync(resolve(root, 'migration/migrate.js'), 'utf8');
const rollbackSource = readFileSync(resolve(root, 'migration/rollback.js'), 'utf8');
const compiled = JSON.parse(
  readFileSync(resolve(root, '../../../workflow-templates/preset-agents/compiled-agents.json'), 'utf8'),
);
const MAPPING = compiled.agents.map((agent) => [agent.legacyId, agent.id]);

function clone(value) {
  return structuredClone(value);
}

function matches(document, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some((branch) => matches(document, branch));
    const actual = document[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$exists' in expected) return (actual !== undefined) === expected.$exists;
      if ('$in' in expected) return expected.$in.some((entry) => String(entry) === String(actual));
      if ('$nin' in expected) return expected.$nin.every((entry) => String(entry) !== String(actual));
    }
    return String(actual) === String(expected);
  });
}

class Cursor {
  constructor(documents) {
    this.documents = documents;
  }

  sort(spec) {
    const keys = Object.keys(spec);
    this.documents.sort((left, right) => {
      for (const key of keys) {
        const leftValue = String(left[key] ?? '');
        const rightValue = String(right[key] ?? '');
        if (leftValue < rightValue) return -1;
        if (leftValue > rightValue) return 1;
      }
      return 0;
    });
    return this;
  }

  toArray() {
    return clone(this.documents);
  }
}

class Collection {
  constructor(documents) {
    this.documents = documents;
  }

  find(query) {
    return new Cursor(this.documents.filter((document) => matches(document, query)));
  }

  findOne(query) {
    const document = this.documents.find((entry) => matches(entry, query));
    return document ? clone(document) : null;
  }

  countDocuments(query) {
    return this.documents.filter((document) => matches(document, query)).length;
  }

  updateOne(query, update) {
    const index = this.documents.findIndex((document) => matches(document, query));
    if (index < 0) return { matchedCount: 0, modifiedCount: 0 };
    this.documents[index] = { ...this.documents[index], ...clone(update.$set ?? {}) };
    return { matchedCount: 1, modifiedCount: 1 };
  }

  replaceOne(query, replacement) {
    const index = this.documents.findIndex((document) => matches(document, query));
    if (index < 0) return { matchedCount: 0, modifiedCount: 0 };
    this.documents[index] = clone(replacement);
    return { matchedCount: 1, modifiedCount: 1 };
  }
}

function fixture() {
  const agents = MAPPING.map(([legacyId], index) => ({
    _id: `resource-${index}`,
    id: legacyId,
    author: 'admin-user',
    provider: 'anthropic',
    model: 'claude-fable-5',
    managedBy: 'librechat-preset-workflow-agents',
    versions: [{ id: legacyId, version: 1, marker: `v-${index}` }],
    marker: `agent-${index}`,
  }));
  const aclentries = agents.flatMap((agent, index) => [
    {
      _id: `acl-owner-${index}`,
      resourceType: 'agent',
      resourceId: agent._id,
      principalType: 'user',
      permBits: 15,
    },
    {
      _id: `acl-public-${index}`,
      resourceType: 'agent',
      resourceId: agent._id,
      principalType: 'public',
      permBits: 1,
    },
  ]).sort((left, right) =>
    `${left.resourceId}:${left.principalType}:${left._id}`.localeCompare(
      `${right.resourceId}:${right.principalType}:${right._id}`,
    ),
  );
  return { agents, aclentries };
}

function execute(source, data, extra = {}) {
  const output = [];
  const context = {
    MAPPING,
    db: {
      agents: new Collection(data.agents),
      aclentries: new Collection(data.aclentries),
    },
    EJSON: { stringify: JSON.stringify },
    print: (value) => output.push(String(value)),
    ...extra,
  };
  vm.runInNewContext(source, context, { timeout: 2000 });
  return output.map((line) => JSON.parse(line)).at(-1);
}

const data = fixture();
const backup = clone(data);
const migrated = execute(migrateSource, data);
assert.equal(migrated.status, 'passed');
assert.equal(migrated.migrated.length, 7);
assert.equal(migrated.aclCount, 14);
for (const [legacyId, nextId] of MAPPING) {
  assert.equal(data.agents.some((agent) => agent.id === legacyId), false);
  const agent = data.agents.find((entry) => entry.id === nextId);
  assert.ok(agent);
  assert.deepEqual(agent.versions.map((version) => version.id), [nextId]);
  assert.equal(agent.author, 'admin-user');
  assert.equal(agent.provider, 'anthropic');
  assert.equal(agent.model, 'claude-fable-5');
}
assert.deepEqual(data.aclentries, backup.aclentries);

const rollbackBackup = { agents: clone(backup.agents), aclEntries: clone(backup.aclentries) };
const rollback = execute(rollbackSource, data, { BACKUP: rollbackBackup });
assert.equal(rollback.status, 'passed');
assert.deepEqual(data, backup);

const conflict = fixture();
conflict.agents.push({ ...clone(conflict.agents[0]), _id: 'conflict', id: MAPPING[0][1] });
assert.throws(() => execute(migrateSource, conflict), /target Agent IDs already exist/);

const badVersion = fixture();
badVersion.agents[0].versions[0].id = 'unexpected-version-id';
assert.throws(() => execute(migrateSource, badVersion), /unexpected ID/);

console.log('preset_agent_runtime_category_migration_tests=passed');

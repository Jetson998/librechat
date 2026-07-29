#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const presetDir = resolve(scriptDir, '..');
const manifestDir = join(presetDir, 'manifests');
const profileDir = join(presetDir, 'instruction-profiles');
const outputPath = join(presetDir, 'compiled-agents.json');

const CATALOG_IDS = [
  'meeting-to-action',
  'knowledge-base-curator',
  'excel-audit-reconciliation',
  'policy-change-impact',
  'feedback-root-cause-analysis',
  'kyc-periodic-review',
  'journal-entry-audit',
];

const DEFAULT_CATEGORIES_TO_DISABLE = [
  'general',
  'hr',
  'rd',
  'finance',
  'it',
  'sales',
  'aftersales',
];

const ALLOWED_TOOLS = new Set(['execute_code', 'file_search', 'web_search']);
const FORBIDDEN_TEXT = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /cookie/i,
  /mongodb/i,
  /process\.env/i,
  /\/srv\//i,
  /\/root\//i,
  /sess_[a-z0-9]/i,
  /find\s+\//i,
];

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function scanText(value, path, errors) {
  if (typeof value === 'string') {
    for (const pattern of FORBIDDEN_TEXT) {
      if (pattern.test(value)) {
        errors.push(`${path} contains forbidden pattern ${pattern}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanText(entry, `${path}[${index}]`, errors));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, entry]) => scanText(entry, `${path}.${key}`, errors));
  }
}

function validateManifest(manifest, profileText) {
  const errors = [];
  const id = manifest?.templateId ?? '<missing>';
  const required = [
    'schemaVersion',
    'templateId',
    'templateVersion',
    'engine',
    'display',
    'priority',
    'domain',
    'category',
    'provider',
    'model',
    'requiredCapabilities',
    'tools',
    'inputContract',
    'outputContract',
    'instructionProfile',
    'instructions',
    'conversationStarters',
    'limits',
    'acceptanceFixtures',
  ];

  for (const field of required) {
    if (manifest?.[field] === undefined) {
      errors.push(`${id}: missing ${field}`);
    }
  }

  if (manifest?.schemaVersion !== '1.0') errors.push(`${id}: schemaVersion must be 1.0`);
  if (manifest?.templateVersion !== '1.0.0') errors.push(`${id}: templateVersion must be 1.0.0`);
  if (manifest?.engine !== 'librechat-native-agent-v1') {
    errors.push(`${id}: unsupported engine`);
  }
  if (manifest?.category !== 'automation-workflow') {
    errors.push(`${id}: category must be automation-workflow`);
  }
  if (manifest?.provider !== 'anthropic' || manifest?.model !== 'claude-fable-5') {
    errors.push(`${id}: provider/model must be anthropic/claude-fable-5`);
  }
  if (!['P0', 'P1'].includes(manifest?.priority)) errors.push(`${id}: invalid priority`);
  if (!['general', 'financial'].includes(manifest?.domain)) errors.push(`${id}: invalid domain`);
  if (!Array.isArray(manifest?.tools) || manifest.tools.length === 0) {
    errors.push(`${id}: tools must be non-empty`);
  }
  if (!Array.isArray(manifest?.requiredCapabilities) || manifest.requiredCapabilities.length === 0) {
    errors.push(`${id}: requiredCapabilities must be non-empty`);
  }
  const tools = new Set(manifest?.tools ?? []);
  for (const tool of tools) {
    if (!ALLOWED_TOOLS.has(tool)) errors.push(`${id}: tool ${tool} is not allowlisted`);
  }
  for (const capability of manifest?.requiredCapabilities ?? []) {
    if (!tools.has(capability)) {
      errors.push(`${id}: required capability ${capability} is not in tools`);
    }
  }
  if (!manifest?.display?.name || !manifest?.display?.description) {
    errors.push(`${id}: display name and description are required`);
  }
  if (!Array.isArray(manifest?.conversationStarters) || manifest.conversationStarters.length < 3) {
    errors.push(`${id}: at least three conversation starters are required`);
  }
  if (!Array.isArray(manifest?.acceptanceFixtures) || manifest.acceptanceFixtures.length < 1) {
    errors.push(`${id}: at least one acceptance fixture is required`);
  }
  if (!manifest?.limits || manifest.limits.maxInputFiles < 1 || manifest.limits.maxVisibleArtifacts < 1) {
    errors.push(`${id}: invalid limits`);
  }

  scanText(manifest, id, errors);
  scanText(profileText, `${id}.instructionProfile`, errors);
  return errors;
}

function buildInstructions(manifest, profileText) {
  return [
    `你是“${manifest.display.name}”，属于 LibreChat 的自动化工作流 Agent。`,
    profileText.trim(),
    `\n【本工作流目标】\n${manifest.instructions.trim()}`,
  ].join('\n\n');
}

function buildAgent(manifest, profileText, manifestDigest) {
  const workflowMetadata = {
    managedBy: 'librechat-preset-workflow-agents',
    templateId: manifest.templateId,
    templateVersion: manifest.templateVersion,
    engine: manifest.engine,
    manifestDigest,
    domain: manifest.domain,
    priority: manifest.priority,
  };

  return {
    id: `workflow_${manifest.templateId}`,
    name: manifest.display.name,
    description: manifest.display.description,
    instructions: buildInstructions(manifest, profileText),
    provider: manifest.provider,
    model: manifest.model,
    model_parameters: {},
    recursion_limit: 50,
    tools: manifest.tools,
    skills_enabled: false,
    category: manifest.category,
    is_promoted: true,
    hide_sequential_outputs: false,
    end_after_tools: false,
    conversation_starters: manifest.conversationStarters,
    support_contact: {
      name: 'LibreChat Workflow Agent',
      email: '',
    },
    limits: manifest.limits,
    inputContract: manifest.inputContract,
    outputContract: manifest.outputContract,
    acceptanceFixtures: manifest.acceptanceFixtures,
    ...workflowMetadata,
  };
}

async function readManifests() {
  const names = (await readdir(manifestDir)).filter((name) => name.endsWith('.json')).sort();
  const manifests = [];
  for (const name of names) {
    manifests.push(JSON.parse(await readFile(join(manifestDir, name), 'utf8')));
  }
  return manifests;
}

async function compile() {
  const profileText = await readFile(join(profileDir, 'office-safe-v1.txt'), 'utf8');
  const manifests = await readManifests();
  const errors = [];
  const seenIds = new Set();
  const agents = [];
  const sourceManifests = [];

  for (const manifest of manifests) {
    errors.push(...validateManifest(manifest, profileText));
    if (seenIds.has(manifest.templateId)) errors.push(`duplicate templateId ${manifest.templateId}`);
    seenIds.add(manifest.templateId);
    const manifestDigest = sha256(canonicalJson(manifest));
    sourceManifests.push({
      templateId: manifest.templateId,
      templateVersion: manifest.templateVersion,
      manifestDigest,
    });
    const agent = buildAgent(manifest, profileText, manifestDigest);
    agents.push({
      ...agent,
      agentDigest: sha256(canonicalJson(agent)),
    });
  }

  const actualIds = [...seenIds].sort();
  if (JSON.stringify(actualIds) !== JSON.stringify([...CATALOG_IDS].sort())) {
    errors.push(`catalog mismatch: expected ${CATALOG_IDS.join(', ')}, got ${actualIds.join(', ')}`);
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  agents.sort((left, right) => left.id.localeCompare(right.id));
  sourceManifests.sort((left, right) => left.templateId.localeCompare(right.templateId));
  const payload = {
    schemaVersion: '1.0',
    releaseContract: 'preset-workflow-agents-v1',
    category: {
      value: 'automation-workflow',
      label: '自动化工作流',
      description: '使用文件、代码、检索和 Office 能力完成可交付任务',
      order: 0,
    },
    defaultCategoriesToDisable: DEFAULT_CATEGORIES_TO_DISABLE,
    sourceManifests,
    agents,
  };
  return {
    ...payload,
    compiledDigest: sha256(canonicalJson(payload)),
  };
}

const compiled = await compile();
const rendered = `${JSON.stringify(compiled, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const existing = await readFile(outputPath, 'utf8');
  assert(existing === rendered, `${outputPath} is stale; run compile.mjs`);
  console.log(`preset workflow agents: ${compiled.agents.length} manifests, digest ${compiled.compiledDigest}`);
} else {
  await writeFile(outputPath, rendered, 'utf8');
  console.log(`wrote ${outputPath}`);
  console.log(`preset workflow agents: ${compiled.agents.length} manifests, digest ${compiled.compiledDigest}`);
}

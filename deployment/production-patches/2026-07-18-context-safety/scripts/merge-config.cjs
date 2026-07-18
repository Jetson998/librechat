#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');

let yaml = null;
try {
  yaml = require('js-yaml');
} catch (error) {
  if (process.env.SKIP_YAML_VALIDATION !== '1') {
    throw error;
  }
}

const [inputPath, outputPath, contractPath] = process.argv.slice(2);
if (!inputPath || !outputPath || !contractPath) {
  throw new Error('usage: merge-config.cjs <input-yaml> <output-yaml> <contract-file>');
}

const source = fs.readFileSync(inputPath, 'utf8');
const contract = fs.readFileSync(contractPath, 'utf8').trim();
const newline = source.includes('\r\n') ? '\r\n' : '\n';
const hadFinalNewline = source.endsWith('\n');
const markerStart = '[CONTEXT_SAFETY_BATCH_V1]';
const markerEnd = '[/CONTEXT_SAFETY_BATCH_V1]';
const targetModels = ['gpt-5.6-sol', 'claude-fable-5'];

if (!contract.startsWith(markerStart) || !contract.endsWith(markerEnd)) {
  throw new Error('batch contract markers are invalid');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeContract(value) {
  const pattern = new RegExp(
    `\\n?${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}\\n?`,
    'g',
  );
  return String(value || '').replace(pattern, '\n').trimEnd();
}

function appendContract(value) {
  const base = removeContract(value);
  return `${base}${base ? '\n\n' : ''}${contract}\n`;
}

function topLevelBlockBounds(lines, key) {
  const startPattern = new RegExp(`^${key}:\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => startPattern.test(line));
  if (start === -1) return null;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[^\s#][^:]*:\s*/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function nestedBlockEnd(lines, start, parentEnd, indent) {
  let end = parentEnd;
  for (let index = start + 1; index < parentEnd; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (line.match(/^\s*/)[0].length <= indent) {
      end = index;
      break;
    }
  }
  return end;
}

function assertSemanticContract(before, after) {
  const expected = clone(before);
  expected.endpoints ??= {};
  expected.endpoints.agents ??= {};
  expected.endpoints.agents.maxToolResultChars = 32000;
  expected.endpoints.agents.recursionLimit = 50;
  expected.endpoints.agents.maxRecursionLimit = 50;

  const specs = expected?.modelSpecs?.list;
  if (!Array.isArray(specs)) {
    throw new Error('modelSpecs.list is missing');
  }
  for (const modelName of targetModels) {
    const matches = specs.filter((spec) => spec?.name === modelName);
    if (matches.length !== 1) {
      throw new Error(`expected one ${modelName} model spec, found ${matches.length}`);
    }
    const prompt = matches[0]?.preset?.promptPrefix;
    if (typeof prompt !== 'string') {
      throw new Error(`${modelName} preset.promptPrefix must be a string`);
    }
    matches[0].preset.promptPrefix = appendContract(prompt);
  }

  if (!isDeepStrictEqual(after, expected)) {
    throw new Error('merged YAML changed fields outside the approved contract');
  }
}

let lines = source.split(/\r?\n/);
if (hadFinalNewline && lines[lines.length - 1] === '') {
  lines.pop();
}

const endpointsBounds = topLevelBlockBounds(lines, 'endpoints');
if (!endpointsBounds) {
  throw new Error('top-level endpoints section is missing');
}

const agentsMatches = [];
for (let index = endpointsBounds.start + 1; index < endpointsBounds.end; index += 1) {
  const match = lines[index].match(/^(\s*)agents:\s*(?:#.*)?$/);
  if (match) agentsMatches.push({ index, indent: match[1].length });
}
if (agentsMatches.length !== 1) {
  throw new Error(`expected one endpoints.agents block, found ${agentsMatches.length}`);
}

const agents = agentsMatches[0];
let agentsEnd = nestedBlockEnd(lines, agents.index, endpointsBounds.end, agents.indent);
const propertyIndent = ' '.repeat(agents.indent + 2);
const approvedAgentFields = [
  ['maxToolResultChars', '32000'],
  ['recursionLimit', '50'],
  ['maxRecursionLimit', '50'],
];
const missingAgentFields = [];

for (const [key, value] of approvedAgentFields) {
  const matches = [];
  for (let index = agents.index + 1; index < agentsEnd; index += 1) {
    if (lines[index].startsWith(`${propertyIndent}${key}:`)) matches.push(index);
  }
  if (matches.length > 1) {
    throw new Error(`endpoints.agents.${key} occurs more than once`);
  }
  if (matches.length === 1) {
    lines[matches[0]] = `${propertyIndent}${key}: ${value}`;
  } else {
    missingAgentFields.push(`${propertyIndent}${key}: ${value}`);
  }
}

if (missingAgentFields.length > 0) {
  lines.splice(agents.index + 1, 0, ...missingAgentFields);
}

function appendContractToModel(modelName) {
  const modelBounds = topLevelBlockBounds(lines, 'modelSpecs');
  if (!modelBounds) throw new Error('top-level modelSpecs section is missing');

  const escapedName = escapeRegExp(modelName);
  const modelPattern = new RegExp(`^(\\s*)-\\s+name:\\s*["']?${escapedName}["']?\\s*$`);
  const matches = [];
  for (let index = modelBounds.start + 1; index < modelBounds.end; index += 1) {
    const match = lines[index].match(modelPattern);
    if (match) matches.push({ index, indent: match[1].length });
  }
  if (matches.length !== 1) {
    throw new Error(`expected one ${modelName} YAML item, found ${matches.length}`);
  }

  const model = matches[0];
  const modelEnd = nestedBlockEnd(lines, model.index, modelBounds.end, model.indent);
  const modelPropertyIndent = ' '.repeat(model.indent + 2);
  const presetMatches = [];
  for (let index = model.index + 1; index < modelEnd; index += 1) {
    if (lines[index].startsWith(`${modelPropertyIndent}preset:`)) presetMatches.push(index);
  }
  if (presetMatches.length !== 1) {
    throw new Error(`${modelName} must contain exactly one preset block`);
  }

  const presetIndex = presetMatches[0];
  const presetEnd = nestedBlockEnd(lines, presetIndex, modelEnd, model.indent + 2);
  const promptIndent = ' '.repeat(model.indent + 4);
  const promptMatches = [];
  for (let index = presetIndex + 1; index < presetEnd; index += 1) {
    if (new RegExp(`^${promptIndent}promptPrefix:\\s*\\|[-+]?\\s*$`).test(lines[index])) {
      promptMatches.push(index);
    }
  }
  if (promptMatches.length !== 1) {
    throw new Error(`${modelName} must contain one literal promptPrefix block`);
  }

  const promptIndex = promptMatches[0];
  let promptEnd = nestedBlockEnd(lines, promptIndex, presetEnd, model.indent + 4);
  const markerStarts = [];
  const markerEnds = [];
  for (let index = promptIndex + 1; index < promptEnd; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === markerStart) markerStarts.push(index);
    if (trimmed === markerEnd) markerEnds.push(index);
  }
  if (markerStarts.length !== markerEnds.length || markerStarts.length > 1) {
    throw new Error(`${modelName} contains malformed batch-contract markers`);
  }
  if (markerStarts.length === 1) {
    let removeStart = markerStarts[0];
    if (removeStart > promptIndex + 1 && lines[removeStart - 1].trim() === '') {
      removeStart -= 1;
    }
    lines.splice(removeStart, markerEnds[0] - removeStart + 1);
    promptEnd -= markerEnds[0] - removeStart + 1;
  }

  const contentIndent = ' '.repeat(model.indent + 6);
  const additions = [];
  if (promptEnd > promptIndex + 1 && lines[promptEnd - 1].trim() !== '') {
    additions.push(contentIndent);
  }
  additions.push(...contract.split('\n').map((line) => `${contentIndent}${line}`));
  lines.splice(promptEnd, 0, ...additions);
}

for (const modelName of targetModels) {
  appendContractToModel(modelName);
}

let output = lines.join(newline);
if (hadFinalNewline) output += newline;

if (yaml) {
  const before = yaml.load(source);
  const after = yaml.load(output);
  assertSemanticContract(before, after);
}

fs.writeFileSync(outputPath, output, 'utf8');

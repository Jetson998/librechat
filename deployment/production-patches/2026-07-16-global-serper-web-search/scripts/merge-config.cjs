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

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('usage: merge-config.cjs <input-yaml> <output-yaml>');
}

const source = fs.readFileSync(inputPath, 'utf8');
const newline = source.includes('\r\n') ? '\r\n' : '\n';
const hadFinalNewline = source.endsWith('\n');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertSemanticContract(before, after) {
  const expected = clone(before);
  expected.webSearch = {
    searchProvider: 'serper',
    scraperProvider: 'serper',
    serperApiKey: '${SERPER_API_KEY}',
  };

  const capabilities = expected?.endpoints?.agents?.capabilities;
  if (!Array.isArray(capabilities)) {
    throw new Error('endpoints.agents.capabilities is missing');
  }
  const capabilityMatches = capabilities.filter((item) => item === 'web_search').length;
  if (capabilityMatches > 1) {
    throw new Error('endpoints.agents.capabilities contains duplicate web_search entries');
  }
  if (capabilityMatches === 0) {
    capabilities.push('web_search');
  }

  const specs = expected?.modelSpecs?.list;
  if (!Array.isArray(specs)) {
    throw new Error('modelSpecs.list is missing');
  }
  const matches = specs.filter((spec) => spec?.name === 'gpt-5.6-sol');
  if (matches.length !== 1) {
    throw new Error(`expected one gpt-5.6-sol model spec, found ${matches.length}`);
  }
  matches[0].webSearch = true;

  if (!isDeepStrictEqual(after, expected)) {
    throw new Error('merged YAML changed fields outside the approved contract');
  }
}

function topLevelBlockBounds(lines, key) {
  const startPattern = new RegExp(`^${key}:\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => startPattern.test(line));
  if (start === -1) return null;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[^\s#][^:]*:\s*/.test(line)) {
      end = index;
      break;
    }
  }
  return { start, end };
}

const before = yaml ? yaml.load(source) : null;
let lines = source.split(/\r?\n/);
if (hadFinalNewline && lines[lines.length - 1] === '') {
  lines.pop();
}

const webSearchLines = [
  'webSearch:',
  '  searchProvider: serper',
  '  scraperProvider: serper',
  "  serperApiKey: '${SERPER_API_KEY}'",
  '',
];

const existingWebSearch = topLevelBlockBounds(lines, 'webSearch');
if (existingWebSearch) {
  let end = existingWebSearch.end;
  while (end < lines.length && lines[end] === '') end += 1;
  lines.splice(existingWebSearch.start, end - existingWebSearch.start, ...webSearchLines);
} else {
  const modelSpecsIndex = lines.findIndex((line) => /^modelSpecs:\s*(?:#.*)?$/.test(line));
  if (modelSpecsIndex === -1) {
    throw new Error('top-level modelSpecs section is missing');
  }
  lines.splice(modelSpecsIndex, 0, ...webSearchLines);
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
let agentsEnd = endpointsBounds.end;
for (let index = agents.index + 1; index < endpointsBounds.end; index += 1) {
  const line = lines[index];
  if (!line.trim()) continue;
  const indent = line.match(/^\s*/)[0].length;
  if (indent <= agents.indent) {
    agentsEnd = index;
    break;
  }
}

const agentsPropertyIndent = ' '.repeat(agents.indent + 2);
const capabilitiesMatches = [];
for (let index = agents.index + 1; index < agentsEnd; index += 1) {
  if (lines[index].startsWith(`${agentsPropertyIndent}capabilities:`)) {
    capabilitiesMatches.push(index);
  }
}
if (capabilitiesMatches.length !== 1) {
  throw new Error(
    `expected one endpoints.agents.capabilities property, found ${capabilitiesMatches.length}`,
  );
}

const capabilitiesIndex = capabilitiesMatches[0];
const capabilityItemIndent = `${agentsPropertyIndent}  `;
let capabilitiesEnd = agentsEnd;
for (let index = capabilitiesIndex + 1; index < agentsEnd; index += 1) {
  const line = lines[index];
  if (!line.trim()) continue;
  const indent = line.match(/^\s*/)[0].length;
  if (indent <= agents.indent + 2) {
    capabilitiesEnd = index;
    break;
  }
}

const webSearchCapabilityLines = [];
for (let index = capabilitiesIndex + 1; index < capabilitiesEnd; index += 1) {
  if (/^\s*-\s*["']?web_search["']?\s*(?:#.*)?$/.test(lines[index])) {
    webSearchCapabilityLines.push(index);
  }
}
if (webSearchCapabilityLines.length > 1) {
  throw new Error('endpoints.agents.capabilities contains duplicate web_search entries');
}
if (webSearchCapabilityLines.length === 0) {
  lines.splice(capabilitiesEnd, 0, `${capabilityItemIndent}- web_search`);
}

const modelBounds = topLevelBlockBounds(lines, 'modelSpecs');
if (!modelBounds) {
  throw new Error('top-level modelSpecs section is missing after merge');
}

const modelNamePattern = /^(\s*)-\s+name:\s*["']?gpt-5\.6-sol["']?\s*$/;
const modelMatches = [];
for (let index = modelBounds.start + 1; index < modelBounds.end; index += 1) {
  const match = lines[index].match(modelNamePattern);
  if (match) modelMatches.push({ index, indent: match[1].length });
}
if (modelMatches.length !== 1) {
  throw new Error(`expected one gpt-5.6-sol YAML item, found ${modelMatches.length}`);
}

const model = modelMatches[0];
let modelEnd = modelBounds.end;
for (let index = model.index + 1; index < modelBounds.end; index += 1) {
  const line = lines[index];
  if (!line.trim()) continue;
  const indent = line.match(/^\s*/)[0].length;
  if (indent <= model.indent) {
    modelEnd = index;
    break;
  }
}

const propertyIndent = ' '.repeat(model.indent + 2);
let webSearchProperty = -1;
let presetProperty = -1;
for (let index = model.index + 1; index < modelEnd; index += 1) {
  if (lines[index].startsWith(`${propertyIndent}webSearch:`)) webSearchProperty = index;
  if (lines[index].startsWith(`${propertyIndent}preset:`)) presetProperty = index;
}

if (webSearchProperty !== -1) {
  lines[webSearchProperty] = `${propertyIndent}webSearch: true`;
} else {
  if (presetProperty === -1) {
    throw new Error('gpt-5.6-sol preset property is missing');
  }
  lines.splice(presetProperty, 0, `${propertyIndent}webSearch: true`);
}

let output = lines.join(newline);
if (hadFinalNewline) output += newline;

if (yaml) {
  const after = yaml.load(output);
  assertSemanticContract(before, after);
}

fs.writeFileSync(outputPath, output, 'utf8');

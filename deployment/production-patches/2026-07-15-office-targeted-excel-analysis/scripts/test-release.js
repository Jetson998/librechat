const fs = require('node:fs');
const path = require('node:path');

const releaseRoot = path.resolve(__dirname, '..');
const skillPath = path.join(
  releaseRoot,
  'skill',
  'office-document-parser',
  'SKILL.md',
);
const deployPath = path.join(releaseRoot, 'scripts', 'deploy.sh');
const remoteRunnerPath = path.join(releaseRoot, 'scripts', 'run-remote-release.sh');
const remoteTransportPath = path.join(releaseRoot, 'scripts', 'deploy-remote.exp');
const skill = fs.readFileSync(skillPath, 'utf8');
const deploy = fs.readFileSync(deployPath, 'utf8');
const remoteRunner = fs.readFileSync(remoteRunnerPath, 'utf8');
const remoteTransport = fs.readFileSync(remoteTransportPath, 'utf8');

const required = [
  'name: office-document-parser',
  'allowed-tools:',
  '  - execute_code',
  'use `openpyxl`',
  'sheet names, row numbers, cell references',
  'Do not convert an',
  'file named `full_dump`',
  'structure-first pass',
  'Do not print every cell',
  'Reopen the original workbook',
  'Intermediate analysis',
  'A complete export remains opt-in',
  'Only create a file under `/mnt/data`',
];

for (const marker of required) {
  if (!skill.includes(marker)) {
    throw new Error(`Missing required skill marker: ${marker}`);
  }
}

const forbidden = [
  /^always-apply:/m,
  /office_to_markdown\.py/,
  /https?:\/\/152\.32\.172\.162/,
  /Gap_Analysis/i,
  /Remediation_Traceability/i,
  /clipboard_\d+/i,
];

for (const pattern of forbidden) {
  if (pattern.test(skill)) {
    throw new Error(`Forbidden skill content matched: ${pattern}`);
  }
}

const lineCount = skill.split('\n').length;
if (lineCount > 130) {
  throw new Error(`SKILL.md is too long: ${lineCount} lines`);
}

const deployMarkers = [
  '/opt/librechat/skill/office-document-parser/SKILL.md',
  'expected_current_sha=',
  'PREFLIGHT_ONLY',
  'office-targeted-excel-analysis-',
  'container_sha=',
  'api_restarted=false',
  'api_started_before=',
  'status=deployed',
];

for (const marker of deployMarkers) {
  if (!deploy.includes(marker)) {
    throw new Error(`Missing deploy marker: ${marker}`);
  }
}

const unsafeDeployPatterns = [
  /docker compose down/,
  /docker system prune/,
  /docker restart/,
  /docker compose (?:up|restart)/,
  /LibreChat-CodeAPI/,
  /MongoDB/,
  /office-context-patch/,
];

for (const pattern of unsafeDeployPatterns) {
  if (pattern.test(deploy)) {
    throw new Error(`Unexpected deploy scope matched: ${pattern}`);
  }
}

if (!remoteRunner.includes('release_dir="$(cd')) {
  throw new Error('Remote runner does not resolve its staged release directory');
}
if (/git clone|github\.com/i.test(remoteRunner)) {
  throw new Error('Remote runner must not require GitHub access');
}

for (const marker of [
  'SSH_PASS',
  'RELEASE_COMMIT',
  'rev-parse HEAD',
  'scp -r',
  'run-remote-release.sh',
]) {
  if (!remoteTransport.includes(marker)) {
    throw new Error(`Missing remote transport marker: ${marker}`);
  }
}

console.log(`office targeted analysis skill passed (${lineCount} lines)`);

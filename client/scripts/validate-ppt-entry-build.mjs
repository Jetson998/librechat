import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(clientDir, 'dist-ppt-entry');
const expectedLoginOrigin = 'https://152.32.172.162.sslip.io';
const expectedLoginPath = '/login';
const forbiddenMarkers = [
  '/api/auth/login',
  'PptLoginDialog',
  'AuthContext',
  'TwoFactorScreen',
  'login/2fa?tempToken',
];

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  });
}

if (!fs.existsSync(path.join(buildDir, 'index.html'))) {
  throw new Error('PPT entry build is missing index.html');
}

const textFiles = listFiles(buildDir).filter((file) => /\.(?:html|js|css)$/.test(file));
const compiledText = textFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

if (!compiledText.includes(expectedLoginOrigin) || !compiledText.includes(expectedLoginPath)) {
  throw new Error(
    `PPT entry build is missing fixed login target: ${expectedLoginOrigin}${expectedLoginPath}`,
  );
}

if (compiledText.includes('ppt.152.32.172.162.sslip.io')) {
  throw new Error('PPT entry build contains the PPT host as an authentication target');
}

for (const marker of forbiddenMarkers) {
  if (compiledText.includes(marker)) {
    throw new Error(`PPT entry build contains forbidden authentication marker: ${marker}`);
  }
}

console.log(`Validated PPT entry build: ${textFiles.length} text assets, fixed external login only.`);

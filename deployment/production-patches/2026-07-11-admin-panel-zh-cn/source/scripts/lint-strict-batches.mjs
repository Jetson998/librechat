import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const sourceDir = resolve(root, 'src');
const eslintCli = resolve(root, 'node_modules/eslint/bin/eslint.js');
const batchSize = 24;
const maxOldSpaceMb = 512;
const ignoredFiles = new Set(['src/routeTree.gen.ts']);
const extensions = new Set(['.ts', '.tsx']);
const planOnly = process.argv.includes('--plan');

if (process.argv.length > 3 || (process.argv.length === 3 && !planOnly)) {
  throw new Error('Usage: node scripts/lint-strict-batches.mjs [--plan]');
}

function collectLintFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectLintFiles(absolute));
      continue;
    }
    if (!entry.isFile() || !extensions.has(extname(entry.name))) {
      continue;
    }

    const relativePath = relative(root, absolute).split('\\').join('/');
    if (!ignoredFiles.has(relativePath)) {
      files.push(relativePath);
    }
  }

  return files;
}

const files = collectLintFiles(sourceDir).sort();
if (files.length === 0) {
  throw new Error('Strict ESLint coverage resolved to zero files.');
}

const batches = [];
for (let index = 0; index < files.length; index += batchSize) {
  batches.push(files.slice(index, index + batchSize));
}

console.log(
  `Strict ESLint plan: ${files.length} files in ${batches.length} sequential batches ` +
    `(batch size ${batchSize}, Node old-space ${maxOldSpaceMb} MiB).`,
);

if (!planOnly) {
  for (const [index, batch] of batches.entries()) {
    console.log(`Running strict ESLint batch ${index + 1}/${batches.length} (${batch.length} files).`);
    const result = spawnSync(
      process.execPath,
      [
        `--max-old-space-size=${maxOldSpaceMb}`,
        eslintCli,
        '--max-warnings',
        '0',
        ...batch,
      ],
      { cwd: root, stdio: 'inherit' },
    );

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const detail = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
      throw new Error(`Strict ESLint batch ${index + 1}/${batches.length} failed with ${detail}.`);
    }
  }

  console.log(`Verified strict ESLint coverage for all ${files.length} files.`);
}

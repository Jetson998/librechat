import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const expected = (await readFile(resolve(root, 'format-baseline.txt'), 'utf8'))
  .trim()
  .split('\n')
  .sort();
const result = spawnSync(
  resolve(root, 'node_modules/.bin/prettier'),
  ['--list-different', 'src/**/*.{ts,tsx,css,json}'],
  { cwd: root, encoding: 'utf8' },
);
const actual = result.stdout.trim() ? result.stdout.trim().split('\n').sort() : [];

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(
    `Prettier baseline changed. Expected:\n${expected.join('\n')}\n\nActual:\n${actual.join('\n')}\n` +
      `stderr:\n${result.stderr}`,
  );
}

console.log(`Verified the pinned upstream Prettier baseline (${expected.length} files).`);

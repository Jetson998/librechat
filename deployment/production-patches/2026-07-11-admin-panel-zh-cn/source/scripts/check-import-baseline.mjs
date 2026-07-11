import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const expected = (await readFile(resolve(root, 'import-baseline.txt'), 'utf8'))
  .trim()
  .split('\n')
  .sort();
const result = spawnSync('bun', ['run', 'scripts/sort-imports.ts', '--check'], {
  cwd: root,
  encoding: 'utf8',
});
const actual = result.stdout
  .split('\n')
  .filter((line) => line.startsWith('  '))
  .map((line) => line.trim().slice(line.trim().indexOf(' ') + 1))
  .sort();

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(
    `Import-order baseline changed. Expected:\n${expected.join('\n')}\n\nActual:\n${actual.join('\n')}\n` +
      `stderr:\n${result.stderr}`,
  );
}

console.log(`Verified the pinned upstream import-order baseline (${expected.length} files).`);

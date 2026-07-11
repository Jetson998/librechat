const fs = require('fs');
const yaml = require('js-yaml');

const [inputPath, outputPath, mount] = process.argv.slice(2);
if (!inputPath || !outputPath || !mount) {
  throw new Error('usage: merge-compose-upload-menu.cjs INPUT OUTPUT MOUNT');
}

const document = yaml.load(fs.readFileSync(inputPath, 'utf8')) ?? {};
document.services ??= {};
document.services.api ??= {};
document.services.api.volumes ??= [];

if (!Array.isArray(document.services.api.volumes)) {
  throw new Error('services.api.volumes must be a list');
}

const normalized = document.services.api.volumes.map((entry) =>
  typeof entry === 'string' ? entry : JSON.stringify(entry),
);
if (!normalized.includes(mount)) {
  document.services.api.volumes.unshift(mount);
}

fs.writeFileSync(
  outputPath,
  yaml.dump(document, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  }),
  'utf8',
);

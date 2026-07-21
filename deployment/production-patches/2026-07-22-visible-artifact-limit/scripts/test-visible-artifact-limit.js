'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const patchRoot = path.resolve(__dirname, '..');
const visibility = require(path.join(
  patchRoot,
  'office-context-patch',
  'GeneratedArtifactVisibility.js',
));
const mongoConfig = require(path.join(patchRoot, 'scripts', 'mongo-config.js'));

const artifact = (file_id, filename, bytes = 100_000, metadata) => ({
  file_id,
  filename,
  bytes,
  metadata,
});

const mainDeck = artifact(
  'main-deck',
  'paymatrix_aml_ppt/Paymatrix_反洗钱独立审计服务介绍_v1.0.pptx',
  810_384,
);
const incidentArtifacts = [
  mainDeck,
  artifact('pdf', 'paymatrix_aml_ppt/Paymatrix_反洗钱独立审计服务介绍_v1.0.pdf', 700_000),
  artifact('manifest', 'paymatrix_aml_ppt/manifest.json', 8_000),
  artifact('errors', 'paymatrix_aml_ppt/errors.json', 2_000),
  artifact('extract', 'paymatrix_aml_ppt/guideline_extract.json', 248_630),
  artifact('theme', 'paymatrix_aml_ppt/theme_summary.json', 25_759),
  artifact('montage', 'paymatrix_aml_ppt/slide_renders/all-slides-montage.jpg', 521_207),
];

for (let index = 1; index <= 17; index += 1) {
  const number = String(index).padStart(2, '0');
  incidentArtifacts.push(
    artifact(
      `single-${number}`,
      `paymatrix_aml_ppt/slide_renders/pptx/slide-${number}.pptx`,
      770_000,
    ),
    artifact(
      `render-${number}`,
      `paymatrix_aml_ppt/slide_renders/png/slide-${number}.png`,
      120_000,
    ),
  );
}

const incidentSelection = visibility.selectVisibleGeneratedArtifacts(incidentArtifacts, {
  requestText: '请生成并返回一个 17 页 PPTX。',
});
assert.deepStrictEqual(
  incidentSelection.visible.map((file) => file.file_id),
  ['main-deck'],
  'ordinary multi-slide PPT requests must expose only the complete deck',
);
assert(
  incidentSelection.hidden.some(({ reason }) => reason === 'unrequested-format'),
  'unrequested PDF output should stay hidden for a PPT-only request',
);
assert(
  incidentSelection.hidden.some(({ reason }) => reason === 'internal-directory'),
  'single-slide and rendered artifacts should be internal',
);

const defaultSelection = visibility.selectVisibleGeneratedArtifacts([
  artifact('default-pptx', '完整方案.pptx', 500_000),
  artifact('default-pdf', '完整方案.pdf', 450_000),
  artifact('default-md', '完整方案.md', 20_000),
]);
assert.strictEqual(
  defaultSelection.visible.length,
  1,
  'without an explicit multi-file request, one reply should expose one deliverable',
);

const fourDecks = [1, 2, 3, 4].map((index) =>
  artifact(`deck-${index}`, `客户版本_${index}.pptx`, 100_000 + index),
);
const capped = visibility.selectVisibleGeneratedArtifacts(fourDecks, {
  requestText: '生成 4 个独立 PPTX 文件',
});
assert.strictEqual(capped.visible.length, 3, 'visible deliverables must be capped at three');
assert.strictEqual(capped.overflow.length, 1, 'the fourth deliverable must be hidden as overflow');

const multiFormat = visibility.selectVisibleGeneratedArtifacts(
  [
    artifact('docx', '服务说明.docx'),
    artifact('xlsx', '服务清单.xlsx'),
    artifact('preview', '服务说明.png'),
  ],
  { requestText: '请生成 Word 和 Excel 两个文件' },
);
assert.deepStrictEqual(
  new Set(multiFormat.visible.map((file) => file.file_id)),
  new Set(['docx', 'xlsx']),
  'explicit multi-format output should retain the requested formats only',
);

const zipSelection = visibility.selectVisibleGeneratedArtifacts(
  [artifact('zip', '批量结果.zip')],
  { requestText: '打包结果' },
);
assert.strictEqual(zipSelection.visible.length, 0, 'ZIP fallback must not be user-visible');

assert.strictEqual(
  visibility.classifyGeneratedArtifact(
    artifact('role', 'normal-name.pptx', 10_000, { artifactRole: 'intermediate' }),
  ).role,
  'intermediate',
  'persisted intermediate role must be respected',
);

const baseClientSource = fs.readFileSync(
  path.join(patchRoot, 'office-context-patch', 'BaseClient.js'),
  'utf8',
);
assert(
  baseClientSource.includes('selectVisibleGeneratedArtifacts(generatedFiles'),
  'BaseClient must filter generated attachments before saving the assistant message',
);
assert(
  baseClientSource.includes('appendDownloadableMessageFiles(\n        responseMessage.files,\n        visible,'),
  'only visible deliverables should be mirrored to responseMessage.files',
);

const codeProcessSource = fs.readFileSync(
  path.join(patchRoot, 'office-context-patch', 'code-process.js'),
  'utf8',
);
assert(
  codeProcessSource.includes('artifactRole: artifactClassification.role'),
  'persisted CodeAPI files must carry an artifact role',
);

const fixture = {
  overrides: {
    modelSpecs: {
      list: mongoConfig.TARGET_MODELS.map((name) => ({
        name,
        preset: { promptPrefix: `base prompt for ${name}` },
      })),
    },
  },
};
const configured = mongoConfig.applyContractToDocument(fixture);
mongoConfig.assertConfigured(configured);
for (const spec of configured.overrides.modelSpecs.list) {
  assert(spec.preset.promptPrefix.includes('默认只生成 1 个完整的可交付文件'));
  assert(spec.preset.promptPrefix.includes('单次最多 3 个可交付文件'));
  assert(spec.preset.promptPrefix.includes('也不要改为 ZIP'));
  assert(spec.preset.promptPrefix.includes('禁止逐页生成独立 PPTX'));
}

console.log('visible artifact limit tests passed');

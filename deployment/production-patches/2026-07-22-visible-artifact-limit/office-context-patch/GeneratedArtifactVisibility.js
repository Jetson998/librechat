'use strict';

const path = require('path');

const MAX_VISIBLE_GENERATED_FILES = 3;

const INTERNAL_DIRECTORY_NAMES = new Set([
  '.internal',
  'internal',
  'tmp',
  'temp',
  'qa',
  'quality-assurance',
  'quality_assurance',
  'preflight',
  'render',
  'renders',
  'rendered',
  'lo_render',
  'slide_renders',
  'preview',
  'previews',
  'single-page',
  'single_page',
  'single-slide',
  'single_slide',
  'per-page',
  'per_page',
  'per-slide',
  'per_slide',
]);

const INTERNAL_BASENAME_PATTERNS = [
  /^(?:manifest|errors?|preflight|qa|quality[-_ ]?assurance)(?:[._-]|$)/i,
  /(?:^|[._-])(?:manifest|errors?|preflight|qa|quality[-_ ]?assurance)(?:[._-]|$)/i,
  /(?:^|[._-])(?:layout|inspect|extract)(?:[._-]|$).*(?:\.json|\.ndjson)$/i,
  /(?:^|[._-])(?:contact[-_ ]?sheet|montage)(?:[._-]|$)/i,
];

const NUMBERED_PAGE_RE = /(?:^|[._ -])(?:slide|page|source[-_ ]?slide|starter[-_ ]?slide)[-_ ]?\d{1,4}(?:[._ -]|$)/i;
const STRONG_FINAL_RE = /(?:^|[._ -])(?:final|complete|deliverable|release|最终|完整|交付)(?:[._ -]|$)/i;

const EXTENSION_PRIORITY = new Map([
  ['.pptx', 900],
  ['.ppt', 890],
  ['.docx', 880],
  ['.doc', 870],
  ['.xlsx', 860],
  ['.xlsm', 855],
  ['.xls', 850],
  ['.pdf', 840],
  ['.md', 810],
  ['.csv', 800],
  ['.tsv', 795],
  ['.ods', 790],
  ['.odp', 785],
  ['.png', 720],
  ['.jpg', 715],
  ['.jpeg', 715],
  ['.webp', 710],
  ['.svg', 705],
]);

const EXTENSION_FAMILY = new Map([
  ['.pptx', 'presentation'],
  ['.ppt', 'presentation'],
  ['.odp', 'presentation'],
  ['.docx', 'document'],
  ['.doc', 'document'],
  ['.odt', 'document'],
  ['.xlsx', 'spreadsheet'],
  ['.xlsm', 'spreadsheet'],
  ['.xls', 'spreadsheet'],
  ['.ods', 'spreadsheet'],
  ['.csv', 'spreadsheet'],
  ['.tsv', 'spreadsheet'],
  ['.pdf', 'pdf'],
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.png', 'image'],
  ['.jpg', 'image'],
  ['.jpeg', 'image'],
  ['.webp', 'image'],
  ['.svg', 'image'],
]);

const OUTPUT_FAMILY_PATTERNS = [
  ['presentation', /(?:生成|制作|输出|导出|返回|转(?:成|为)|改(?:成|为)?|修改|编辑|美化|重排|create|generate|export|convert)[^\n]{0,40}(?:pptx?|powerpoint|幻灯片|演示文稿|deck)/i],
  ['document', /(?:生成|制作|输出|导出|返回|转(?:成|为)|改(?:成|为)?|修改|编辑|create|generate|export|convert)[^\n]{0,40}(?:docx?|word\b|word文档)/i],
  ['spreadsheet', /(?:生成|制作|输出|导出|返回|转(?:成|为)|改(?:成|为)?|修改|编辑|create|generate|export|convert)[^\n]{0,40}(?:xlsx?|excel|spreadsheet|电子表格)/i],
  ['pdf', /(?:生成|制作|输出|导出|返回|转(?:成|为)|改(?:成|为)?|修改|编辑|create|generate|export|convert)[^\n]{0,40}(?:pdf)/i],
  ['markdown', /(?:生成|制作|输出|导出|返回|转(?:成|为)|改(?:成|为)?|修改|编辑|create|generate|export|convert)[^\n]{0,40}(?:markdown|\.md\b)/i],
  ['image', /(?:生成|制作|输出|导出|返回|create|generate|export)[^\n]{0,40}(?:图片|图像|png|jpe?g|webp|svg)/i],
];
const MULTIPLE_DELIVERABLES_RE = /(?:(?:[2-9]|[1-9]\d+)\s*(?:个|份)(?:独立)?|两个|两个以上|三个|多个|多份|分别|各自|\b(?:[2-9]|[1-9]\d+|two|three|multiple)\s+(?:files?|formats?|versions?)\b)[^\n]{0,40}(?:文件|版本|格式|文档|表格|报告|pptx?|docx?|xlsx?|pdf)?/i;

const getArtifactName = (file) => file?.filename || file?.name || file?.filepath || '';

const normalizeArtifactPath = (value) =>
  String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .toLowerCase();

const detectRequestedOutputFamilies = (requestText) => {
  const text = String(requestText || '');
  const families = new Set();
  for (const [family, pattern] of OUTPUT_FAMILY_PATTERNS) {
    if (pattern.test(text)) {
      families.add(family);
    }
  }
  return families;
};

const requestsMultipleDeliverables = (requestText) =>
  MULTIPLE_DELIVERABLES_RE.test(String(requestText || ''));

const classifyGeneratedArtifact = (file) => {
  const name = getArtifactName(file);
  const normalized = normalizeArtifactPath(name);
  const basename = path.posix.basename(normalized);
  const extension = path.posix.extname(basename);
  const segments = normalized.split('/').filter(Boolean);
  const explicitRole = file?.metadata?.artifactRole;

  if (explicitRole === 'intermediate') {
    return { role: 'intermediate', reason: 'persisted-role', score: 0 };
  }

  if (extension === '.zip') {
    return { role: 'intermediate', reason: 'zip-not-supported', score: 0 };
  }

  if (segments.slice(0, -1).some((segment) => INTERNAL_DIRECTORY_NAMES.has(segment))) {
    return { role: 'intermediate', reason: 'internal-directory', score: 0 };
  }

  if (INTERNAL_BASENAME_PATTERNS.some((pattern) => pattern.test(basename))) {
    return { role: 'intermediate', reason: 'internal-filename', score: 0 };
  }

  if (NUMBERED_PAGE_RE.test(basename)) {
    return { role: 'intermediate', reason: 'numbered-page-artifact', score: 0 };
  }

  const bytes = Number(file?.bytes) || 0;
  const sizeScore = bytes > 0 ? Math.min(99, Math.floor(Math.log10(bytes + 1) * 10)) : 0;
  const finalScore = STRONG_FINAL_RE.test(basename) ? 150 : 0;
  const extensionScore = EXTENSION_PRIORITY.get(extension) ?? 500;

  return {
    role: 'deliverable',
    reason: explicitRole === 'deliverable' ? 'persisted-role' : 'customer-file',
    score: extensionScore + finalScore + sizeScore,
    family: EXTENSION_FAMILY.get(extension) || 'other',
  };
};

const selectVisibleGeneratedArtifacts = (
  files,
  { maxVisible = MAX_VISIBLE_GENERATED_FILES, requestText = '' } = {},
) => {
  const seen = new Set();
  const seenSignatures = new Set();
  const candidates = [];
  const hidden = [];
  const requestedFamilies = detectRequestedOutputFamilies(requestText);

  for (const [index, file] of (Array.isArray(files) ? files : []).entries()) {
    if (!file) {
      continue;
    }
    const identity = file.file_id || `${getArtifactName(file)}:${file.bytes || ''}`;
    const signature = `${path.posix.basename(normalizeArtifactPath(getArtifactName(file)))}:${file.bytes || ''}`;
    if (seen.has(identity) || seenSignatures.has(signature)) {
      hidden.push({ file, reason: 'duplicate' });
      continue;
    }
    seen.add(identity);
    seenSignatures.add(signature);

    const classification = classifyGeneratedArtifact(file);
    if (classification.role !== 'deliverable') {
      hidden.push({ file, reason: classification.reason });
      continue;
    }
    candidates.push({
      file,
      index,
      score: classification.score,
      family: classification.family,
    });
  }

  const requestedCandidates =
    requestedFamilies.size > 0
      ? candidates.filter((candidate) => requestedFamilies.has(candidate.family))
      : candidates;
  const eligible = requestedCandidates.length > 0 ? requestedCandidates : candidates;
  const eligibleSet = new Set(eligible.map(({ file }) => file));
  for (const candidate of candidates) {
    if (!eligibleSet.has(candidate.file)) {
      hidden.push({ file: candidate.file, reason: 'unrequested-format' });
    }
  }

  eligible.sort((left, right) => right.score - left.score || left.index - right.index);
  const effectiveLimit =
    requestedFamilies.size > 1 || requestsMultipleDeliverables(requestText)
      ? maxVisible
      : Math.min(1, maxVisible);
  const visible = eligible.slice(0, effectiveLimit).map(({ file }) => file);
  const overflow = eligible.slice(effectiveLimit).map(({ file }) => file);

  return { visible, hidden, overflow };
};

module.exports = {
  MAX_VISIBLE_GENERATED_FILES,
  classifyGeneratedArtifact,
  detectRequestedOutputFamilies,
  requestsMultipleDeliverables,
  selectVisibleGeneratedArtifacts,
};

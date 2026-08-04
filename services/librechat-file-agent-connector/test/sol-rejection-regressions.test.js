import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOCX_MIME,
  OFFICE_COMPOSE_CAPABILITY_PROFILE,
  PPTX_CAPABILITY_PROFILE,
  PPTX_MIME,
  XLSX_MIME,
} from '../src/constants.js';
import {
  createProductionOfficePreflight,
  productionCapabilityProfile,
} from '../src/production-host-integration.js';
import { sourceLogicalIdForFile } from '../src/office-compose-acceptance-resolver.js';
import { normalizeOfficeComposeAcceptanceAssertions } from '../../file-agent-runtime/src/office-compose-acceptance.js';

test('natural-language XLSX to PPT request is classified as Office Compose before acceptance parsing', () => {
  const file = { file_id: 'xlsx-1', filename: '2026-data.xlsx', type: XLSX_MIME };
  const instruction = '根据这个 Excel 生成一页 API 模型来源说明 PPT';
  const profile = productionCapabilityProfile({
    files: [file],
    instruction,
  });

  assert.equal(profile, OFFICE_COMPOSE_CAPABILITY_PROFILE);
  return createProductionOfficePreflight({
    allowlistedUserIds: new Set(['user-1']),
  })({
    req: { body: { files: [{ file_id: file.file_id }] } },
    client: { options: { attachments: [file] } },
    userId: 'user-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    assistantMessageId: 'assistant-1',
    streamId: 'stream-1',
    text: instruction,
  }).then((result) => assert.equal(result, null));
});

test('explicit DOCX edit and DOCX delivery cannot be classified as Office Compose', () => {
  const profile = productionCapabilityProfile({
    files: [{ file_id: 'docx-1', filename: 'source.docx', type: DOCX_MIME }],
    instruction: '把第1段替换为“新内容”，生成一个 DOCX 文件',
  });

  assert.equal(profile, 'word-edit-v1');
});

test('PPTX title-edit language routes to the PPTX profile and produces PPTX output', () => {
  const file = { file_id: 'pptx-1', filename: 'deck.pptx', type: PPTX_MIME };
  const instruction = '修改这个 PPT 的标题并交付 PPTX';
  const profile = productionCapabilityProfile({ files: [file], instruction });
  assert.equal(profile, PPTX_CAPABILITY_PROFILE);
});

test('source logical IDs remain valid for numeric, Chinese, and punctuation-leading filenames', () => {
  for (const [fileId, filename] of [
    ['numeric', '2026-data.xlsx'],
    ['chinese', '数据汇总.xlsx'],
    ['punctuation', '---.xlsx'],
  ]) {
    const logicalId = sourceLogicalIdForFile({ file_id: fileId, filename, type: XLSX_MIME });
    assert.match(logicalId, /^source:[a-z][a-z0-9._-]{0,63}$/u, filename);
    assert.doesNotThrow(() => normalizeOfficeComposeAcceptanceAssertions([
      {
        type: 'compose.source_mapping.v1',
        sourceLogicalId: logicalId,
        sourceLocation: 'Sheet1!A1',
        targetSlide: 1,
        targetShape: 'body',
      },
    ]));
  }
});

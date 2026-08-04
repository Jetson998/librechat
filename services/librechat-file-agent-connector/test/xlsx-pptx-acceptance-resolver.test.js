import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOCX_MIME,
  PPTX_CAPABILITY_PROFILE,
  PPTX_MIME,
  XLSX_CAPABILITY_PROFILE,
  XLSX_MIME,
} from '../src/constants.js';
import { resolvePptxAcceptanceAssertions } from '../src/pptx-acceptance-resolver.js';
import { resolveXlsxAcceptanceAssertions } from '../src/xlsx-acceptance-resolver.js';
import { createUpstreamRuntimeRequestResolver } from '../src/upstream-controller-adapter.js';
import { decideFileAgentCapabilityRoute } from '../src/task-router.js';

function file(type, name = type === XLSX_MIME ? 'source.xlsx' : 'source.pptx') {
  return { file_id: 'file-1', filename: name, type };
}

function upstreamContext(attachment, instruction) {
  return {
    req: {
      user: { id: 'user-1', tenantId: 'tenant-1' },
      body: { files: [{ file_id: attachment.file_id }] },
    },
    client: {
      options: {
        attachments: [{
          ...attachment,
          user: 'user-1',
          tenantId: 'tenant-1',
          content: Buffer.from('office-fixture'),
          metadata: {
            codeEnvRef: {
              kind: 'user',
              id: 'user-1',
              storage_session_id: 'session-1',
              file_id: 'codeapi-file-1',
            },
          },
        }],
        agent: { endpoint: 'custom', model: 'office-model' },
      },
    },
    userId: 'user-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    assistantMessageId: 'assistant-1',
    streamId: 'stream-1',
    text: instruction,
  };
}

test('XLSX acceptance resolver freezes explicit cell, formula, format, and sheet assertions', () => {
  const cell = resolveXlsxAcceptanceAssertions({
    files: [file(XLSX_MIME)],
    instruction: '将 Source!A1 改为 42，并交付最终 XLSX',
  });
  assert.deepEqual(cell?.map((entry) => entry.type), [
    'xlsx.cell_value.v1',
    'xlsx.artifact.v1',
  ]);
  assert.equal(cell?.[0].value, 42);
  assert.deepEqual(
    resolveXlsxAcceptanceAssertions({
      files: [file(XLSX_MIME)],
      instruction: '将“Data!B2”设置公式为“=SUM(A1:A2)”，并交付 Excel 工作簿',
    })?.[0],
    {
      schemaVersion: '1.0',
      type: 'xlsx.formula.v1',
      sheet: 'Data',
      cell: 'B2',
      formula: '=SUM(A1:A2)',
    },
  );
  assert.equal(
    resolveXlsxAcceptanceAssertions({
      files: [file(XLSX_MIME)],
      instruction: '将 Source!C3 的数字格式设置为“0.00”，并交付 XLSX',
    })?.[0].type,
    'xlsx.number_format.v1',
  );
  assert.equal(
    resolveXlsxAcceptanceAssertions({
      files: [file(XLSX_MIME)],
      instruction: '新增工作表“Summary”，并交付最终工作簿',
    })?.[0].sheet,
    'Summary',
  );
});

test('XLSX acceptance resolver supports composed supported actions and rejects partial instructions', () => {
  const result = resolveXlsxAcceptanceAssertions({
    files: [file(XLSX_MIME)],
    instruction: '将 Source!A1 改为 42，并将 Source!B1 改为“done”，并交付 XLSX',
  });
  assert.deepEqual(result?.map((entry) => entry.type), [
    'xlsx.cell_value.v1',
    'xlsx.cell_value.v1',
    'xlsx.artifact.v1',
  ]);

  for (const instruction of [
    '将 Source!A1 改为 42，并调整列宽，然后交付 XLSX',
    '将 Source!A1 改为 42，并请“输出一份带图表的版本”',
    '将 Source!A1 改为 42，并提供一个 XLSX，同时提供一个修订版文件',
    '生成一个 XLSX 汇总文件',
  ]) {
    assert.equal(resolveXlsxAcceptanceAssertions({ files: [file(XLSX_MIME)], instruction }), null, instruction);
  }
  assert.equal(
    resolveXlsxAcceptanceAssertions({ files: [file(DOCX_MIME, 'source.docx')], instruction: '将 Source!A1 改为 42，并交付 XLSX' }),
    null,
  );
});

test('XLSX acceptance resolver maps real language for worksheet, style, table, and chart changes', () => {
  const cases = [
    ['删除工作表“Temporary”，并交付 XLSX', 'xlsx.sheet_absent.v1'],
    ['将工作表“Config”重命名为“Settings”，并交付 XLSX', 'xlsx.sheet_rename.v1'],
    ['将工作表顺序调整为“Config, Source”，并交付 XLSX', 'xlsx.sheet_order.v1'],
    ['将 Source!B2 设置为加粗，并交付 XLSX', 'xlsx.style.v1'],
    ['将 Source!A1:C3 设置为 Excel 表格“SourceTable”，并交付 XLSX', 'xlsx.table_present.v1'],
    ['根据 Source!A1:B3 添加一个柱状图“Amount by Month”，并交付 XLSX', 'xlsx.chart_present.v1'],
  ];
  for (const [instruction, type] of cases) {
    const result = resolveXlsxAcceptanceAssertions({ files: [file(XLSX_MIME)], instruction });
    assert.equal(result?.[0].type, type, instruction);
  }
});

test('PPTX acceptance resolver freezes text, table, and slide-order assertions', () => {
  const text = resolvePptxAcceptanceAssertions({
    files: [file(PPTX_MIME)],
    instruction: '将第1页的“TitleBox”替换为“Updated”，并交付最终 PPTX',
  });
  assert.deepEqual(text?.map((entry) => entry.type), [
    'pptx.text_value.v1',
    'pptx.artifact.v1',
  ]);
  assert.deepEqual(
    resolvePptxAcceptanceAssertions({
      files: [file(PPTX_MIME)],
      instruction: 'replace slide 1 "TitleBox" with "Updated" and provide one final deck',
    })?.[0],
    {
      schemaVersion: '1.0',
      type: 'pptx.text_value.v1',
      slide: 1,
      shape: 'TitleBox',
      value: 'Updated',
    },
  );
  assert.deepEqual(
    resolvePptxAcceptanceAssertions({
      files: [file(PPTX_MIME)],
      instruction: '将第2页的表格“Table1”第1行第2列设置为“Value”，并交付 PowerPoint 演示文稿',
    })?.[0],
    {
      schemaVersion: '1.0',
      type: 'pptx.table_cell_value.v1',
      slide: 2,
      shape: 'Table1',
      row: 0,
      column: 1,
      value: 'Value',
    },
  );
  assert.deepEqual(
    resolvePptxAcceptanceAssertions({
      files: [file(PPTX_MIME)],
      instruction: '将幻灯片顺序调整为 2,1，并交付 PPTX',
    })?.[0].order,
    [2, 1],
  );
});

test('PPTX acceptance resolver supports multiple mapped actions and fails closed', () => {
  const result = resolvePptxAcceptanceAssertions({
    files: [file(PPTX_MIME)],
    instruction: '将第1页的“TitleBox”改为“Updated”，并将第2页的“BodyBox”改为“Summary”，并交付 PPTX',
  });
  assert.deepEqual(result?.map((entry) => entry.type), [
    'pptx.text_value.v1',
    'pptx.text_value.v1',
    'pptx.artifact.v1',
  ]);

  for (const instruction of [
    '将第1页的“TitleBox”改为“Updated”，并调整字体，然后交付 PPTX',
    '将第1页的“TitleBox”改为“Updated”，并提供两个 PPTX 文件',
    '请生成一份汇报 PPTX',
    '将第1页的“TitleBox”改为“Updated”，并请“删除备注”',
  ]) {
    assert.equal(resolvePptxAcceptanceAssertions({ files: [file(PPTX_MIME)], instruction }), null, instruction);
  }
  assert.equal(
    resolvePptxAcceptanceAssertions({ files: [file(XLSX_MIME, 'source.xlsx')], instruction: '将第1页的“TitleBox”改为“Updated”，并交付 PPTX' }),
    null,
  );
});

test('PPTX acceptance resolver maps real language for slide deletion and copying', () => {
  const deleted = resolvePptxAcceptanceAssertions({
    files: [file(PPTX_MIME)],
    instruction: '删除第2页，并交付 PPTX',
  });
  assert.equal(deleted?.[0].type, 'pptx.slide_absent.v1');
  assert.equal(deleted?.[0].slide, 2);

  const copied = resolvePptxAcceptanceAssertions({
    files: [file(PPTX_MIME)],
    instruction: '复制第1页到第3页，并交付 PPTX',
  });
  assert.equal(copied?.[0].type, 'pptx.slide_copy.v1');
  assert.deepEqual(
    { sourceSlide: copied?.[0].sourceSlide, destination: copied?.[0].destination },
    { sourceSlide: 1, destination: 3 },
  );
  const added = resolvePptxAcceptanceAssertions({
    files: [file(PPTX_MIME)],
    instruction: '新增一页，标题为“Appendix”，并交付 PPTX',
  });
  assert.equal(added?.[0].type, 'pptx.slide_add.v1');
  assert.equal(added?.[0].position, 'append');
  assert.equal(added?.[0].title, 'Appendix');
});

test('upstream Runtime resolver selects the formal XLSX and PPTX acceptance contracts', async () => {
  const xlsxAttachment = file(XLSX_MIME);
  const xlsxRequest = await createUpstreamRuntimeRequestResolver({
    modelRouteId: 'file-agent-xlsx',
    capabilityProfile: XLSX_CAPABILITY_PROFILE,
  })(upstreamContext(xlsxAttachment, '将 Source!A1 改为 42，并交付 XLSX'));
  assert.equal(xlsxRequest.taskContractVersion, 'office-file-agent.v1.2');
  assert.equal(xlsxRequest.capabilityProfile, XLSX_CAPABILITY_PROFILE);
  assert.equal(xlsxRequest.acceptanceAssertions[0].type, 'xlsx.cell_value.v1');

  const pptxAttachment = file(PPTX_MIME);
  const pptxRequest = await createUpstreamRuntimeRequestResolver({
    modelRouteId: 'file-agent-pptx',
    capabilityProfile: PPTX_CAPABILITY_PROFILE,
  })(upstreamContext(pptxAttachment, '将第1页的“TitleBox”改为“Updated”，并交付 PPTX'));
  assert.equal(pptxRequest.taskContractVersion, 'office-file-agent.v1.2');
  assert.equal(pptxRequest.capabilityProfile, PPTX_CAPABILITY_PROFILE);
  assert.equal(pptxRequest.acceptanceAssertions[0].type, 'pptx.text_value.v1');
});

test('formal XLSX and PPTX profiles require v1.2 and their exact single input', () => {
  const capabilities = {
    taskContractVersions: ['office-file-agent.v1.2'],
    taskTypes: ['office_transform'],
    capabilityProfiles: [XLSX_CAPABILITY_PROFILE, PPTX_CAPABILITY_PROFILE],
    inputMimeTypes: [XLSX_MIME, PPTX_MIME],
    outputMimeTypes: [XLSX_MIME, PPTX_MIME],
    maxInputFiles: 2,
  };
  assert.deepEqual(
    decideFileAgentCapabilityRoute({
      files: [{ mimeType: XLSX_MIME }],
      capabilityProfile: XLSX_CAPABILITY_PROFILE,
      capabilities,
    }),
    { route: 'runtime', reason: 'eligible_complex_file_task' },
  );
  assert.deepEqual(
    decideFileAgentCapabilityRoute({
      files: [{ mimeType: PPTX_MIME }],
      capabilityProfile: PPTX_CAPABILITY_PROFILE,
      capabilities,
    }),
    { route: 'runtime', reason: 'eligible_complex_file_task' },
  );
  assert.deepEqual(
    decideFileAgentCapabilityRoute({
      files: [{ mimeType: XLSX_MIME }, { mimeType: XLSX_MIME }],
      capabilityProfile: XLSX_CAPABILITY_PROFILE,
      capabilities,
    }),
    { route: 'native', reason: 'xlsx_input_contract_unsupported' },
  );
});

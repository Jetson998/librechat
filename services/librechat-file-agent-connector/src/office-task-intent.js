import {
  DOCX_MIME,
  OFFICE_COMPOSE_CAPABILITY_PROFILE,
  PPTX_CAPABILITY_PROFILE,
  PPTX_MIME,
  XLSX_CAPABILITY_PROFILE,
  XLSX_MIME,
  WORD_CAPABILITY_PROFILE,
} from './constants.js';

const OUTPUT_CUE = /(?:交付|提交|输出|返回|提供|下载|保存|生成|制作|导出|转换|deliver|submit|output|return|provide|download|save|generate|create|export|convert|produce)/iu;
const DOCX_OUTPUT = /(?:\bdocx\b|\bword\b|Word\s*(?:文档|文件)|文档|word document|word file)/iu;
const XLSX_OUTPUT = /(?:\bxlsx\b|\bexcel\b|Excel\s*(?:工作簿|文件)|工作簿|电子表格|spreadsheet|workbook)/iu;
const PPTX_OUTPUT = /(?:\bpptx?\b|\bpowerpoint\b|PPT\s*(?:演示文稿|文件)?|演示文稿|幻灯片|presentation|slides?|deck)/iu;
const COMPOSE_CUE = /(?:生成|制作|汇总|整理|导出|转换|演示文稿|汇报|幻灯片|presentation|compose|summari[sz]e|export|convert|slide|deck)/iu;
const EDIT_CUE = /(?:修改|替换|改为|改成|新增|添加|删除|调整|重排|更新|设置|replace|modify|change|add|delete|remove|reorder|update|set)/iu;

function fileMime(file) {
  if (file?.mimeType || file?.type) {
    return file.mimeType ?? file.type;
  }
  const name = String(file?.filename ?? file?.name ?? '').toLowerCase();
  if (name.endsWith('.docx')) return DOCX_MIME;
  if (name.endsWith('.xlsx')) return XLSX_MIME;
  if (name.endsWith('.pptx')) return PPTX_MIME;
  return null;
}
function outputFormat(instruction) {
  if (!OUTPUT_CUE.test(instruction)) {
    return null;
  }
  if (PPTX_OUTPUT.test(instruction)) return PPTX_MIME;
  if (DOCX_OUTPUT.test(instruction)) return DOCX_MIME;
  if (XLSX_OUTPUT.test(instruction)) return XLSX_MIME;
  return null;
}

function profileForOutput({ inputMimeTypes, outputMimeType, instruction }) {
  const hasDocx = inputMimeTypes.includes(DOCX_MIME);
  const hasXlsx = inputMimeTypes.includes(XLSX_MIME);
  const hasPptx = inputMimeTypes.includes(PPTX_MIME);
  if (outputMimeType === PPTX_MIME && (hasDocx || hasXlsx)) {
    return OFFICE_COMPOSE_CAPABILITY_PROFILE;
  }
  if (outputMimeType === DOCX_MIME && inputMimeTypes.length === 1 && hasDocx) {
    return WORD_CAPABILITY_PROFILE;
  }
  if (outputMimeType === XLSX_MIME && inputMimeTypes.length === 1 && hasXlsx) {
    return XLSX_CAPABILITY_PROFILE;
  }
  if (outputMimeType === PPTX_MIME && inputMimeTypes.length === 1 && hasPptx) {
    return PPTX_CAPABILITY_PROFILE;
  }
  if (outputMimeType != null) {
    return null;
  }
  if (inputMimeTypes.length === 2 && inputMimeTypes.every((mime) => [DOCX_MIME, XLSX_MIME].includes(mime))) {
    return COMPOSE_CUE.test(instruction) ? OFFICE_COMPOSE_CAPABILITY_PROFILE : null;
  }
  if (inputMimeTypes.length !== 1) {
    return null;
  }
  if (hasDocx && EDIT_CUE.test(instruction)) return WORD_CAPABILITY_PROFILE;
  if (hasXlsx && EDIT_CUE.test(instruction)) return XLSX_CAPABILITY_PROFILE;
  if (hasPptx && EDIT_CUE.test(instruction)) return PPTX_CAPABILITY_PROFILE;
  return null;
}

export function resolveOfficeTaskIntent({ files, instruction } = {}) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 2) {
    return null;
  }
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    return null;
  }
  const inputMimeTypes = files.map(fileMime);
  if (inputMimeTypes.some((mime) => ![DOCX_MIME, XLSX_MIME, PPTX_MIME].includes(mime))) {
    return null;
  }
  if (inputMimeTypes.includes(PPTX_MIME) && inputMimeTypes.length !== 1) {
    return null;
  }
  const outputMimeType = outputFormat(instruction);
  const profile = profileForOutput({ inputMimeTypes, outputMimeType, instruction });
  if (!profile) {
    return null;
  }
  const operationFamilies = profile === OFFICE_COMPOSE_CAPABILITY_PROFILE ? ['compose'] : ['edit'];
  const explicitOutput = outputMimeType != null;
  return Object.freeze({
    profile,
    inputMimeTypes: Object.freeze([...new Set(inputMimeTypes)]),
    outputMimeType: outputMimeType
      ?? (profile === OFFICE_COMPOSE_CAPABILITY_PROFILE ? PPTX_MIME : inputMimeTypes[0]),
    operationFamilies: Object.freeze(operationFamilies),
    confidence: explicitOutput ? 'high' : 'medium',
    reason: explicitOutput ? 'explicit_output_format_and_input_contract' : 'input_format_and_edit_intent',
  });
}

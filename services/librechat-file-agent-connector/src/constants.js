export const TASK_CONTRACT_VERSION_V1 = 'office-file-agent.v1';
export const TASK_CONTRACT_VERSION_V1_1 = 'office-file-agent.v1.1';
export const TASK_CONTRACT_VERSION_V1_2 = 'office-file-agent.v1.2';
export const TASK_CONTRACT_VERSION = TASK_CONTRACT_VERSION_V1;
export const WORD_CAPABILITY_PROFILE = 'word-edit-v1';
export const XLSX_CAPABILITY_PROFILE = 'xlsx-edit-v1';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const TASK_TYPE = 'office_transform';
export const DEFAULT_CAPABILITY_PROFILE = 'office-planner-v1';
export const MAX_VISIBLE_ARTIFACTS = 3;

export const DELIVERY_TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'canceled',
  'delivery_failed',
]);

export const MIME_EXTENSIONS = Object.freeze({
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': new Set(['.xlsx']),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': new Set(['.docx']),
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': new Set(['.pptx']),
  'application/pdf': new Set(['.pdf']),
  'text/markdown': new Set(['.md', '.markdown']),
  'text/csv': new Set(['.csv']),
  'text/plain': new Set(['.txt']),
});

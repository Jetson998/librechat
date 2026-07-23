export const TASK_CONTRACT_VERSION = 'office-file-agent.v1';
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

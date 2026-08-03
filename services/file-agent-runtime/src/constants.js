export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);

export const TASK_CONTRACT_VERSION_V1 = 'office-file-agent.v1';
export const TASK_CONTRACT_VERSION_V1_1 = 'office-file-agent.v1.1';
export const SUPPORTED_TASK_CONTRACT_VERSIONS = new Set([
  TASK_CONTRACT_VERSION_V1,
  TASK_CONTRACT_VERSION_V1_1,
]);
export const WORD_CAPABILITY_PROFILE = 'word-edit-v1';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const STATUS_TRANSITIONS = Object.freeze({
  accepted: new Set(['preparing', 'canceled', 'failed']),
  preparing: new Set(['planning', 'canceled', 'failed']),
  planning: new Set(['executing', 'needs_input', 'canceled', 'failed']),
  executing: new Set(['planning', 'verifying', 'canceled', 'failed']),
  verifying: new Set(['repairing', 'publishing', 'canceled', 'failed']),
  repairing: new Set(['executing', 'needs_input', 'canceled', 'failed']),
  needs_input: new Set(['planning', 'canceled', 'failed']),
  publishing: new Set(['completed', 'canceled', 'failed']),
  completed: new Set(),
  failed: new Set(),
  canceled: new Set(),
});

export function canTransition(from, to) {
  return STATUS_TRANSITIONS[from]?.has(to) ?? false;
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

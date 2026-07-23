export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);

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

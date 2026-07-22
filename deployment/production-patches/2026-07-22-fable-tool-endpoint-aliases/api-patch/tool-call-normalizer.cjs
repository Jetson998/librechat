'use strict';

const LEGACY_TOOL_ALIASES = Object.freeze({
  Bash: 'bash_tool',
  Read: 'read_file',
  Skill: 'skill',
});

function normalizeLegacyClaudeCodeToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return toolCall;

  const normalizedName = LEGACY_TOOL_ALIASES[toolCall.name];
  if (!normalizedName) return toolCall;

  const args =
    toolCall.args && typeof toolCall.args === 'object' && !Array.isArray(toolCall.args)
      ? { ...toolCall.args }
      : {};

  if (toolCall.name === 'Read') {
    if (typeof args.path !== 'string' && typeof args.file_path === 'string') {
      args.path = args.file_path;
    }
    delete args.file_path;
  }

  if (toolCall.name === 'Skill') {
    if (typeof args.skillName !== 'string' && typeof args.skill === 'string') {
      args.skillName = args.skill;
    }
    delete args.skill;
  }

  return {
    ...toolCall,
    name: normalizedName,
    args,
  };
}

module.exports = {
  LEGACY_TOOL_ALIASES,
  normalizeLegacyClaudeCodeToolCall,
};

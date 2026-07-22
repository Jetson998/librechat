'use strict';

const CONTRACT_TOOL_ORDER = Object.freeze([
  'bash_tool',
  'read_file',
  'skill',
  'create_file',
  'edit_file',
]);

function getRegisteredContractTools(toolDefinitions) {
  const registered = new Set(
    (toolDefinitions || [])
      .map((definition) => definition?.name)
      .filter((name) => typeof name === 'string' && name.length > 0),
  );

  return CONTRACT_TOOL_ORDER.filter((name) => registered.has(name));
}

function buildCodeToolContract(toolDefinitions) {
  const availableTools = getRegisteredContractTools(toolDefinitions);
  if (availableTools.length === 0) return '';

  const callableNames = availableTools.map((name) => `\`${name}\``).join(', ');
  return [
    'LibreChat code and file tool contract for this run:',
    `- Callable code/file tool names currently registered: ${callableNames}.`,
    '- `execute_code` is a capability marker, not a callable tool name.',
    '- Use the exact registered names and argument schemas. Do not call Claude Code CLI aliases `Bash`, `Read`, `Skill`, `Grep`, `Glob`, `Edit`, or `LS`.',
  ].join('\n');
}

module.exports = {
  CONTRACT_TOOL_ORDER,
  getRegisteredContractTools,
  buildCodeToolContract,
};

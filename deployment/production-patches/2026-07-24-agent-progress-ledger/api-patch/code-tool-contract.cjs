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
  const contract = [
    'LibreChat code and file tool contract for this run:',
    `- Callable code/file tool names currently registered: ${callableNames}.`,
    '- `execute_code` is a capability marker, not a callable tool name.',
    '- Use the exact registered names and argument schemas. Do not call Claude Code CLI aliases `Bash`, `Read`, `Skill`, `Grep`, `Glob`, `Edit`, or `LS`.',
    '- If a tool reports that it is not registered, do not conclude that the disk or code environment is unavailable; choose an exact name from the registered list and retry with the documented schema.',
  ];
  if (availableTools.includes('bash_tool')) {
    contract.push('- The code sandbox is Linux and isolated from the host machine. Use `/mnt/data` for uploaded or generated files; Windows host paths such as `C:\\Users\\...` are unavailable.');
    contract.push('- Keep each `bash_tool` call focused and short. If a script is long, split it into several calls so the tool arguments cannot be truncated.');
  }
  if (availableTools.includes('create_file') && availableTools.includes('bash_tool')) {
    contract.push('- For a long script, write it with `create_file` under `/mnt/data/`, then run that file with a short `bash_tool` command.');
  }
  return contract.join('\n');
}

module.exports = {
  CONTRACT_TOOL_ORDER,
  getRegisteredContractTools,
  buildCodeToolContract,
};

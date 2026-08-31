'use strict';

const CODE_TOOL_ARGUMENTS = Object.freeze({
  bash_tool: ['command'],
  read_file: ['path'],
  skill: ['skillName'],
  create_file: ['path', 'content'],
  edit_file: ['path'],
});

const TOOL_ARGUMENTS_INCOMPLETE_CODE = 'TOOL_ARGUMENTS_INCOMPLETE';
const BASH_SYNTAX_HINT =
  'bash_tool 的脚本可能在生成或传输时不完整。不要重复相同载荷；请拆分成多个较短的 Linux 命令，文件路径使用 /mnt/data。';

function parseObjectArguments(args) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args;
  if (typeof args !== 'string' || args.trim() === '') return null;
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function missingArgument(name, field) {
  return `[${TOOL_ARGUMENTS_INCOMPLETE_CODE}] Tool "${name}" 的参数不完整或格式错误：需要包含字符串字段 "${field}" 的 JSON 对象。此调用可能因模型输出过长而被截断。不要重试相同载荷；请拆分为多个较短调用。代码沙箱运行 Linux，只能操作 /mnt/data，不能访问宿主机磁盘。`;
}

function getToolCallArgumentError(toolCall) {
  const name = toolCall?.name;
  const required = CODE_TOOL_ARGUMENTS[name];
  if (!required) return null;

  const args = parseObjectArguments(toolCall.args);
  if (!args) return missingArgument(name, required[0]);

  for (const field of required) {
    const mustBeNonEmpty = !['content', 'old_text', 'new_text'].includes(field);
    if (typeof args[field] !== 'string' || (mustBeNonEmpty && args[field].trim() === '')) {
      if (name === 'edit_file' && Array.isArray(args.edits) && args.edits.length > 0) continue;
      return missingArgument(name, field);
    }
  }

  if (name === 'edit_file') {
    if (Array.isArray(args.edits)) {
      if (args.edits.length === 0) return missingArgument(name, 'old_text/new_text 或 edits');
      if (args.edits.some((edit) => !edit || typeof edit.old_text !== 'string' || typeof edit.new_text !== 'string')) {
        return missingArgument(name, 'edits[].old_text/new_text');
      }
    } else if (typeof args.old_text !== 'string' || typeof args.new_text !== 'string') {
      return missingArgument(name, 'old_text/new_text 或 edits');
    }
  }
  return null;
}

function getUnknownToolErrorMessage(toolName, availableTools) {
  const safeToolName = String(toolName ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 120);
  const available = [...new Set((availableTools ?? []).filter((name) => typeof name === 'string' && name))].sort();
  const list = available.length > 0 ? `当前已注册工具：${available.map((name) => `\`${name}\``).join('、')}。` : '当前运行没有可用的同类工具。';
  const has = (name) => available.includes(name);
  const guidance = [];

  if (/^powershell?$/i.test(String(toolName))) {
    guidance.push(
      has('bash_tool')
        ? '当前代码沙箱是 Linux，不提供 PowerShell，也不能访问宿主机磁盘或 Windows 路径（例如 C:\\Users\\...）。请改用 `bash_tool`，并只操作 `/mnt/data`。'
        : '当前代码沙箱没有可用的 shell 工具，不能访问宿主机磁盘或 Windows 路径。',
    );
  } else if (String(toolName).toLowerCase() === 'glob') {
    if (has('read_file')) guidance.push('不要重试 `Glob`；已知文本文件请用 `read_file`。');
    if (has('bash_tool')) guidance.push('需要发现或搜索文件时请用 `bash_tool` 配合 Linux 的 `find` 或 `rg`，范围限定在 `/mnt/data`。');
  } else if (has('bash_tool') || has('read_file')) {
    guidance.push('请只使用本轮实际注册的规范工具名，不要调用 Claude Code CLI 的别名。');
  }

  return `Tool "${safeToolName}" 未在本轮注册。${list}${guidance.length > 0 ? ` ${guidance.join(' ')}` : ''}`;
}

function augmentToolExecutionError(toolName, message) {
  const text = String(message ?? '工具执行失败');
  if (toolName !== 'bash_tool' || text.includes(`[${TOOL_ARGUMENTS_INCOMPLETE_CODE}]`)) return text;
  if (!/(unexpected\s+EOF|syntax\s+error|unterminated|here-document|parse\s+error)/i.test(text)) return text;
  return `${text}\n\n[${TOOL_ARGUMENTS_INCOMPLETE_CODE}] ${BASH_SYNTAX_HINT}`;
}

module.exports = {
  BASH_SYNTAX_HINT,
  CODE_TOOL_ARGUMENTS,
  TOOL_ARGUMENTS_INCOMPLETE_CODE,
  augmentToolExecutionError,
  getToolCallArgumentError,
  getUnknownToolErrorMessage,
  parseObjectArguments,
};

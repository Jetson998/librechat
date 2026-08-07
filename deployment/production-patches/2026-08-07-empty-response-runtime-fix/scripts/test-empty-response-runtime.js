#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const requestPath = path.join(root, 'backend/overlay/api/server/controllers/agents/request.js');
const initFailure = require(
  path.join(root, 'backend/overlay/api/server/controllers/agents/InitializationFailure.js'),
);

const requestSource = fs.readFileSync(requestPath, 'utf8');
assert(requestSource.includes('const wasAborted = job.abortController.signal.aborted;'));
assert(!requestSource.includes("error.message?.includes('abort')"));
assert(requestSource.includes('Failed to persist generation terminal state'));
assert(requestSource.includes('GenerationJobManager.emitDone(streamId, {'));
assert(requestSource.includes('fileAgentRuntimeBridge'));
assert(requestSource.includes('persistFileAgentUserTurn'));
assert(requestSource.includes('runtimeBridge.tryRoute'));

const saved = [];
const saveMessage = async (_context, message) => {
  saved.push({ kind: 'message', message });
  return message;
};
const saveConvo = async (_context, conversation) => {
  saved.push({ kind: 'conversation', conversation });
  return conversation;
};

async function main() {
  const state = await initFailure.persistInitializationFailure({
    req: { body: { isTemporary: false }, config: {} },
    userId: 'user-1',
    conversationId: 'conversation-1',
    isNewConvo: false,
    endpointOption: { endpoint: 'agents', modelLabel: 'AI', agent_id: 'agent-1' },
    responseModel: 'agent-1',
    preliminaryUserMessage: {
      messageId: 'user-message-1',
      parentMessageId: 'parent-1',
      conversationId: 'conversation-1',
      text: 'private prompt text',
    },
    preliminaryResponseMessageId: 'response-message-1_',
    error: {
      code: 'EMPTY_MODEL_RESPONSE',
      message: JSON.stringify({ type: 'EMPTY_MODEL_RESPONSE', message: 'raw internal message' }),
    },
    saveMessage,
    saveConvo,
  });

  assert.equal(
    state.responseMessage.text,
    '模型没有返回可用内容，请重新生成；如果仍然失败，请选择其他模型。',
  );
  assert.equal(state.responseMessage.error, true);
  assert.equal(saved.length, 3);
  process.stdout.write('empty-response runtime focused tests passed\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

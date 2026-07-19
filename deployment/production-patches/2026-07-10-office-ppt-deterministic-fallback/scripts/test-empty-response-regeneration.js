const assert = require('assert');
const fs = require('fs');
const path = require('path');

const patchRoot = path.resolve(__dirname, '..');
const baseClientPath = path.join(patchRoot, 'office-context-patch', 'BaseClient.js');
const apiIndexPath = path.join(patchRoot, 'office-context-patch', 'api-index.cjs');

const read = (file) => fs.readFileSync(file, 'utf8');

const sliceBetween = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0, `Missing start marker: ${startMarker}`);
  assert(end > start, `Missing end marker: ${endMarker}`);
  return source.slice(start, end);
};

const loadSemanticHelpers = () => {
  const source = read(baseClientPath);
  const helperBlock = sliceBetween(source, 'const EMPTY_MODEL_RESPONSE_CODE', 'class BaseClient');
  const ContentTypes = {
    TEXT: 'text',
    THINK: 'think',
  };
  const factory = Function(
    'ContentTypes',
    `${helperBlock}\nreturn {
      EMPTY_MODEL_RESPONSE_CODE,
      hasAssistantSemanticContent,
      filterSemanticallyEmptyAssistantMessages,
      ensureAssistantSemanticContent,
    };`,
  );
  return factory(ContentTypes);
};

const testSemanticContent = () => {
  const { hasAssistantSemanticContent } = loadSemanticHelpers();
  const emptyMessages = [
    {},
    { text: '' },
    { text: ' \n\t\u200b\ufeff ' },
    { content: [] },
    { content: [{ type: 'text', text: '   ' }] },
    { content: [{ type: 'text', text: { value: '\u200b' } }] },
    { content: [{ type: 'think', think: { value: '  ' } }] },
    { content: [{ type: 'tool_call', tool_call: {} }] },
    { files: [{}], attachments: [] },
    { metadata: { usage: { input_tokens: 100 } } },
  ];
  for (const message of emptyMessages) {
    assert.strictEqual(hasAssistantSemanticContent(message), false, JSON.stringify(message));
  }

  const meaningfulMessages = [
    { text: 'answer' },
    { summary: 'conversation summary' },
    { content: [{ type: 'text', text: 'answer' }] },
    {
      content: [
        {
          type: 'text',
          text: '',
          annotations: [{ type: 'citation', url: 'https://example.com/source' }],
        },
      ],
    },
    {
      content: [
        {
          type: 'tool_call',
          tool_call: { id: 'tool-1', name: 'Bash', progress: 1, output: 'done' },
        },
      ],
    },
    { files: [{ file_id: 'file-1', filename: 'output.xlsx' }] },
    { attachments: [{ type: 'ui_resources', ui_resources: { data: [{ uri: 'ui://1' }] } }] },
    { artifacts: [{ identifier: 'report', content: 'artifact content' }] },
    { citations: [{ url: 'https://example.com' }] },
    { image_urls: [{ image_url: { url: 'https://example.com/image.png' } }] },
  ];
  for (const message of meaningfulMessages) {
    assert.strictEqual(hasAssistantSemanticContent(message), true, JSON.stringify(message));
  }
};

const testHistoryFilter = () => {
  const { filterSemanticallyEmptyAssistantMessages } = loadSemanticHelpers();
  const history = [
    { messageId: 'user-1', isCreatedByUser: true, text: 'first' },
    { messageId: 'empty-1', isCreatedByUser: false, text: '', content: [] },
    { messageId: 'assistant-1', isCreatedByUser: false, text: 'answer' },
    { messageId: 'system-1', role: 'system', isCreatedByUser: false, text: '' },
    { messageId: 'empty-2', role: 'assistant', text: '\u200b' },
    { messageId: 'user-2', isCreatedByUser: true, text: 'second' },
  ];
  const result = filterSemanticallyEmptyAssistantMessages(history);
  assert.deepStrictEqual(result.filteredMessageIds, ['empty-1', 'empty-2']);
  assert.deepStrictEqual(
    result.messages.map((message) => message.messageId),
    ['user-1', 'assistant-1', 'system-1', 'user-2'],
  );
};

const testEmptyCompletionGuard = () => {
  const { EMPTY_MODEL_RESPONSE_CODE, ensureAssistantSemanticContent } = loadSemanticHelpers();
  assert.throws(
    () => ensureAssistantSemanticContent({ text: '', content: [], attachments: [] }),
    (error) =>
      error?.code === EMPTY_MODEL_RESPONSE_CODE &&
      error?.name === 'EmptyModelResponseError' &&
      error?.message.includes(`\"type\":\"${EMPTY_MODEL_RESPONSE_CODE}\"`),
  );
  assert.throws(
    () => ensureAssistantSemanticContent({ content: [{ type: 'think', think: 'ok' }] }),
    (error) => error?.code === EMPTY_MODEL_RESPONSE_CODE,
  );
};

const testIntegrationOrder = () => {
  const source = read(baseClientPath);
  const sendBlock = sliceBetween(source, '  async sendMessage(', '  async loadHistory(');
  const artifactIndex = sendBlock.indexOf('const artifactAttachments');
  const guardIndex = sendBlock.indexOf('ensureAssistantSemanticContent(responseMessage)');
  const assistantSaveIndex = sendBlock.indexOf(
    'responseMessage.databasePromise = this.saveMessageToDatabase',
  );
  assert(artifactIndex >= 0, 'Artifact assembly marker is missing');
  assert(guardIndex > artifactIndex, 'Empty-response guard runs before artifact assembly');
  assert(assistantSaveIndex > guardIndex, 'Assistant response can persist before empty guard');

  const historyBlock = sliceBetween(source, '  async loadHistory(', '  async saveMessageToDatabase(');
  const attachmentIndex = historyBlock.indexOf('this.addPreviousAttachments(_messages)');
  const filterIndex = historyBlock.indexOf('filterSemanticallyEmptyAssistantMessages(_messages)');
  assert(attachmentIndex >= 0, 'Historical attachment resolution marker is missing');
  assert(filterIndex > attachmentIndex, 'History is filtered before attachment resolution');
};

const testAbortGuard = () => {
  const source = read(apiIndexPath);
  const abortBlock = sliceBetween(source, '\tasync abortJob(streamId) {', '\t/**\n\t* Subscribe to a job');
  assert(
    abortBlock.includes('const isEarlyAbort = !shouldPersistAbortContent;'),
    'createdEventEmitted still permits empty abort persistence',
  );
  assert(
    abortBlock.includes('success: !isEarlyAbort'),
    'Empty abort is still returned as persistable to abort middleware',
  );
  assert(
    abortBlock.includes('responseMessage: isEarlyAbort ? null :'),
    'Empty abort final event still creates an assistant placeholder',
  );
};

Promise.resolve()
  .then(testSemanticContent)
  .then(testHistoryFilter)
  .then(testEmptyCompletionGuard)
  .then(testIntegrationOrder)
  .then(testAbortGuard)
  .then(() => process.stdout.write('empty response regeneration tests passed\n'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

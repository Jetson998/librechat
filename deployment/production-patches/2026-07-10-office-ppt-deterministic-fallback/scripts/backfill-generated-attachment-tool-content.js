// mongosh script. Backfills assistant messages that already have generated
// downloadable attachments/files but no content tool_call block. LibreChat's
// current chat renderer shows generated attachments from tool_call content
// blocks, not from assistant message.files alone.
//
// Usage:
//   LIBRECHAT_CID=<conversationId> \
//   LIBRECHAT_MESSAGE_ID=<assistantMessageId> \
//   mongosh --quiet LibreChat scripts/backfill-generated-attachment-tool-content.js

const env = typeof process !== 'undefined' && process.env ? process.env : {};
const conversationId = env.LIBRECHAT_CID;
const messageId = env.LIBRECHAT_MESSAGE_ID;

if (!conversationId) {
  throw new Error('LIBRECHAT_CID is required');
}
if (!messageId) {
  throw new Error('LIBRECHAT_MESSAGE_ID is required');
}

const toolAttachmentTypes = new Set(['file_search', 'web_search', 'ui_resources', 'memory']);

const isDownloadableAttachment = (file) =>
  Boolean(
    file &&
      file.file_id &&
      !toolAttachmentTypes.has(file.type) &&
      (file.filename || file.name || file.filepath),
  );

const getToolCallId = (file) =>
  file.toolCallId || (file.file_id ? `office_ppt_deterministic_fallback_${file.file_id}` : null);

const buildContent = (message, file) => {
  const toolCallId = getToolCallId(file);
  if (!toolCallId) {
    throw new Error('Generated attachment has no file_id/toolCallId');
  }

  const text = typeof message.text === 'string' ? message.text : '';
  const parts = [];
  if (text.trim()) {
    parts.push({ type: 'text', text });
  }
  parts.push({
    type: 'tool_call',
    tool_call: {
      id: toolCallId,
      name: 'Bash',
      args: JSON.stringify({
        action: 'deterministic_office_ppt_fallback',
        filename: file.filename || file.name || 'generated.pptx',
      }),
      type: 'tool_call',
      progress: 1,
      output: `Generated file: ${file.filename || file.name || file.file_id}`,
    },
  });
  return parts;
};

const message = db.messages.findOne({ conversationId, messageId });
if (!message) {
  throw new Error(`Message not found: ${conversationId}/${messageId}`);
}

if (Array.isArray(message.content) && message.content.length > 0) {
  printjson({
    matched: 1,
    updated: 0,
    reason: 'message already has content',
    conversationId,
    messageId,
  });
  quit(0);
}

const attachments = Array.isArray(message.attachments) ? message.attachments : [];
const files = Array.isArray(message.files) ? message.files : [];
const candidate = attachments.find(isDownloadableAttachment) || files.find(isDownloadableAttachment);

if (!candidate) {
  throw new Error(`No downloadable generated attachment found: ${conversationId}/${messageId}`);
}

const toolCallId = getToolCallId(candidate);
const nextAttachments = attachments.map((file) =>
  file && file.file_id === candidate.file_id ? { ...file, toolCallId } : file,
);
const nextFiles = files.map((file) =>
  file && file.file_id === candidate.file_id ? { ...file, toolCallId } : file,
);

const update = {
  content: buildContent(message, { ...candidate, toolCallId }),
};
if (nextAttachments.length > 0) {
  update.attachments = nextAttachments;
}
if (nextFiles.length > 0) {
  update.files = nextFiles;
}

const result = db.messages.updateOne({ _id: message._id }, { $set: update });
db.files.updateOne({ file_id: candidate.file_id }, { $set: { toolCallId } });

printjson({
  matched: result.matchedCount,
  updated: result.modifiedCount,
  conversationId,
  messageId,
  file_id: candidate.file_id,
  filename: candidate.filename || candidate.name,
  toolCallId,
  contentTypes: update.content.map((part) => part.type),
});

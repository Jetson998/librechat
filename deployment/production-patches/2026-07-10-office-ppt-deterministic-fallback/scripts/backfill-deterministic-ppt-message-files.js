// mongosh script. Backfills generated deterministic PPT attachments into
// message.files so the LibreChat frontend renders a normal download card.
//
// Usage:
//   LIBRECHAT_CID=<conversationId> \
//   LIBRECHAT_MESSAGE_ID=<assistantMessageId> \
//   mongosh --quiet LibreChat scripts/backfill-deterministic-ppt-message-files.js

const env = typeof process !== 'undefined' && process.env ? process.env : {};
const conversationId = env.LIBRECHAT_CID;
const messageId = env.LIBRECHAT_MESSAGE_ID;

if (!conversationId || !messageId) {
  throw new Error('LIBRECHAT_CID and LIBRECHAT_MESSAGE_ID are required');
}

const message = db.messages.findOne({ conversationId, messageId });
if (!message) {
  throw new Error(`Message not found: ${conversationId} / ${messageId}`);
}

const attachments = Array.isArray(message.attachments) ? message.attachments : [];
const pptAttachments = attachments.filter((file) => {
  const filename = String(file?.filename || '');
  const type = String(file?.type || '');
  return (
    file?.file_id &&
    (/\.pptx?$/i.test(filename) ||
      type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      type === 'application/vnd.ms-powerpoint')
  );
});

if (pptAttachments.length === 0) {
  throw new Error(`No PPT attachment found on message ${messageId}`);
}

const files = Array.isArray(message.files) ? message.files.slice() : [];
const existingFileIds = new Set(files.map((file) => file?.file_id).filter(Boolean));
const additions = pptAttachments.filter((file) => !existingFileIds.has(file.file_id));

if (additions.length === 0) {
  printjson({
    ok: true,
    action: 'noop',
    conversationId,
    messageId,
    filesCount: files.length,
  });
} else {
  const nextFiles = files.concat(additions);
  const result = db.messages.updateOne(
    { _id: message._id },
    {
      $set: {
        files: nextFiles,
        updatedAt: new Date(),
      },
    },
  );
  printjson({
    ok: result.acknowledged,
    action: 'updated',
    conversationId,
    messageId,
    addedFileIds: additions.map((file) => file.file_id),
    filesCount: nextFiles.length,
  });
}

// mongosh script. Backfills downloadable assistant attachments into
// message.files so the LibreChat frontend renders normal download cards.
//
// Usage:
//   LIBRECHAT_CID=<conversationId> \
//   LIBRECHAT_MESSAGE_ID=<assistantMessageId> \
//   mongosh --quiet LibreChat scripts/backfill-generated-attachment-files.js

const env = typeof process !== 'undefined' && process.env ? process.env : {};
const conversationId = env.LIBRECHAT_CID;
const messageId = env.LIBRECHAT_MESSAGE_ID;
const displayOnlyAttachmentTypes = new Set(['file_search', 'web_search', 'ui_resources', 'memory']);

if (!conversationId || !messageId) {
  throw new Error('LIBRECHAT_CID and LIBRECHAT_MESSAGE_ID are required');
}

const isDownloadableAttachment = (file) =>
  Boolean(
    file?.file_id &&
      !displayOnlyAttachmentTypes.has(file.type) &&
      (file.filename || file.name || file.filepath),
  );

const message = db.messages.findOne({ conversationId, messageId });
if (!message) {
  throw new Error(`Message not found: ${conversationId} / ${messageId}`);
}

const attachments = Array.isArray(message.attachments) ? message.attachments : [];
const downloadableAttachments = attachments.filter(isDownloadableAttachment);
if (downloadableAttachments.length === 0) {
  throw new Error(`No downloadable attachment found on message ${messageId}`);
}

const files = Array.isArray(message.files) ? message.files.slice() : [];
const existingFileIds = new Set(files.map((file) => file?.file_id).filter(Boolean));
const additions = downloadableAttachments.filter((file) => !existingFileIds.has(file.file_id));

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
    filenames: additions.map((file) => file.filename || file.name || file.file_id),
    filesCount: nextFiles.length,
  });
}

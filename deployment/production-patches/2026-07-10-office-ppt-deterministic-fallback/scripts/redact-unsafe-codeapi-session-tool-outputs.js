// mongosh script. Redacts unsafe CodeAPI global-session enumeration from saved
// tool calls so old conversations stop carrying large cross-session listings.
//
// Usage:
//   LIBRECHAT_CID=<conversationId> \
//   [LIBRECHAT_MESSAGE_ID=<assistantMessageId>] \
//   mongosh --quiet LibreChat scripts/redact-unsafe-codeapi-session-tool-outputs.js

const env = typeof process !== 'undefined' && process.env ? process.env : {};
const conversationId = env.LIBRECHAT_CID;
const messageId = env.LIBRECHAT_MESSAGE_ID;

if (!conversationId) {
  throw new Error('LIBRECHAT_CID is required');
}

const unsafePathRe =
  /\/srv\/codeapi-data(?:\/sessions)?|\/codeapi-data\/sessions|(?:^|[\s"'`/])sess_[a-f0-9]{16,}(?:[\s"'`/]|$)/i;
const unsafeEnumRe =
  /\b(?:find|tree)\s+(?:-[^\s]+\s+)*\/(?:\s|$)|\b(?:find|tree)\s+(?:-[^\s]+\s+)*\/(?:srv|var|home|root|opt|mnt)(?:\s|\/|$)|\bls\s+(?:-[A-Za-z0-9]+\s+)*\/srv(?:\s|\/|$)/i;
const redactedOutput =
  '[redacted by LibreChat storage guard: unsafe CodeAPI global session enumeration output removed]';
const redactedArgs =
  '[redacted by LibreChat storage guard: unsafe CodeAPI global session enumeration command removed]';

const shouldRedact = (value) => {
  if (typeof value !== 'string') {
    return false;
  }
  return unsafePathRe.test(value) || unsafeEnumRe.test(value);
};

const redactToolCall = (toolCall) => {
  let changed = false;
  if (toolCall && typeof toolCall === 'object') {
    if (shouldRedact(toolCall.output)) {
      toolCall.output = redactedOutput;
      changed = true;
    }
    if (shouldRedact(toolCall.args)) {
      toolCall.args = redactedArgs;
      changed = true;
    }
    if (toolCall.function && typeof toolCall.function === 'object') {
      if (shouldRedact(toolCall.function.output)) {
        toolCall.function.output = redactedOutput;
        changed = true;
      }
      if (shouldRedact(toolCall.function.arguments)) {
        toolCall.function.arguments = redactedArgs;
        changed = true;
      }
    }
  }
  return changed;
};

const redactContentPart = (part) => {
  if (!part || part.type !== 'tool_call') {
    return false;
  }
  if (typeof part.tool_call === 'string') {
    try {
      const parsed = JSON.parse(part.tool_call);
      if (!redactToolCall(parsed)) {
        return false;
      }
      part.tool_call = JSON.stringify(parsed);
      return true;
    } catch {
      if (!shouldRedact(part.tool_call)) {
        return false;
      }
      part.tool_call = redactedOutput;
      return true;
    }
  }
  return redactToolCall(part.tool_call);
};

const query = { conversationId };
if (messageId) {
  query.messageId = messageId;
}

const messages = db.messages.find(query).toArray();
let updatedMessages = 0;
let redactedParts = 0;

for (const message of messages) {
  const content = Array.isArray(message.content) ? message.content : [];
  let changed = false;
  for (const part of content) {
    if (redactContentPart(part)) {
      changed = true;
      redactedParts += 1;
    }
  }
  if (!changed) {
    continue;
  }
  db.messages.updateOne(
    { _id: message._id },
    {
      $set: {
        content,
        updatedAt: new Date(),
      },
    },
  );
  updatedMessages += 1;
}

printjson({
  ok: true,
  conversationId,
  messageId: messageId || null,
  scannedMessages: messages.length,
  updatedMessages,
  redactedParts,
});

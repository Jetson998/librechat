const compactObject = (value) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

const validCreatedAt = (value) => {
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const persistInitializationFailure = async ({
  req,
  userId,
  conversationId,
  isNewConvo,
  endpointOption,
  endpointIconURL,
  responseModel,
  preliminaryUserMessage,
  preliminaryResponseMessageId,
  error,
  saveMessage,
  saveConvo,
}) => {
  if (!preliminaryUserMessage?.messageId || !preliminaryResponseMessageId) {
    throw new Error('Cannot persist initialization failure without preliminary message IDs.');
  }

  const errorText = error?.message || 'Failed to initialize the Agent request.';
  const reqCtx = {
    userId,
    isTemporary: req?.body?.isTemporary,
    interfaceConfig: req?.config?.interfaceConfig,
  };
  const agentId = endpointOption?.agent_id ?? req?.body?.agent_id;
  const userMessage = {
    ...preliminaryUserMessage,
    sender: 'User',
    isCreatedByUser: true,
    user: userId,
  };
  const responseMessage = compactObject({
    messageId: preliminaryResponseMessageId,
    conversationId,
    parentMessageId: preliminaryUserMessage.messageId,
    sender: endpointOption?.modelLabel || 'AI',
    text: errorText,
    content: [{ type: 'text', text: errorText }],
    error: true,
    unfinished: false,
    isCreatedByUser: false,
    finish_reason: 'error',
    endpoint: endpointOption?.endpoint,
    iconURL: endpointIconURL,
    model: responseModel,
    agent_id: agentId,
    user: userId,
  });

  const savedUserMessage = await saveMessage(reqCtx, userMessage, {
    context: 'api/server/controllers/agents/request.js - initialization failure user message',
  });
  const savedResponseMessage = await saveMessage(reqCtx, responseMessage, {
    context: 'api/server/controllers/agents/request.js - initialization failure response',
  });

  const conversationFields = compactObject({
    conversationId,
    endpoint: endpointOption?.endpoint,
    title: isNewConvo ? 'New Chat' : undefined,
    iconURL: endpointIconURL,
    model: responseModel,
    spec: endpointOption?.spec,
    agent_id: agentId,
  });
  const savedConversation = await saveConvo(reqCtx, conversationFields, {
    context: 'api/server/controllers/agents/request.js - initialization failure conversation',
    createdAtOnInsert: validCreatedAt(req?.conversationCreatedAt),
  });
  const conversationPersisted = savedConversation?.conversationId === conversationId;

  return {
    conversation: conversationPersisted ? savedConversation : conversationFields,
    conversationPersisted,
    userMessage: savedUserMessage ?? userMessage,
    responseMessage: savedResponseMessage ?? responseMessage,
  };
};

module.exports = {
  persistInitializationFailure,
};

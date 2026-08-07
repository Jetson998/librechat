const compactObject = (value) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

const validCreatedAt = (value) => {
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const EMPTY_MODEL_RESPONSE_CODE = 'EMPTY_MODEL_RESPONSE';
const EMPTY_MODEL_RESPONSE_USER_MESSAGE =
  '模型没有返回可用内容，请重新生成；如果仍然失败，请选择其他模型。';

const getFailureText = (error) => {
  if (error?.code === EMPTY_MODEL_RESPONSE_CODE) {
    return EMPTY_MODEL_RESPONSE_USER_MESSAGE;
  }

  const rawMessage = typeof error?.message === 'string' ? error.message : '';
  if (!rawMessage) {
    return '模型请求失败，请重新生成或选择其他模型。';
  }

  try {
    const parsed = JSON.parse(rawMessage);
    if (parsed?.type === EMPTY_MODEL_RESPONSE_CODE) {
      return EMPTY_MODEL_RESPONSE_USER_MESSAGE;
    }
    if (typeof parsed?.message === 'string' && parsed.message.length > 0) {
      return parsed.message.slice(0, 1000);
    }
  } catch {
    // Keep the existing provider error text for non-JSON failures.
  }

  return rawMessage.slice(0, 1000);
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

  const errorText = getFailureText(error);
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

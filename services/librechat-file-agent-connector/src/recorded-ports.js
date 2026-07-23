import { clone, sha256 } from './stable.js';

export class RecordedLibreChatPorts {
  constructor() {
    this.transactions = new Map();
    this.files = new Map();
    this.messages = new Map();
    this.finalEvents = new Map();
    this.completedJobs = new Set();
    this.progress = [];
    this.operations = [];
  }

  async writeUsageTransactions({ usageEventId, usage, delivery }) {
    const promptId = sha256(`${usageEventId}:prompt`);
    const completionId = sha256(`${usageEventId}:completion`);
    if (!this.transactions.has(promptId)) {
      this.transactions.set(promptId, {
        transactionId: promptId,
        tokenType: 'prompt',
        inputTokens: usage.inputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        conversationId: delivery.conversationId,
        messageId: delivery.assistantMessageId,
        billingSnapshotRef: delivery.billingSnapshotRef,
      });
      this.operations.push(`transaction:prompt:${usageEventId}`);
    }
    if (!this.transactions.has(completionId)) {
      this.transactions.set(completionId, {
        transactionId: completionId,
        tokenType: 'completion',
        outputTokens: usage.outputTokens,
        conversationId: delivery.conversationId,
        messageId: delivery.assistantMessageId,
        billingSnapshotRef: delivery.billingSnapshotRef,
      });
      this.operations.push(`transaction:completion:${usageEventId}`);
    }
    return { promptId, completionId };
  }

  async processCodeOutput({ artifactId, artifact, delivery }) {
    const claim = sha256([
      delivery.conversationId,
      delivery.assistantMessageId,
      artifactId,
      artifact.name,
    ].join(':'));
    if (!this.files.has(claim)) {
      this.files.set(claim, {
        fileId: `file_${claim.slice(0, 24)}`,
        artifactId,
        name: artifact.name,
        mimeType: artifact.mimeType,
        codeEnvRef: clone(artifact.codeEnvRef),
        conversationId: delivery.conversationId,
        messageId: delivery.assistantMessageId,
        toolCallId: `file-agent:${artifactId}`,
      });
      this.operations.push(`artifact:${artifactId}`);
    }
    return clone(this.files.get(claim));
  }

  async saveAssistantMessage({ delivery, text, fileIds }) {
    const existing = this.messages.get(delivery.assistantMessageId);
    if (existing) {
      return clone(existing);
    }
    this.messages.set(delivery.assistantMessageId, {
      messageId: delivery.assistantMessageId,
      conversationId: delivery.conversationId,
      text,
      fileIds: [...fileIds],
    });
    this.operations.push('message:saved');
    return clone(this.messages.get(delivery.assistantMessageId));
  }

  async saveNeedsInput({ delivery, question }) {
    const existing = this.messages.get(delivery.assistantMessageId);
    if (existing?.needsInput === true && existing.text === question) {
      return clone(existing);
    }
    this.messages.set(delivery.assistantMessageId, {
      messageId: delivery.assistantMessageId,
      conversationId: delivery.conversationId,
      text: question,
      fileIds: [],
      needsInput: true,
    });
    this.operations.push('message:needs_input');
    return clone(this.messages.get(delivery.assistantMessageId));
  }

  async saveTerminalMessage({ delivery, status, message }) {
    const existing = this.messages.get(delivery.assistantMessageId);
    if (existing?.status === status && existing.text === message) {
      return clone(existing);
    }
    this.messages.set(delivery.assistantMessageId, {
      messageId: delivery.assistantMessageId,
      conversationId: delivery.conversationId,
      text: message,
      fileIds: [],
      status,
    });
    this.operations.push(`message:${status}`);
    return clone(this.messages.get(delivery.assistantMessageId));
  }

  async emitDone({ delivery, payload }) {
    if (!this.finalEvents.has(delivery.streamId)) {
      this.finalEvents.set(delivery.streamId, clone(payload));
      this.operations.push('final:emitted');
    }
  }

  async completeJob({ delivery }) {
    if (!this.completedJobs.has(delivery.streamId)) {
      this.completedJobs.add(delivery.streamId);
      this.operations.push('job:completed');
    }
  }

  async updateProgress({ delivery, event }) {
    this.progress.push({ deliveryId: delivery.deliveryId, type: event.type, phase: event.phase });
  }
}

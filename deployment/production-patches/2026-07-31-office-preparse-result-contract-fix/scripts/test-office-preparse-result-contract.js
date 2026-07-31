const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');
const path = require('path');

const patchRoot = path.resolve(__dirname, '..');
const officePreparsePath = path.join(
  patchRoot,
  'office-context-patch/OfficePreparse.js',
);
const requestControllerPath = path.join(patchRoot, 'office-context-patch/request.js');

const currentFile = {
  file_id: 'mongo-current',
  filename: 'current.xlsx',
};
const currentPrimed = {
  id: 'code-current',
  source_file_id: 'mongo-current',
  storage_session_id: 'session-current',
  name: 'current.xlsx',
};

const createOfficeHarness = (invoke, debug = () => {}) => {
  const office = require(officePreparsePath);
  const { prepareCurrentTurnOfficeContext } = office.createOfficePreparse({
    createBashExecutionTool: () => ({ invoke }),
    getCodeApiAuthHeaders: async () => ({ Authorization: 'Bearer test' }),
    logger: { debug },
  });
  return { ...office, prepareCurrentTurnOfficeContext };
};

const testManifestBoundaryAcceptsWrapperStderr = async () => {
  const debugEntries = [];
  const manifest = {
    files: [
      {
        filename: 'current.xlsx',
        ok: true,
        kind: 'spreadsheet',
        preview: 'literal { brace }, escaped quote " and marker __LIBRECHAT_OFFICE_MANIFEST__',
      },
    ],
  };
  let office;
  office = createOfficeHarness(
    async () => ({
      content: [
        { text: `stdout:\n${office.MANIFEST_MARKER}${JSON.stringify(manifest)}` },
        {
          text:
            'stderr:\n/usr/local/lib/python3.11/site-packages/openpyxl/styles/stylesheet.py:237: ' +
            "UserWarning: Workbook contains no default style, apply openpyxl's default",
        },
      ],
    }),
    (...args) => debugEntries.push(args),
  );

  const context = await office.prepareCurrentTurnOfficeContext({
    req: {},
    requestFiles: [currentFile],
    primedCodeFiles: [currentPrimed],
  });

  assert(context.includes('<office_preparse_manifest>'));
  assert(context.includes('literal { brace }'));
  assert(!JSON.stringify(debugEntries).includes('Workbook contains no default style'));
  assert(
    debugEntries.some(
      ([message, details]) =>
        message.includes('ignored non-manifest') &&
        details.trailingKind === 'tool-wrapper' &&
        details.contentPartCount === 2,
    ),
  );
};

const testManifestBoundaryContracts = () => {
  const office = createOfficeHarness(async () => 'unused');
  const manifest = {
    files: [{ filename: 'current.xlsx', ok: true, preview: 'line 1\nline 2 {x}' }],
  };
  const serialized = JSON.stringify(manifest);

  const generatedFiles = office.parseManifestFromToolContent(
    `${office.MANIFEST_MARKER}${serialized}\n\nGenerated files:\n- /mnt/data/report.txt`,
  );
  assert.deepStrictEqual(generatedFiles.manifest, manifest);
  assert.strictEqual(generatedFiles.trailingKind, 'tool-wrapper');

  const directWarning = office.parseManifestFromToolContent(
    `${office.MANIFEST_MARKER}${serialized}\n/usr/local/example.py:17:\nUserWarning: warning text`,
  );
  assert.strictEqual(directWarning.trailingKind, 'runtime-warning');

  assert.throws(
    () =>
      office.parseManifestFromToolContent(
        `${office.MANIFEST_MARKER}${serialized}\n${office.MANIFEST_MARKER}${serialized}`,
      ),
    /more than one manifest marker/,
  );
  assert.throws(
    () => office.parseManifestFromToolContent(`${office.MANIFEST_MARKER}${serialized}\nsecond json`),
    /unexpected tool output/,
  );
  assert.throws(
    () => office.parseManifestFromToolContent(`${office.MANIFEST_MARKER}{"files":[`),
    /incomplete/,
  );
};

const createResponse = () => {
  const res = new EventEmitter();
  res.headersSent = false;
  res.statusCodes = [];
  res.jsonBodies = [];
  res.status = (code) => {
    res.statusCodes.push(code);
    return res;
  };
  res.json = (body) => {
    res.headersSent = true;
    res.jsonBodies.push(body);
    return res;
  };
  return res;
};

const loadControllerHarness = () => {
  const savedMessages = [];
  const conversations = new Map();
  const emittedDone = [];
  const emittedErrors = [];
  const completedJobs = [];
  const metadataUpdates = [];
  let initializeCalls = 0;

  const models = {
    saveMessage: async (_reqCtx, message) => {
      const saved = { ...message };
      const index = savedMessages.findIndex(
        (item) => item.messageId === saved.messageId && item.conversationId === saved.conversationId,
      );
      if (index >= 0) savedMessages[index] = saved;
      else savedMessages.push(saved);
      return saved;
    },
    saveConvo: async (_reqCtx, conversation) => {
      const saved = {
        ...(conversations.get(conversation.conversationId) ?? {}),
        ...conversation,
      };
      conversations.set(saved.conversationId, saved);
      return saved;
    },
    getMessages: async (filter) =>
      savedMessages.filter(
        (message) =>
          (!filter.user || message.user === filter.user) &&
          (!filter.messageId || message.messageId === filter.messageId) &&
          (!filter.conversationId || message.conversationId === filter.conversationId),
      ),
    getConvo: async (_userId, conversationId) => conversations.get(conversationId) ?? null,
  };

  const generationJobManager = {
    createJob: async () => ({
      createdAt: Date.now(),
      readyPromise: Promise.resolve(),
      abortController: new AbortController(),
      emitter: new EventEmitter(),
    }),
    updateMetadata: async (...args) => metadataUpdates.push(args),
    emitDone: async (...args) => emittedDone.push(args),
    emitError: async (...args) => emittedErrors.push(args),
    completeJob: (...args) => completedJobs.push(args),
    getResumeState: async () => null,
  };

  const mocks = {
    '@librechat/data-schemas': {
      logger: { debug: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    },
    'librechat-data-provider': {
      Constants: { NO_PARENT: '00000000-0000-0000-0000-000000000000' },
      ViolationTypes: { CONCURRENT: 'concurrent' },
      isEphemeralAgentId: () => false,
    },
    '@librechat/api': {
      sendEvent: () => {},
      getViolationInfo: () => ({}),
      buildMessageFiles: () => [],
      getReferencedQuotes: (quotes) => quotes,
      resolveTitleTiming: () => 'immediate',
      GenerationJobManager: generationJobManager,
      filterPersistableAbortContent: (content) => content,
      decrementPendingRequest: async () => {},
      sanitizeMessageForTransmit: (message) => message,
      checkAndIncrementPendingRequest: async () => ({ allowed: true }),
      isUnpersistedPreliminaryParent: async ({
        userId,
        conversationId,
        parentMessageId,
        getMessages,
      }) => {
        if (typeof parentMessageId !== 'string' || !parentMessageId.endsWith('_')) return false;
        const found = await getMessages(
          { user: userId, conversationId, messageId: parentMessageId },
          '_id',
        );
        return found.length === 0;
      },
    },
    '~/server/cleanup': {
      disposeClient: () => {},
      clientRegistry: null,
      requestDataMap: new WeakMap(),
    },
    '~/server/services/MCPRequestContext': {
      getMCPRequestContext: () => ({}),
      cleanupMCPRequestContextForReq: async () => {},
    },
    '~/server/middleware': { handleAbortError: async () => {} },
    '~/cache': { logViolation: async () => {} },
    '~/models': models,
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[requestControllerPath];
  const controller = require(requestControllerPath);
  Module._load = originalLoad;

  const initializeClient = async () => {
    initializeCalls += 1;
    throw new Error('Office pre-parse returned an invalid manifest: test failure');
  };

  return {
    controller,
    initializeClient,
    savedMessages,
    conversations,
    emittedDone,
    emittedErrors,
    completedJobs,
    metadataUpdates,
    get initializeCalls() {
      return initializeCalls;
    },
  };
};

const createRequest = ({ conversationId, messageId, parentMessageId }) => ({
  user: { id: 'user-1' },
  config: {},
  body: {
    conversationId,
    messageId,
    parentMessageId,
    text: 'Analyze the uploaded workbook.',
    files: [{ file_id: 'mongo-current', filename: 'current.xlsx' }],
    endpointOption: {
      endpoint: 'agents',
      agent_id: 'agent-audit',
      modelLabel: 'Audit Agent',
      modelOptions: { model: 'gpt-test' },
    },
  },
});

const testInitializationFailureBecomesTerminalParent = async () => {
  const harness = loadControllerHarness();
  const firstResponse = createResponse();
  await harness.controller(
    createRequest({
      conversationId: 'new',
      messageId: 'user-message-1',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
    }),
    firstResponse,
    () => {},
    harness.initializeClient,
    null,
  );

  const conversationId = firstResponse.jsonBodies[0].conversationId;
  const terminalResponse = harness.savedMessages.find(
    (message) => message.messageId === 'user-message-1_',
  );
  assert(terminalResponse, 'terminal preliminary response was not saved');
  assert.strictEqual(terminalResponse.error, true);
  assert.strictEqual(terminalResponse.unfinished, false);
  assert.strictEqual(terminalResponse.parentMessageId, 'user-message-1');
  assert.deepStrictEqual(terminalResponse.content, [
    {
      type: 'text',
      text: 'Office pre-parse returned an invalid manifest: test failure',
    },
  ]);
  assert(harness.conversations.has(conversationId), 'new conversation was not saved');
  assert.strictEqual(harness.emittedDone.length, 1);
  assert.strictEqual(harness.emittedErrors.length, 0);
  assert.deepStrictEqual(harness.completedJobs[0], [conversationId]);

  harness.conversations.set(conversationId, {
    ...harness.conversations.get(conversationId),
    title: 'Existing audit conversation',
  });
  const followUpResponse = createResponse();
  await harness.controller(
    createRequest({
      conversationId,
      messageId: 'user-message-2',
      parentMessageId: 'user-message-1_',
    }),
    followUpResponse,
    () => {},
    harness.initializeClient,
    null,
  );

  assert(!followUpResponse.statusCodes.includes(409));
  assert.strictEqual(harness.initializeCalls, 2);
  assert.strictEqual(
    harness.conversations.get(conversationId).title,
    'Existing audit conversation',
  );
  assert(
    harness.savedMessages.some((message) => message.messageId === 'user-message-2_'),
    'follow-up did not pass the preliminary-parent guard',
  );
};

Promise.resolve()
  .then(testManifestBoundaryAcceptsWrapperStderr)
  .then(testManifestBoundaryContracts)
  .then(testInitializationFailureBecomesTerminalParent)
  .then(() => process.stdout.write('office preparse result contract tests passed\n'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

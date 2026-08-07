const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');

const RETENTION_DAYS = 14;
const MAX_QUEUE_DEPTH = 256;
const MAX_CONCURRENT_WRITES = 4;
const MAX_QUERY_LIMIT = 100;
const MAX_CURSOR_LENGTH = 256;
const MAX_ID_LENGTH = 256;
const QUEUE_OVERFLOW_WARNING_INTERVAL_MS = 10_000;

const LEVELS = new Set(['error', 'warning', 'info']);
const STAGES = new Set(['request', 'office_preparse', 'generation', 'followup']);
const LOOKUP_FIELDS = [
  'requestId',
  'conversationId',
  'streamId',
  'messageId',
  'event',
  'errorCode',
];
const RESPONSE_SHAPE_KINDS = new Set(['array', 'object', 'string', 'number', 'boolean', 'undefined']);
const RESPONSE_SHAPE_PART_TYPE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const RESPONSE_SHAPE_PART_TYPE_LIMIT = 16;
const RESPONSE_SHAPE_TEXT_LIMIT = 1_000_000;
const RESPONSE_SHAPE_PART_TYPES = new Set([
  'text',
  'think',
  'text_delta',
  'tool_call',
  'image_file',
  'image_url',
  'video_url',
  'input_audio',
  'agent_update',
  'summary',
  'error',
]);
const RESPONSE_SHAPE_METADATA_KEYS = new Set([
  'id',
  'model',
  'type',
  'status',
  'finish_reason',
  'stop_reason',
  'usage',
  'provider',
]);
const RESPONSE_SHAPE_RESPONSE_FIELDS = new Set([
  'text',
  'content',
  'summary',
  'files',
  'attachments',
  'artifact',
  'artifacts',
  'citations',
  'ui_resources',
  'image_urls',
  'images',
  'metadata',
]);

/**
 * The diagnostic store is deliberately an allowlist, rather than a redaction
 * layer over arbitrary Error instances. Error messages, stacks, filenames,
 * prompts, and tool output are all attacker- or user-controlled in practice.
 * Only these static, reviewed summaries may enter MongoDB or diagnostic stdout.
 */
const DIAGNOSTIC_EVENT_DEFINITIONS = Object.freeze({
  office_preparse_manifest_invalid: {
    level: 'error',
    stage: 'office_preparse',
    errorCode: 'OFFICE_PREPARSE_INVALID_MANIFEST',
    errorSummary: 'Office pre-parse manifest is invalid.',
  },
  office_preparse_manifest_missing: {
    level: 'error',
    stage: 'office_preparse',
    errorCode: 'OFFICE_PREPARSE_MANIFEST_MISSING',
    errorSummary: 'Office pre-parse did not return a manifest.',
  },
  office_preparse_manifest_incomplete: {
    level: 'error',
    stage: 'office_preparse',
    errorCode: 'OFFICE_PREPARSE_MANIFEST_INCOMPLETE',
    errorSummary: 'Office pre-parse manifest did not cover every selected file.',
  },
  office_preparse_file_failed: {
    level: 'error',
    stage: 'office_preparse',
    errorCode: 'OFFICE_PREPARSE_FILE_FAILED',
    errorSummary: 'Office pre-parse could not process a selected file.',
  },
  office_preparse_timeout: {
    level: 'error',
    stage: 'office_preparse',
    errorCode: 'OFFICE_PREPARSE_TIMEOUT',
    errorSummary: 'Office pre-parse timed out.',
  },
  office_preparse_aborted: {
    level: 'warning',
    stage: 'office_preparse',
    errorCode: 'OFFICE_PREPARSE_ABORTED',
    errorSummary: 'Office pre-parse was aborted.',
  },
  office_preparse_file_reference_missing: {
    level: 'error',
    stage: 'office_preparse',
    errorCode: 'OFFICE_PREPARSE_FILE_REFERENCE_MISSING',
    errorSummary: 'Office pre-parse could not resolve a stable file reference.',
  },
  office_preparse_file_reference_ambiguous: {
    level: 'error',
    stage: 'office_preparse',
    errorCode: 'OFFICE_PREPARSE_FILE_REFERENCE_AMBIGUOUS',
    errorSummary: 'Office pre-parse found multiple stable file references.',
  },
  office_preparse_tool_failed: {
    level: 'error',
    stage: 'office_preparse',
    errorCode: 'OFFICE_PREPARSE_TOOL_FAILED',
    errorSummary: 'Office pre-parse tool execution failed.',
  },
  office_preparse_failed: {
    level: 'error',
    stage: 'office_preparse',
    errorCode: 'OFFICE_PREPARSE_FAILED',
    errorSummary: 'Office pre-parse failed.',
  },
  generation_initialization_failed: {
    level: 'error',
    stage: 'generation',
    errorCode: 'GENERATION_INITIALIZATION_FAILED',
    errorSummary: 'Generation initialization failed.',
  },
  generation_failed: {
    level: 'error',
    stage: 'generation',
    errorCode: 'GENERATION_FAILED',
    errorSummary: 'Generation failed.',
  },
  followup_rejected_parent_saving: {
    level: 'warning',
    stage: 'followup',
    errorCode: 'FOLLOWUP_REJECTED_PARENT_SAVING',
    errorSummary: 'Follow-up was rejected because the parent response is still saving.',
  },
});

const diagnosticEventSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, required: true, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
    level: { type: String, enum: [...LEVELS], required: true, immutable: true },
    event: { type: String, required: true, immutable: true },
    stage: { type: String, enum: [...STAGES], required: true, immutable: true },
    tenantId: { type: String, required: false, immutable: true },
    requestId: { type: String, required: false, immutable: true },
    userIdHash: { type: String, required: false, immutable: true },
    conversationId: { type: String, required: false, immutable: true },
    streamId: { type: String, required: false, immutable: true },
    messageId: { type: String, required: false, immutable: true },
    model: { type: String, required: false, immutable: true },
    errorCode: { type: String, required: false, immutable: true },
    errorSummary: { type: String, required: false, immutable: true },
    responseShape: {
      completionKind: { type: String, required: false, immutable: true },
      completionParts: { type: Number, required: false, immutable: true },
      completionPartTypes: { type: [String], required: false, immutable: true },
      textLength: { type: Number, required: false, immutable: true },
      nonBlankTextParts: { type: Number, required: false, immutable: true },
      metadataKind: { type: String, required: false, immutable: true },
      metadataKeys: { type: [String], required: false, immutable: true },
      responseFields: { type: [String], required: false, immutable: true },
    },
    durationMs: { type: Number, required: false, immutable: true },
    release: { type: String, required: false, immutable: true },
  },
  {
    collection: 'diagnostic_events',
    versionKey: false,
  },
);

// Every list query is tenant-scoped and sorted by this pair. Exact lookup
// fields come before the sort keys so MongoDB can service cursor pages from
// the corresponding compound index without a collection-wide text scan.
diagnosticEventSchema.index({ tenantId: 1, timestamp: -1, _id: -1 });
diagnosticEventSchema.index({ tenantId: 1, level: 1, timestamp: -1, _id: -1 });
diagnosticEventSchema.index({ tenantId: 1, stage: 1, timestamp: -1, _id: -1 });
diagnosticEventSchema.index({ tenantId: 1, conversationId: 1, timestamp: -1, _id: -1 });
diagnosticEventSchema.index({ tenantId: 1, streamId: 1, timestamp: -1, _id: -1 });
diagnosticEventSchema.index({ tenantId: 1, requestId: 1, timestamp: -1, _id: -1 });
diagnosticEventSchema.index({ tenantId: 1, messageId: 1, timestamp: -1, _id: -1 });
diagnosticEventSchema.index({ tenantId: 1, event: 1, timestamp: -1, _id: -1 });
diagnosticEventSchema.index({ tenantId: 1, errorCode: 1, timestamp: -1, _id: -1 });
diagnosticEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const getDiagnosticEventModel = () =>
  mongoose.models.DiagnosticEvent ||
  mongoose.model('DiagnosticEvent', diagnosticEventSchema, 'diagnostic_events');

let indexPromise;
let pendingWrites = 0;
let activeWrites = 0;
let drainScheduled = false;
let droppedWrites = 0;
let lastReportedDroppedWrites = 0;
let lastQueueOverflowWarningAt = 0;
const writeQueue = [];

function boundedOpaqueId(value, max = MAX_ID_LENGTH) {
  if (value == null) return undefined;
  const text = String(value).trim();
  if (!text || text.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(text)) {
    return undefined;
  }
  return text;
}

function boundedModel(value) {
  if (value == null) return undefined;
  const text = String(value).trim();
  if (!text || text.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(text)) {
    return undefined;
  }
  return text;
}

function boundedResponseShapeList(value, allowlist = RESPONSE_SHAPE_PART_TYPES) {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .filter(
      (item) =>
        typeof item === 'string' &&
        RESPONSE_SHAPE_PART_TYPE_RE.test(item) &&
        (allowlist == null || allowlist.has(item)),
    )
    .slice(0, RESPONSE_SHAPE_PART_TYPE_LIMIT);
  return result.length > 0 ? [...new Set(result)] : undefined;
}

function normalizeResponseShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const shape = {};
  if (RESPONSE_SHAPE_KINDS.has(value.completionKind)) {
    shape.completionKind = value.completionKind;
  }
  if (Number.isFinite(Number(value.completionParts))) {
    shape.completionParts = Math.max(0, Math.min(Math.floor(Number(value.completionParts)), 64));
  }
  const completionPartTypes = boundedResponseShapeList(value.completionPartTypes);
  if (completionPartTypes) shape.completionPartTypes = completionPartTypes;
  if (Number.isFinite(Number(value.textLength))) {
    shape.textLength = Math.max(0, Math.min(Math.floor(Number(value.textLength)), RESPONSE_SHAPE_TEXT_LIMIT));
  }
  if (Number.isFinite(Number(value.nonBlankTextParts))) {
    shape.nonBlankTextParts = Math.max(0, Math.min(Math.floor(Number(value.nonBlankTextParts)), 64));
  }
  if (RESPONSE_SHAPE_KINDS.has(value.metadataKind)) {
    shape.metadataKind = value.metadataKind;
  }
  const metadataKeys = boundedResponseShapeList(value.metadataKeys, RESPONSE_SHAPE_METADATA_KEYS);
  if (metadataKeys) shape.metadataKeys = metadataKeys;
  const responseFields = boundedResponseShapeList(
    value.responseFields,
    RESPONSE_SHAPE_RESPONSE_FIELDS,
  );
  if (responseFields) shape.responseFields = responseFields;
  return Object.keys(shape).length > 0 ? shape : undefined;
}

function getDiagnosticResponseShape(value) {
  return normalizeResponseShape(value);
}

function hashUserId(userId) {
  if (userId == null || String(userId).trim() === '') return undefined;
  const secret = process.env.DIAGNOSTIC_LOG_HASH_SECRET || process.env.JWT_SECRET;
  if (!secret) return undefined;
  return crypto.createHmac('sha256', secret).update(String(userId)).digest('hex').slice(0, 24);
}

function getRequestId(req) {
  const header = req?.headers?.['x-request-id'] || req?.headers?.['x-correlation-id'];
  return boundedOpaqueId(req?.id || header);
}

function getRelease() {
  return boundedOpaqueId(
    process.env.LIBRECHAT_RELEASE || process.env.RELEASE_SHA || process.env.GIT_COMMIT,
    128,
  );
}

function normalizeDate(value, endOfDay = false) {
  if (!value) return undefined;
  const text = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
    : new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeCursor(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded.timestamp !== 'string' || !mongoose.isValidObjectId(decoded.id)) {
      return undefined;
    }
    const timestamp = new Date(decoded.timestamp);
    if (Number.isNaN(timestamp.getTime())) return undefined;
    return { timestamp, id: new mongoose.Types.ObjectId(decoded.id) };
  } catch {
    return undefined;
  }
}

function encodeCursor(entry) {
  return Buffer.from(
    JSON.stringify({ timestamp: entry.timestamp.toISOString(), id: entry._id.toString() }),
  ).toString('base64url');
}

function requestContext(req, values = {}) {
  const body = req?.body || {};
  return {
    tenantId: boundedOpaqueId(values.tenantId ?? req?.user?.tenantId ?? req?.tenantId),
    requestId: boundedOpaqueId(getRequestId(req)),
    userIdHash: hashUserId(values.userId ?? req?.user?.id),
    conversationId: boundedOpaqueId(values.conversationId ?? body.conversationId),
    streamId: boundedOpaqueId(values.streamId ?? req?._resumableStreamId ?? body.streamId),
    messageId: boundedOpaqueId(values.messageId ?? body.messageId),
    model: boundedModel(values.model ?? body?.endpointOption?.modelOptions?.model),
  };
}

function normalizeDiagnosticEvent(input = {}) {
  const definition = Object.prototype.hasOwnProperty.call(
    DIAGNOSTIC_EVENT_DEFINITIONS,
    input.event,
  )
    ? DIAGNOSTIC_EVENT_DEFINITIONS[input.event]
    : undefined;
  if (!definition) throw new Error('Diagnostic event name is not allowed');

  const now = new Date();
  const context = requestContext(input.req, input);
  const durationValue =
    input.durationMs ??
    (input.req?.diagnosticStartedAt ? Date.now() - input.req.diagnosticStartedAt : undefined);
  const durationMs = Number.isFinite(Number(durationValue))
    ? Math.max(0, Math.min(Math.floor(Number(durationValue)), 86_400_000))
    : undefined;

  return {
    timestamp: now,
    expiresAt: new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000),
    level: definition.level,
    event: input.event,
    stage: definition.stage,
    ...context,
    errorCode: definition.errorCode,
    errorSummary: definition.errorSummary,
    responseShape: normalizeResponseShape(input.responseShape ?? input.error?.responseShape),
    durationMs,
    release: getRelease(),
  };
}

function logStructuredEvent(doc) {
  if (doc.level === 'warning') logger.warn('[diagnostic-event]', doc);
  else if (doc.level === 'info') logger.info('[diagnostic-event]', doc);
  else logger.error('[diagnostic-event]', doc);
}

function ensureIndexes() {
  if (!indexPromise) {
    indexPromise = getDiagnosticEventModel()
      .createIndexes()
      .catch((error) => {
        indexPromise = undefined;
        throw error;
      });
  }
  return indexPromise;
}

function reportQueueOverflow(doc) {
  droppedWrites += 1;
  const now = Date.now();
  if (now - lastQueueOverflowWarningAt < QUEUE_OVERFLOW_WARNING_INTERVAL_MS) return;

  const droppedSinceLastWarning = droppedWrites - lastReportedDroppedWrites;
  lastQueueOverflowWarningAt = now;
  lastReportedDroppedWrites = droppedWrites;
  logger.warn('[diagnostic-event] persistence queue overflow', {
    droppedCount: droppedWrites,
    droppedSinceLastWarning,
    maxQueueDepth: MAX_QUEUE_DEPTH,
    event: doc.event,
    stage: doc.stage,
  });
}

function persistInBackground(doc) {
  if (pendingWrites >= MAX_QUEUE_DEPTH) {
    reportQueueOverflow(doc);
    return false;
  }

  pendingWrites += 1;
  writeQueue.push(doc);
  scheduleDrain();
  return true;
}

function scheduleDrain() {
  if (drainScheduled) return;
  drainScheduled = true;
  setImmediate(() => {
    drainScheduled = false;
    drainQueue();
  });
}

function drainQueue() {
  while (activeWrites < MAX_CONCURRENT_WRITES && writeQueue.length > 0) {
    const doc = writeQueue.shift();
    activeWrites += 1;
    Promise.resolve()
      .then(async () => {
        await ensureIndexes();
        await getDiagnosticEventModel().create(doc);
      })
      .catch(() => {
        logger.error('[diagnostic-event] persistence failed', {
          event: doc.event,
          stage: doc.stage,
          failure: 'database_write_failed',
        });
      })
      .finally(() => {
        activeWrites -= 1;
        pendingWrites -= 1;
        scheduleDrain();
      });
  }
}

function recordDiagnosticEvent(input) {
  let doc;
  try {
    doc = normalizeDiagnosticEvent(input);
  } catch {
    logger.error('[diagnostic-event] rejected invalid event', {
      failure: 'invalid_event_definition',
    });
    return false;
  }
  logStructuredEvent(doc);
  return persistInBackground(doc);
}

function buildFilter(query = {}) {
  // Missing tenant context deliberately means the legacy, unscoped partition;
  // it never means "all tenants". Routes always pass their authenticated scope.
  const filter = { tenantId: boundedOpaqueId(query.tenantId) ?? null };
  const lookup = boundedOpaqueId(query.lookup);
  if (lookup) {
    filter.$or = LOOKUP_FIELDS.map((field) => ({ [field]: lookup }));
  }
  if (LEVELS.has(query.level)) filter.level = query.level;
  if (STAGES.has(query.stage)) filter.stage = query.stage;
  const conversationId = boundedOpaqueId(query.conversationId);
  const streamId = boundedOpaqueId(query.streamId);
  if (conversationId) filter.conversationId = conversationId;
  if (streamId) filter.streamId = streamId;
  const from = normalizeDate(query.from);
  const to = normalizeDate(query.to, true);
  if (from || to) {
    filter.timestamp = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  }
  return filter;
}

function toListEntry(doc) {
  return {
    id: doc._id.toString(),
    timestamp: doc.timestamp.toISOString(),
    level: doc.level,
    event: doc.event,
    stage: doc.stage,
    ...(doc.requestId ? { requestId: doc.requestId } : {}),
    ...(doc.userIdHash ? { userIdHash: doc.userIdHash } : {}),
    ...(doc.conversationId ? { conversationId: doc.conversationId } : {}),
    ...(doc.streamId ? { streamId: doc.streamId } : {}),
    ...(doc.messageId ? { messageId: doc.messageId } : {}),
    ...(doc.model ? { model: doc.model } : {}),
    ...(doc.errorCode ? { errorCode: doc.errorCode } : {}),
    ...(doc.errorSummary ? { errorSummary: doc.errorSummary } : {}),
    ...(doc.durationMs != null ? { durationMs: doc.durationMs } : {}),
    ...(doc.release ? { release: doc.release } : {}),
  };
}

async function listDiagnosticEventPage(query = {}) {
  const DiagnosticEvent = getDiagnosticEventModel();
  const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, Number.parseInt(query.limit, 10) || 50));
  const baseFilter = buildFilter(query);
  const cursor = normalizeCursor(query.cursor);
  const cursorFilter = cursor
    ? {
        $or: [
          { timestamp: { $lt: cursor.timestamp } },
          { timestamp: cursor.timestamp, _id: { $lt: cursor.id } },
        ],
      }
    : null;
  const filter = cursorFilter ? { $and: [baseFilter, cursorFilter] } : baseFilter;
  // Intentionally a single indexed read. The projection also shields list
  // responses from legacy raw fields that might exist in a manually created row.
  const entries = await DiagnosticEvent.find(filter)
    .select('-stack -errorMessage -errorName')
    .sort({ timestamp: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = entries.length > limit;
  const pageEntries = hasMore ? entries.slice(0, limit) : entries;
  return {
    entries: pageEntries.map(toListEntry),
    nextCursor: hasMore ? encodeCursor(pageEntries[pageEntries.length - 1]) : null,
  };
}

async function findDiagnosticEvent(id, scope = {}) {
  if (!mongoose.isValidObjectId(id)) return null;
  const filter = buildFilter({ tenantId: scope.tenantId ?? null });
  const doc = await getDiagnosticEventModel()
    .findOne({ _id: id, ...filter })
    .select('-stack -errorMessage -errorName')
    .lean();
  return doc ? toListEntry(doc) : null;
}

function getDiagnosticEventQueueStats() {
  return {
    pendingWrites,
    activeWrites,
    droppedWrites,
    lastReportedDroppedWrites,
  };
}

function resetDiagnosticEventQueueStats() {
  droppedWrites = 0;
  lastReportedDroppedWrites = 0;
  lastQueueOverflowWarningAt = 0;
}

function createDiagnosticEventMethods() {
  return {
    recordDiagnosticEvent,
    listDiagnosticEventPage,
    findDiagnosticEvent,
    getDiagnosticEventModel,
    buildDiagnosticFilter: buildFilter,
    getDiagnosticEventQueueDepth: () => pendingWrites,
    getDiagnosticEventQueueStats,
  };
}

module.exports = {
  RETENTION_DAYS,
  MAX_QUEUE_DEPTH,
  MAX_CONCURRENT_WRITES,
  QUEUE_OVERFLOW_WARNING_INTERVAL_MS,
  DIAGNOSTIC_EVENT_DEFINITIONS,
  createDiagnosticEventMethods,
  recordDiagnosticEvent,
  listDiagnosticEventPage,
  findDiagnosticEvent,
  requestContext,
  normalizeDiagnosticEvent,
  normalizeResponseShape,
  getDiagnosticResponseShape,
  hashUserId,
  buildDiagnosticFilter: buildFilter,
  getDiagnosticEventQueueDepth: () => pendingWrites,
  getDiagnosticEventQueueStats,
  resetDiagnosticEventQueueStats,
};

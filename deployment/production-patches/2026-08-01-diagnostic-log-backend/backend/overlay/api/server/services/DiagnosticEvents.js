const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');

const RETENTION_DAYS = 14;
const MAX_QUEUE_DEPTH = 256;
const MAX_CONCURRENT_WRITES = 4;
const MAX_QUERY_LIMIT = 100;
const MAX_TEXT_LENGTH = 1000;
const MAX_STACK_LENGTH = 6000;
const MAX_CURSOR_LENGTH = 256;
const MAX_ID_LENGTH = 256;

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
    errorName: { type: String, required: false, immutable: true },
    errorMessage: { type: String, required: false, immutable: true },
    durationMs: { type: Number, required: false, immutable: true },
    release: { type: String, required: false, immutable: true },
    stack: { type: String, required: false, immutable: true },
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
const writeQueue = [];

function boundedText(value, max = MAX_TEXT_LENGTH) {
  if (value == null) return undefined;
  const text = String(value).replace(/[\r\n]+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

function boundedId(value) {
  return boundedText(value, MAX_ID_LENGTH);
}

const SENSITIVE_CREDENTIAL_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|x-api-key|client[_-]?secret|private[_-]?key|credential|credentials|jwt|session[_-]?id)$/i;

function redactStructuredCredentials(value) {
  if (Array.isArray(value)) return value.map(redactStructuredCredentials);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_CREDENTIAL_KEY.test(key) ? '[redacted]' : redactStructuredCredentials(nested),
    ]),
  );
}

function redactCredentialText(value) {
  let text = String(value);
  try {
    text = JSON.stringify(redactStructuredCredentials(JSON.parse(text)));
  } catch {
    // Error text is often a sentence containing an embedded JSON fragment.
    // The targeted replacement below handles that case without parsing user text.
  }

  return text
    .replace(
      /(["'])(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|x-api-key|client[_-]?secret|private[_-]?key|credential|credentials|jwt|session[_-]?id)\1\s*([:=])\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
      (_, quote, key, separator, rawValue) => {
        const valuePlaceholder = rawValue.startsWith('"')
          ? '"[redacted]"'
          : rawValue.startsWith("'")
            ? "'[redacted]'"
            : '[redacted]';
        return `${quote}${key}${quote}${separator}${valuePlaceholder}`;
      },
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, 'Basic [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted-key]');
}

function sanitizeStack(value) {
  if (value == null) return undefined;
  return redactCredentialText(value)
    .replace(
      /(api[-_]?key|token|password|secret|cookie)\s*[:=]\s*[^\s,;]+/gi,
      (_, label) => `${label}=[redacted]`,
    )
    .replace(/\/mnt\/data\/[^\s)]+/g, '/mnt/data/[redacted-file]')
    .slice(0, MAX_STACK_LENGTH);
}

function sanitizeDiagnosticText(value, max = MAX_TEXT_LENGTH) {
  if (value == null) return undefined;
  return boundedText(sanitizeStack(value), max);
}

function hashUserId(userId) {
  if (userId == null || String(userId).trim() === '') return undefined;
  const secret = process.env.DIAGNOSTIC_LOG_HASH_SECRET || process.env.JWT_SECRET;
  if (!secret) return undefined;
  return crypto.createHmac('sha256', secret).update(String(userId)).digest('hex').slice(0, 24);
}

function getRequestId(req) {
  const header = req?.headers?.['x-request-id'] || req?.headers?.['x-correlation-id'];
  return boundedText(req?.id || header, 256);
}

function getRelease() {
  return boundedText(
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
    tenantId: boundedId(values.tenantId ?? req?.user?.tenantId ?? req?.tenantId),
    requestId: boundedId(getRequestId(req)),
    userIdHash: hashUserId(values.userId ?? req?.user?.id),
    conversationId: boundedId(values.conversationId ?? body.conversationId),
    streamId: boundedId(values.streamId ?? req?._resumableStreamId ?? body.streamId),
    messageId: boundedId(values.messageId ?? body.messageId),
    model: boundedText(values.model ?? body?.endpointOption?.modelOptions?.model, 200),
  };
}

function normalizeInput(input = {}) {
  const now = new Date();
  const error = input.error;
  const context = requestContext(input.req, input);
  const errorMessage = sanitizeDiagnosticText(input.errorMessage ?? error?.message);
  const stack = sanitizeStack(input.stack ?? error?.stack);
  const event = boundedText(input.event, 160);
  const level = LEVELS.has(input.level) ? input.level : 'error';
  const stage = STAGES.has(input.stage) ? input.stage : 'generation';
  const durationValue = input.durationMs ?? (input.req?.diagnosticStartedAt ? Date.now() - input.req.diagnosticStartedAt : undefined);
  const durationMs = Number.isFinite(Number(durationValue))
    ? Math.max(0, Math.min(Math.floor(Number(durationValue)), 86_400_000))
    : undefined;

  if (!event) throw new Error('Diagnostic event name is required');

  return {
    timestamp: now,
    expiresAt: new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000),
    level,
    event,
    stage,
    ...context,
    errorCode: boundedText(input.errorCode ?? error?.code, 160),
    errorName: boundedText(input.errorName ?? error?.name, 160),
    errorMessage,
    durationMs,
    release: boundedText(input.release, 128) ?? getRelease(),
    stack,
  };
}

function logStructuredEvent(doc) {
  const payload = { ...doc };
  delete payload.stack;
  if (payload.level === 'warning') logger.warn('[diagnostic-event]', payload);
  else if (payload.level === 'info') logger.info('[diagnostic-event]', payload);
  else logger.error('[diagnostic-event]', payload);
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

function persistInBackground(doc) {
  if (pendingWrites >= MAX_QUEUE_DEPTH) {
    logger.warn('[diagnostic-event] persistence queue full; event retained in stdout only', {
      event: doc.event,
      stage: doc.stage,
      requestId: doc.requestId,
    });
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
      .catch((error) => {
        logger.error('[diagnostic-event] persistence failed', {
          event: doc.event,
          stage: doc.stage,
          requestId: doc.requestId,
          error: error?.message ?? String(error),
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
    doc = normalizeInput(input);
  } catch (error) {
    logger.error('[diagnostic-event] rejected invalid event', { error: error?.message ?? String(error) });
    return false;
  }
  logStructuredEvent(doc);
  return persistInBackground(doc);
}

function buildFilter(query = {}) {
  // Missing tenant context deliberately means the legacy, unscoped partition;
  // it never means "all tenants". Routes always pass their authenticated scope.
  const filter = { tenantId: boundedId(query.tenantId) ?? null };
  const lookup = boundedText(query.lookup, MAX_ID_LENGTH);
  if (lookup) {
    filter.$or = LOOKUP_FIELDS.map((field) => ({ [field]: lookup }));
  }
  if (LEVELS.has(query.level)) filter.level = query.level;
  if (STAGES.has(query.stage)) filter.stage = query.stage;
  if (query.conversationId) filter.conversationId = boundedText(query.conversationId, 256);
  if (query.streamId) filter.streamId = boundedText(query.streamId, 256);
  const from = normalizeDate(query.from);
  const to = normalizeDate(query.to, true);
  if (from || to) filter.timestamp = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
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
    ...(doc.errorName ? { errorName: doc.errorName } : {}),
    ...(doc.errorMessage ? { errorMessage: doc.errorMessage } : {}),
    ...(doc.durationMs != null ? { durationMs: doc.durationMs } : {}),
    ...(doc.release ? { release: doc.release } : {}),
  };
}

function toDetailEntry(doc) {
  return {
    ...toListEntry(doc),
    ...(doc.stack ? { stack: doc.stack } : {}),
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
  // Intentionally a single indexed read. Cursor pagination avoids per-page
  // countDocuments calls, which would turn a diagnostic error burst into a
  // second database load spike.
  const entries = await DiagnosticEvent.find(filter)
    .select('-stack')
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
  const doc = await getDiagnosticEventModel().findOne({ _id: id, ...filter }).lean();
  return doc ? toDetailEntry(doc) : null;
}

function createDiagnosticEventMethods() {
  return {
    recordDiagnosticEvent,
    listDiagnosticEventPage,
    findDiagnosticEvent,
    getDiagnosticEventModel,
    buildDiagnosticFilter: buildFilter,
    getDiagnosticEventQueueDepth: () => pendingWrites,
  };
}

module.exports = {
  RETENTION_DAYS,
  MAX_QUEUE_DEPTH,
  MAX_CONCURRENT_WRITES,
  createDiagnosticEventMethods,
  recordDiagnosticEvent,
  listDiagnosticEventPage,
  findDiagnosticEvent,
  requestContext,
  sanitizeStack,
  sanitizeDiagnosticText,
  hashUserId,
  buildDiagnosticFilter: buildFilter,
  getDiagnosticEventQueueDepth: () => pendingWrites,
};

const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireDiagnosticLogRead = requireCapability(SystemCapabilities.READ_DIAGNOSTIC_LOGS);

const LEVELS = new Set(['error', 'warning', 'info']);
const STAGES = new Set(['request', 'office_preparse', 'generation', 'followup']);

router.use(requireJwtAuth, requireAdminAccess, requireDiagnosticLogRead);

function optionalText(value, max = 256) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) {
    const error = new Error(`Diagnostic log query value exceeds ${max} characters.`);
    error.status = 400;
    throw error;
  }
  return value.trim() || undefined;
}

function positiveInteger(value, fallback, max) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    const error = new Error('Diagnostic log pagination value is invalid.');
    error.status = 400;
    throw error;
  }
  return parsed;
}

function validDate(value, label) {
  if (value == null || value === '') return undefined;
  const text = String(value);
  const calendarMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const date = calendarMatch ? new Date(`${text}T00:00:00.000Z`) : new Date(text);
  const calendarIsExact =
    !calendarMatch ||
    (date.getUTCFullYear() === Number(calendarMatch[1]) &&
      date.getUTCMonth() + 1 === Number(calendarMatch[2]) &&
      date.getUTCDate() === Number(calendarMatch[3]));
  if (Number.isNaN(date.getTime()) || !calendarIsExact) {
    const error = new Error(`Diagnostic log ${label} date is invalid.`);
    error.status = 400;
    throw error;
  }
  return text;
}

function parseQuery(query) {
  const level = optionalText(query.level, 32);
  const stage = optionalText(query.stage, 64);
  if (level && !LEVELS.has(level)) {
    const error = new Error('Diagnostic log level is invalid.');
    error.status = 400;
    throw error;
  }
  if (stage && !STAGES.has(stage)) {
    const error = new Error('Diagnostic log stage is invalid.');
    error.status = 400;
    throw error;
  }

  return {
    lookup: optionalText(query.lookup, 256),
    level,
    stage,
    from: validDate(optionalText(query.from, 64), 'from'),
    to: validDate(optionalText(query.to, 64), 'to'),
    conversationId: optionalText(query.conversationId),
    streamId: optionalText(query.streamId),
    cursor: optionalText(query.cursor),
    limit: positiveInteger(query.limit, 50, 100),
  };
}

function getTenantScope(req) {
  const tenantId = req.user?.tenantId ?? req.tenantId;
  if (tenantId == null) return null;
  const normalized = String(tenantId).trim();
  return normalized || null;
}

router.get('/', async (req, res, next) => {
  try {
    const page = await db.listDiagnosticEventPage({
      ...parseQuery(req.query),
      tenantId: getTenantScope(req),
    });
    res.status(200).json(page);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const entry = await db.findDiagnosticEvent(req.params.id, {
      tenantId: getTenantScope(req),
    });
    if (!entry) return res.status(404).json({ error: 'Diagnostic event not found' });
    return res.status(200).json({ entry });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

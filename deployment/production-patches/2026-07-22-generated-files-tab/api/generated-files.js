'use strict';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

function parseQuery(query = {}) {
  return {
    page: clampInteger(query.page, 1, 1, Number.MAX_SAFE_INTEGER),
    limit: clampInteger(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    query: typeof query.query === 'string' ? query.query.trim().slice(0, 160) : '',
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildGeneratedFilesPipeline({ userId, fileOwnerId, tenantId, options }) {
  const ownerChecks = [
    { $eq: ['$file_id', '$$fileId'] },
    { $eq: ['$user', fileOwnerId] },
  ];
  if (tenantId) {
    ownerChecks.push({ $eq: ['$tenantId', tenantId] });
  }

  const pipeline = [
    {
      $match: {
        user: userId,
        isCreatedByUser: false,
        $or: [{ 'files.0': { $exists: true } }, { 'attachments.0': { $exists: true } }],
      },
    },
    {
      $project: {
        conversationId: 1,
        messageId: 1,
        generatedAt: '$createdAt',
        refs: {
          $concatArrays: [
            { $ifNull: ['$files', []] },
            { $ifNull: ['$attachments', []] },
          ],
        },
      },
    },
    { $unwind: '$refs' },
    {
      $match: {
        'refs.file_id': { $type: 'string', $ne: '' },
        'refs.metadata.artifactRole': { $ne: 'intermediate' },
      },
    },
    { $sort: { generatedAt: -1, messageId: -1 } },
    {
      $group: {
        _id: '$refs.file_id',
        conversationId: { $first: '$conversationId' },
        messageId: { $first: '$messageId' },
        generatedAt: { $first: '$generatedAt' },
      },
    },
    {
      $lookup: {
        from: 'files',
        let: { fileId: '$_id' },
        pipeline: [
          { $match: { $expr: { $and: ownerChecks } } },
          {
            $project: {
              _id: 0,
              file_id: 1,
              filename: 1,
              type: 1,
              bytes: 1,
              source: 1,
              context: 1,
              status: 1,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        ],
        as: 'file',
      },
    },
    { $unwind: '$file' },
    { $match: { 'file.context': 'execute_code' } },
  ];

  if (options.query) {
    pipeline.push({
      $match: {
        'file.filename': { $regex: escapeRegex(options.query), $options: 'i' },
      },
    });
  }

  pipeline.push(
    { $sort: { generatedAt: -1, _id: 1 } },
    {
      $facet: {
        rows: [
          { $skip: (options.page - 1) * options.limit },
          { $limit: options.limit },
          {
            $project: {
              _id: 0,
              file_id: '$file.file_id',
              filename: '$file.filename',
              type: '$file.type',
              bytes: '$file.bytes',
              source: '$file.source',
              context: '$file.context',
              status: '$file.status',
              createdAt: '$file.createdAt',
              updatedAt: '$file.updatedAt',
              conversationId: 1,
              messageId: 1,
              generatedAt: 1,
            },
          },
        ],
        pagination: [{ $count: 'total' }],
      },
    },
  );

  return pipeline;
}

function formatResult(raw, options, userId) {
  const total = Number(raw?.pagination?.[0]?.total || 0);
  const rows = (raw?.rows || []).map((file) => ({
    ...file,
    downloadPath: `/api/files/download/${encodeURIComponent(userId)}/${encodeURIComponent(file.file_id)}`,
    conversationPath: file.conversationId
      ? `/c/${encodeURIComponent(file.conversationId)}`
      : null,
  }));
  return {
    files: rows,
    pagination: {
      page: options.page,
      limit: options.limit,
      total,
      pages: Math.max(1, Math.ceil(total / options.limit)),
    },
  };
}

function createGeneratedFilesHandler({ mongoose, logger }) {
  return async function generatedFilesHandler(req, res) {
    try {
      const userId = String(req.user?.id || '');
      if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const Message = mongoose.models.Message;
      if (!Message) {
        throw new Error('Message model is not initialized');
      }

      const options = parseQuery(req.query);
      const pipeline = buildGeneratedFilesPipeline({
        userId,
        fileOwnerId: new mongoose.Types.ObjectId(userId),
        tenantId: req.user?.tenantId || null,
        options,
      });
      const [raw = {}] = await Message.aggregate(pipeline).allowDiskUse(false).exec();
      return res.json(formatResult(raw, options, userId));
    } catch (error) {
      logger?.error?.('[generated-files] Failed to list generated files', error);
      return res.status(500).json({ error: 'Unable to load generated files' });
    }
  };
}

module.exports = {
  buildGeneratedFilesPipeline,
  createGeneratedFilesHandler,
  escapeRegex,
  formatResult,
  parseQuery,
};


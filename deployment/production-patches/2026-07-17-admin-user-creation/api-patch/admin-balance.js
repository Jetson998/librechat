'use strict';

const CREDITS_PER_USD = 1000000;
const MAX_ABS_ADJUSTMENT_USD = 100000;
const ADJUSTMENT_ID_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;

function toBalanceResponse(record, balanceEnabled = false) {
  const adjustments = Array.isArray(record?.adminAdjustments)
    ? [...record.adminAdjustments]
        .reverse()
        .slice(0, 100)
        .map((entry) => ({
          adjustmentId: entry.adjustmentId,
          amountUsd: Number(entry.amountCredits || 0) / CREDITS_PER_USD,
          balanceAfterUsd:
            entry.balanceAfterCredits == null
              ? null
              : Number(entry.balanceAfterCredits) / CREDITS_PER_USD,
          note: entry.note || '',
          createdAt: entry.createdAt,
          administratorId: entry.administratorId?.toString?.() || String(entry.administratorId || ''),
        }))
    : [];
  return {
    balanceEnabled,
    balanceUsd: Number(record?.tokenCredits || 0) / CREDITS_PER_USD,
    adjustments,
  };
}

function createAdminBalanceHandlers({ mongoose, findUsers, logger }) {
  async function findAdminTarget(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const [user] = await findUsers({ _id: new mongoose.Types.ObjectId(id) }, '_id', { limit: 1 });
    return user || null;
  }

  async function getUserBalance(req, res) {
    try {
      const target = await findAdminTarget(req.params.id);
      if (!target) return res.status(404).json({ error: 'User not found' });
      const userId = new mongoose.Types.ObjectId(req.params.id);
      const record = await mongoose.connection.collection('balances').findOne({ user: userId });
      return res.status(200).json(toBalanceResponse(record, req.config?.balance?.enabled === true));
    } catch (error) {
      logger.error('[adminUsers] get balance error:', error);
      return res.status(500).json({ error: 'Failed to load user balance' });
    }
  }

  async function adjustUserBalance(req, res) {
    try {
      const target = await findAdminTarget(req.params.id);
      if (!target) return res.status(404).json({ error: 'User not found' });
      if (req.config?.balance?.enabled !== true) {
        return res.status(409).json({ error: 'Balance is not enabled in the resolved configuration' });
      }

      const adjustmentId =
        typeof req.body?.adjustmentId === 'string' ? req.body.adjustmentId.trim() : '';
      const amountUsd = Number(req.body?.amountUsd);
      const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
      if (!ADJUSTMENT_ID_PATTERN.test(adjustmentId)) {
        return res.status(400).json({ error: 'A valid adjustment ID is required' });
      }
      if (
        !Number.isFinite(amountUsd) ||
        amountUsd === 0 ||
        Math.abs(amountUsd) > MAX_ABS_ADJUSTMENT_USD
      ) {
        return res
          .status(400)
          .json({ error: 'Adjustment must be between -100000 and 100000 USD' });
      }
      const amountCredits = Math.round(amountUsd * CREDITS_PER_USD);
      if (Math.abs(amountUsd * CREDITS_PER_USD - amountCredits) > 0.000001) {
        return res.status(400).json({ error: 'Adjustment supports at most six decimal places' });
      }
      if (note.length > 200) {
        return res.status(400).json({ error: 'Note must not exceed 200 characters' });
      }

      const userId = new mongoose.Types.ObjectId(req.params.id);
      const adminRawId = req.user?._id || req.user?.id;
      if (!mongoose.Types.ObjectId.isValid(String(adminRawId || ''))) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const administratorId = new mongoose.Types.ObjectId(adminRawId);
      const balances = mongoose.connection.collection('balances');
      const now = new Date();
      await balances.updateOne(
        { user: userId },
        {
          $setOnInsert: { user: userId, tokenCredits: 0, createdAt: now },
          $set: { updatedAt: now },
        },
        { upsert: true },
      );

      const filter = {
        user: userId,
        'adminAdjustments.adjustmentId': { $ne: adjustmentId },
      };
      if (amountCredits < 0) filter.tokenCredits = { $gte: Math.abs(amountCredits) };
      const balanceAfterExpression = {
        $add: [{ $ifNull: ['$tokenCredits', 0] }, amountCredits],
      };
      const updateResult = await balances.findOneAndUpdate(
        filter,
        [
          {
            $set: {
              tokenCredits: balanceAfterExpression,
              adminAdjustments: {
                $slice: [
                  {
                    $concatArrays: [
                      { $ifNull: ['$adminAdjustments', []] },
                      [
                        {
                          adjustmentId,
                          amountCredits,
                          balanceAfterCredits: balanceAfterExpression,
                          note,
                          administratorId,
                          createdAt: now,
                        },
                      ],
                    ],
                  },
                  -200,
                ],
              },
              updatedAt: now,
            },
          },
        ],
        { returnDocument: 'after' },
      );
      const updated = updateResult?.value || updateResult;
      if (updated) {
        logger.info(
          `[adminUsers] Balance adjusted for ${req.params.id} by ${administratorId.toString()}: ${amountCredits} credits`,
        );
        return res.status(200).json({ ...toBalanceResponse(updated, true), applied: true });
      }

      const existing = await balances.findOne({ user: userId });
      const duplicate = existing?.adminAdjustments?.some(
        (item) => item.adjustmentId === adjustmentId,
      );
      if (duplicate) {
        return res.status(200).json({ ...toBalanceResponse(existing, true), applied: false });
      }
      return res.status(409).json({ error: 'Adjustment would make the balance negative' });
    } catch (error) {
      logger.error('[adminUsers] adjust balance error:', error);
      return res.status(500).json({ error: 'Failed to adjust user balance' });
    }
  }

  return { getUserBalance, adjustUserBalance };
}

module.exports = { CREDITS_PER_USD, createAdminBalanceHandlers, toBalanceResponse };

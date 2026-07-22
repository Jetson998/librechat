'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createAdminBalanceHandlers } = require(
  path.resolve(
    __dirname,
    '..',
    '2026-07-17-admin-user-creation',
    'api-patch',
    'admin-balance.js',
  ),
);

class ObjectId {
  constructor(value) {
    this.value = String(value);
  }
  toString() {
    return this.value;
  }
  static isValid(value) {
    return /^[a-f0-9]{24}$/.test(String(value));
  }
}

const userId = '507f1f77bcf86cd799439011';
const adminId = '507f191e810c19729de860ea';
const state = { user: new ObjectId(userId), tokenCredits: 0, adminAdjustments: [] };

function matches(filter) {
  const duplicateId = filter['adminAdjustments.adjustmentId']?.$ne;
  if (duplicateId && state.adminAdjustments.some((item) => item.adjustmentId === duplicateId)) return false;
  if (filter.tokenCredits?.$gte != null && state.tokenCredits < filter.tokenCredits.$gte) return false;
  return true;
}

const balances = {
  async findOne() {
    return state;
  },
  async updateOne() {
    return { acknowledged: true };
  },
  async findOneAndUpdate(filter, update) {
    if (!matches(filter)) return null;
    const set = update[0].$set;
    const appended = set.adminAdjustments.$slice[0].$concatArrays[1][0];
    state.tokenCredits += appended.amountCredits;
    state.adminAdjustments.push({ ...appended, balanceAfterCredits: state.tokenCredits });
    return { ...state, adminAdjustments: [...state.adminAdjustments] };
  },
};

const mongoose = {
  Types: { ObjectId },
  connection: { collection(name) { assert.equal(name, 'balances'); return balances; } },
};
const handlers = createAdminBalanceHandlers({
  mongoose,
  findUsers: async () => [{ _id: new ObjectId(userId) }],
  logger: { info() {}, error() {} },
});

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function adjust(adjustmentId, amountUsd) {
  const res = response();
  await handlers.adjustUserBalance(
    {
      params: { id: userId },
      user: { id: adminId },
      config: { balance: { enabled: true } },
      body: { adjustmentId, amountUsd, note: 'Release test' },
    },
    res,
  );
  return res;
}

(async () => {
  const added = await adjust('release_add_001', 10);
  assert.equal(added.statusCode, 200);
  assert.equal(added.body.applied, true);
  assert.equal(added.body.balanceUsd, 10);

  const duplicate = await adjust('release_add_001', 10);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.body.applied, false);
  assert.equal(duplicate.body.balanceUsd, 10, 'idempotent replay must not add credit twice');

  const deducted = await adjust('release_deduct_001', -2.25);
  assert.equal(deducted.statusCode, 200);
  assert.equal(deducted.body.balanceUsd, 7.75);
  assert.equal(deducted.body.adjustments[0].balanceAfterUsd, 7.75);

  const overdraft = await adjust('release_deduct_002', -8);
  assert.equal(overdraft.statusCode, 409);
  assert.equal(state.tokenCredits, 7750000, 'failed deduction must not mutate balance');

  const loaded = response();
  await handlers.getUserBalance(
    { params: { id: userId }, config: { balance: { enabled: true } } },
    loaded,
  );
  assert.equal(loaded.statusCode, 200);
  assert.equal(loaded.body.adjustments.length, 2);
  assert.equal(loaded.body.balanceEnabled, true);
  assert.equal(loaded.body.adjustments[0].amountUsd, -2.25);
  process.stdout.write('admin_balance_handlers: ok\n');
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

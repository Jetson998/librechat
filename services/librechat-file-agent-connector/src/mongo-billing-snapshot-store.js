import { randomUUID } from 'node:crypto';

import { clone, digestJson, requiredString } from './stable.js';

const PRICE_FIELDS = ['prompt', 'completion', 'cacheRead', 'cacheWrite'];
const FORBIDDEN_KEYS = new Set([
  'apikey',
  'authorization',
  'baseurl',
  'password',
  'secret',
  'servicetoken',
]);

function validatePrice(value, name) {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number or null`);
  }
  return value;
}

function assertNoCredentials(value, path = 'snapshot') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentials(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new TypeError(`Billing snapshot contains forbidden field: ${path}.${key}`);
    }
    assertNoCredentials(entry, `${path}.${key}`);
  }
}

export class MongoBillingSnapshotStore {
  constructor({ collection }) {
    if (!collection || typeof collection.findOne !== 'function') {
      throw new TypeError('MongoBillingSnapshotStore collection is required');
    }
    this.collection = collection;
  }

  async init() {
    await this.collection.createIndex({ snapshotId: 1 }, { unique: true });
    await this.collection.createIndex({ user: 1, createdAt: -1 });
  }

  async create({
    user,
    modelRouteId,
    endpoint,
    model,
    prices,
    pricing,
    endpointTokenConfig,
    balance,
    transactions,
    pricingConfigDigest,
  }) {
    const normalizedPrices = Object.fromEntries(
      PRICE_FIELDS.map((field) => [field, validatePrice(prices?.[field], `prices.${field}`)]),
    );
    const createdAt = new Date().toISOString();
    const snapshot = {
      _id: randomUUID(),
      schemaVersion: '1.0',
      snapshotId: null,
      user: requiredString(user, 'user'),
      modelRouteId: requiredString(modelRouteId, 'modelRouteId'),
      endpoint: requiredString(endpoint, 'endpoint'),
      model: requiredString(model, 'model'),
      prices: normalizedPrices,
      pricing: clone(pricing ?? {}),
      endpointTokenConfig: clone(endpointTokenConfig ?? normalizedPrices),
      balance: clone(balance ?? { enabled: false }),
      transactions: clone(transactions ?? { enabled: true }),
      pricingConfigDigest: pricingConfigDigest ?? digestJson({
        endpoint,
        model,
        prices: normalizedPrices,
      }),
      createdAt,
    };
    snapshot.snapshotId = snapshot._id;
    assertNoCredentials(snapshot);
    await this.collection.insertOne(snapshot);
    return clone(snapshot);
  }

  async get(snapshotId) {
    const snapshot = await this.collection.findOne({ snapshotId });
    return snapshot ? clone(snapshot) : null;
  }
}

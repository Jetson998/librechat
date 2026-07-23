import { randomUUID } from 'node:crypto';

import { clone, digestJson, requiredString } from './stable.js';

const PRICE_FIELDS = ['prompt', 'completion', 'cacheRead', 'cacheWrite'];
const MESSAGE_IDENTITY_FIELDS = new Set(['sender', 'endpoint', 'model', 'iconURL']);
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

function validateMessageIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('messageIdentity must be an object');
  }
  for (const field of ['sender', 'endpoint', 'model']) {
    if (typeof value[field] !== 'string' || value[field].trim() === '') {
      throw new TypeError(`messageIdentity.${field} is required`);
    }
  }
  for (const field of Object.keys(value)) {
    if (!MESSAGE_IDENTITY_FIELDS.has(field)) {
      throw new TypeError(`messageIdentity contains unsupported field: ${field}`);
    }
  }
  if (value.iconURL != null && typeof value.iconURL !== 'string') {
    throw new TypeError('messageIdentity.iconURL must be a string when supplied');
  }
  return clone(value);
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
    messageIdentity,
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
      messageIdentity: validateMessageIdentity(
        messageIdentity ?? { sender: model, endpoint, model },
      ),
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

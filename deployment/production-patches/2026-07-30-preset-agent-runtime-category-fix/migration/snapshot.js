if (typeof MAPPING === 'undefined') {
  throw new Error('MAPPING is required');
}

const legacyIds = MAPPING.map(([legacyId]) => legacyId).sort();
const nextIds = MAPPING.map(([, nextId]) => nextId).sort();
const allIds = [...legacyIds, ...nextIds];
const legacySet = new Set(legacyIds);
const globalScope = { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };

const agents = db.agents
  .find({ id: { $in: allIds }, ...globalScope })
  .sort({ id: 1, _id: 1 })
  .toArray();
const targetResourceIds = agents.map((agent) => agent._id);
const aclEntries = targetResourceIds.length
  ? db.aclentries
      .find({ resourceType: 'agent', resourceId: { $in: targetResourceIds }, ...globalScope })
      .sort({ resourceId: 1, principalType: 1, principalId: 1, _id: 1 })
      .toArray()
  : [];
const categories = db.agentcategories
  .find({ value: 'automation-workflow', ...globalScope })
  .sort({ _id: 1 })
  .toArray();

const externalReferences = [];
const scannedCollections = [];

function walk(value, path, matches) {
  if (typeof value === 'string') {
    if (legacySet.has(value)) matches.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`, matches));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    walk(entry, path ? `${path}.${key}` : key, matches);
  }
}

for (const collectionName of db.getCollectionNames().sort()) {
  if (collectionName.startsWith('system.') || collectionName.endsWith('.chunks')) continue;
  const collection = db.getCollection(collectionName);
  const query = collectionName === 'agents'
    ? { _id: { $nin: targetResourceIds } }
    : {};
  let scanned = 0;
  collection.find(query).forEach((document) => {
    scanned += 1;
    const matches = [];
    walk(document, '', matches);
    if (matches.length > 0) {
      externalReferences.push({
        collection: collectionName,
        documentId: document._id,
        matches,
      });
    }
  });
  scannedCollections.push({ collection: collectionName, documents: scanned });
}

print(
  EJSON.stringify({
    schemaVersion: 1,
    legacyIds,
    nextIds,
    agents,
    aclEntries,
    categories,
    externalReferences,
    scannedCollections,
  }),
);

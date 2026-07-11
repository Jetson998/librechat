#!/usr/bin/env bash
set -Eeuo pipefail

mongo_container="${MONGO_CONTAINER:-chat-mongodb}"
api_container="${API_CONTAINER:-LibreChat-API}"
expected_label="GPT-5.6-SOL"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_id="sender-label-$timestamp"
applied=0

mongo_eval() {
  docker exec "$mongo_container" mongosh --quiet LibreChat --eval "$1"
}

preflight_js="
const doc = db.configs.findOne({ principalType: 'role', principalId: '__base__', isActive: true });
if (!doc) throw new Error('active base override missing');
if (db.configs.countDocuments({ principalType: 'role', principalId: '__base__', isActive: true }) !== 1) {
  throw new Error('active base override must be unique');
}
const specs = doc.overrides?.modelSpecs?.list ?? [];
const matches = specs.filter((item) => item?.name === 'gpt-5.6-sol');
if (matches.length !== 1) throw new Error('gpt-5.6-sol spec must exist exactly once');
if (matches[0].label !== '$expected_label') throw new Error('unexpected model spec label');
const endpoints = doc.overrides?.endpoints?.custom ?? [];
if (endpoints.filter((item) => item?.name === 'MuskAPI').length !== 1) {
  throw new Error('MuskAPI endpoint must exist exactly once');
}
print('preflight=ok configVersion=' + doc.configVersion + ' currentModelLabel=' + (matches[0].preset?.modelLabel ?? 'missing'));
"

mongo_eval "$preflight_js"
test "$(docker inspect "$api_container" --format '{{.State.Running}}')" = "true"

if [[ "${PREFLIGHT_ONLY:-false}" == "true" ]]; then
  echo "preflight_only=ok"
  exit 0
fi

rollback() {
  mongo_eval "
const backup = db.codexConfigBackups.findOne({ backupId: '$backup_id' });
if (!backup?.document) throw new Error('rollback backup missing');
const original = backup.document;
db.configs.replaceOne({ _id: original._id }, original, { upsert: true });
print('rollback=restored backupId=$backup_id');
"
  docker restart LibreChat-API >/dev/null
}

on_error() {
  rc=$?
  trap - ERR
  if [[ "$applied" == "1" ]]; then
    rollback || true
  fi
  exit "$rc"
}
trap on_error ERR

mongo_eval "
const query = { principalType: 'role', principalId: '__base__', isActive: true };
const doc = db.configs.findOne(query);
if (!doc) throw new Error('active base override missing');
const expectedLabel = '$expected_label';
db.codexConfigBackups.insertOne({
  backupId: '$backup_id',
  reason: 'gpt-5.6-sol preset.modelLabel rollout',
  createdAt: new Date(),
  document: doc
});
const specs = doc.overrides.modelSpecs.list;
const spec = specs.find((item) => item?.name === 'gpt-5.6-sol');
const endpoint = doc.overrides.endpoints.custom.find((item) => item?.name === 'MuskAPI');
spec.preset = spec.preset ?? {};
spec.preset.modelLabel = expectedLabel;
endpoint.modelDisplayLabel = expectedLabel;
doc.configVersion = (Number(doc.configVersion) || 0) + 1;
doc.updatedAt = new Date();
const result = db.configs.replaceOne({ _id: doc._id }, doc);
if (result.modifiedCount !== 1) throw new Error('config update did not modify one document');
print('apply=ok backupId=$backup_id configVersion=' + doc.configVersion);
"
applied=1

restart_since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker restart LibreChat-API >/dev/null

ready=0
for _ in $(seq 1 90); do
  if curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" = "1"

mongo_eval "
const doc = db.configs.findOne({ principalType: 'role', principalId: '__base__', isActive: true });
const spec = doc.overrides.modelSpecs.list.find((item) => item?.name === 'gpt-5.6-sol');
const endpoint = doc.overrides.endpoints.custom.find((item) => item?.name === 'MuskAPI');
if (spec?.preset?.modelLabel !== '$expected_label') throw new Error('runtime modelLabel mismatch');
if (endpoint?.modelDisplayLabel !== '$expected_label') throw new Error('runtime endpoint label mismatch');
print('runtime_config=ok modelLabel=' + spec.preset.modelLabel + ' backupId=$backup_id');
"

if docker logs --since "$restart_since" LibreChat-API 2>&1 \
  | grep -Eiq 'failed to load custom config|custom config validation failed|model spec.*skipped'; then
  echo "LibreChat reported a configuration startup error" >&2
  exit 1
fi

trap - ERR
printf 'timestamp=%s\n' "$timestamp"
printf 'backup_id=%s\n' "$backup_id"
printf 'model_label=%s\n' "$expected_label"

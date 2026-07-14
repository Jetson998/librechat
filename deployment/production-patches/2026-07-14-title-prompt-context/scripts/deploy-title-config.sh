#!/usr/bin/env bash
set -Eeuo pipefail

mongo_container="${MONGO_CONTAINER:-chat-mongodb}"
api_container="${API_CONTAINER:-LibreChat-API}"
expected_endpoint="MuskAPI"
expected_model="gpt-5.6-sol"
expected_prompt="根据以下对话生成简洁、准确的会话标题。对话内容：{convo}。只输出标题本身，不要解释，不要提问，不要使用引号，不要添加“标题：”等前缀。标题应概括核心主题，中文最多20个汉字；如果原内容不是中文，则使用原内容对应的语言。"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_id="title-config-$timestamp"
applied=0

mongo_eval() {
  docker exec "$mongo_container" mongosh --quiet LibreChat --eval "$1"
}

mongo_eval "
const doc = db.configs.findOne({ principalType: 'role', principalId: '__base__', isActive: true });
if (!doc) throw new Error('active base override missing');
if (db.configs.countDocuments({ principalType: 'role', principalId: '__base__', isActive: true }) !== 1) {
  throw new Error('active base override must be unique');
}
const endpoints = doc.overrides?.endpoints?.custom ?? [];
if (endpoints.filter((item) => item?.name === '$expected_endpoint').length !== 1) {
  throw new Error('MuskAPI endpoint must exist exactly once');
}
print('preflight=ok configVersion=' + doc.configVersion);
"
test "$(docker inspect "$api_container" --format '{{.State.Running}}')" = "true"

if [[ "${PREFLIGHT_ONLY:-false}" == "true" ]]; then
  echo "preflight_only=ok"
  exit 0
fi

rollback() {
  mongo_eval "
const backup = db.codexConfigBackups.findOne({ backupId: '$backup_id' });
if (!backup?.document) throw new Error('rollback backup missing');
db.configs.replaceOne({ _id: backup.document._id }, backup.document, { upsert: true });
print('rollback=restored backupId=$backup_id');
"
  docker restart LibreChat-API >/dev/null
}

on_error() {
  rc=$?
  trap - ERR
  if [[ "$applied" == "1" ]]; then rollback || true; fi
  exit "$rc"
}
trap on_error ERR

mongo_eval "
const query = { principalType: 'role', principalId: '__base__', isActive: true };
const doc = db.configs.findOne(query);
if (!doc) throw new Error('active base override missing');
db.codexConfigBackups.insertOne({
  backupId: '$backup_id', reason: 'MuskAPI title prompt conversation context',
  createdAt: new Date(), document: doc
});
const endpoint = doc.overrides.endpoints.custom.find((item) => item?.name === '$expected_endpoint');
const expectedEndpoint = '$expected_endpoint';
const expectedModel = '$expected_model';
endpoint.titleConvo = true;
endpoint.titleEndpoint = expectedEndpoint;
endpoint.titleModel = expectedModel;
endpoint.titleMessageRole = 'user';
endpoint.titlePrompt = '$expected_prompt';
delete endpoint.titlePromptTemplate;
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
  if curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null; then ready=1; break; fi
  sleep 1
done
test "$ready" = "1"

mongo_eval "
const doc = db.configs.findOne({ principalType: 'role', principalId: '__base__', isActive: true });
const endpoint = doc.overrides.endpoints.custom.find((item) => item?.name === '$expected_endpoint');
if (endpoint?.titleConvo !== true) throw new Error('title generation disabled');
if (endpoint?.titleEndpoint !== '$expected_endpoint') throw new Error('runtime title endpoint mismatch');
if (endpoint?.titleModel !== '$expected_model') throw new Error('runtime title model mismatch');
if (endpoint?.titleMessageRole !== 'user') throw new Error('runtime title role mismatch');
if (endpoint?.titlePrompt !== '$expected_prompt') throw new Error('runtime title prompt mismatch');
if (!endpoint.titlePrompt.includes('{convo}')) throw new Error('runtime title prompt missing convo placeholder');
if (endpoint?.titlePromptTemplate != null) throw new Error('runtime title template must be unset');
print('runtime_config=ok titleEndpoint=' + endpoint.titleEndpoint + ' titleModel=' + endpoint.titleModel);
"

if docker logs --since "$restart_since" LibreChat-API 2>&1 \
  | grep -Eiq 'failed to load custom config|custom config validation failed|model spec.*skipped'; then
  echo "LibreChat reported a configuration startup error" >&2
  exit 1
fi

trap - ERR
printf 'timestamp=%s\nbackup_id=%s\ntitle_endpoint=%s\ntitle_model=%s\n' \
  "$timestamp" "$backup_id" "$expected_endpoint" "$expected_model"

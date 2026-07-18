#!/usr/bin/env bash
set -Eeuo pipefail

mongo_container="${MONGO_CONTAINER:-chat-mongodb}"
api_container="${API_CONTAINER:-LibreChat-API}"
main_url="${MAIN_URL:-https://152.32.172.162.sslip.io}"
release_commit="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_id="fable-custom-endpoint-$timestamp"
applied=0

mongo_eval() {
  docker exec "$mongo_container" mongosh --quiet LibreChat --eval "$1"
}

preflight=''
preflight+='const q={principalType:"role",principalId:"__base__",isActive:true};'
preflight+='if(db.configs.countDocuments(q)!==1)throw new Error("active base override must be unique");'
preflight+='const d=db.configs.findOne(q);'
preflight+='const c=d.overrides?.endpoints?.custom??[];'
preflight+='if(c.filter(e=>e?.name==="MuskAPI").length!==1)throw new Error("MuskAPI endpoint missing");'
preflight+='if(c.some(e=>e?.name==="MuskAPI-Anthropic"))throw new Error("target endpoint already exists; inspect before retry");'
preflight+='const f=(d.overrides?.modelSpecs?.list??[]).filter(s=>s?.name==="claude-fable-5");'
preflight+='if(f.length!==1||f[0]?.preset?.endpoint!=="anthropic")throw new Error("unexpected current Fable routing");'
preflight+='print("preflight=ok configVersion="+(d.configVersion??0));'
mongo_eval "$preflight"
test "$(docker inspect "$api_container" --format '{{.State.Running}}')" = "true"
docker exec "$api_container" sh -lc 'grep -R -q "buildAnthropicCustomConfig" /app/node_modules/@librechat/api/dist/index.cjs'

if [[ "${PREFLIGHT_ONLY:-false}" == "true" ]]; then
  echo "preflight_only=ok"
  exit 0
fi

rollback() {
  mongo_eval "const b=db.codexConfigBackups.findOne({backupId:'$backup_id'});if(!b?.document)throw new Error('rollback backup missing');db.configs.replaceOne({_id:b.document._id},b.document,{upsert:true});print('rollback=restored');"
  docker restart "$api_container" >/dev/null
}

on_error() {
  rc=$?
  trap - ERR
  if [[ "$applied" == "1" ]]; then rollback || true; fi
  exit "$rc"
}
trap on_error ERR

mongo_eval "
const q={principalType:'role',principalId:'__base__',isActive:true};
const d=db.configs.findOne(q); if(!d)throw new Error('active base override missing');
db.codexConfigBackups.insertOne({backupId:'$backup_id',reason:'Fable custom endpoint routing',createdAt:new Date(),document:d});
const e=d.overrides.endpoints; const custom=e.custom;
custom.push({name:'MuskAPI-Anthropic',provider:'anthropic',apiKey:'\${ANTHROPIC_API_KEY}',baseURL:'https://api.muskapis.com',models:{default:['claude-fable-5'],fetch:false},titleConvo:true,titleModel:'claude-fable-5',modelDisplayLabel:'Fable 5'});
e.agents=e.agents??{}; e.agents.allowedProviders=['anthropic','MuskAPI','MuskAPI-Anthropic'];
const spec=d.overrides.modelSpecs.list.find(x=>x?.name==='claude-fable-5'); spec.preset=spec.preset??{}; spec.preset.endpoint='MuskAPI-Anthropic';
d.configVersion=(Number(d.configVersion)||0)+1; d.updatedAt=new Date();
if(db.configs.replaceOne({_id:d._id},d).modifiedCount!==1)throw new Error('config update did not modify one document');
print('apply=ok backupId=$backup_id configVersion='+d.configVersion);
"
applied=1

docker restart "$api_container" >/dev/null
ready=0
for _ in $(seq 1 120); do
  if curl -ksSf "$main_url/api/config" >/dev/null; then ready=1; break; fi
  sleep 1
done
test "$ready" = "1"

mongo_eval "
const d=db.configs.findOne({principalType:'role',principalId:'__base__',isActive:true});
const e=d.overrides.endpoints.custom.find(x=>x?.name==='MuskAPI-Anthropic');
const f=d.overrides.modelSpecs.list.find(x=>x?.name==='claude-fable-5');
if(e?.provider!=='anthropic'||e?.baseURL!=='https://api.muskapis.com')throw new Error('runtime custom endpoint mismatch');
if(f?.preset?.endpoint!=='MuskAPI-Anthropic')throw new Error('runtime Fable endpoint mismatch');
if(!d.overrides.endpoints.agents.allowedProviders.includes('MuskAPI-Anthropic'))throw new Error('agent allowlist mismatch');
print('runtime_config=ok endpoint='+f.preset.endpoint+' backupId=$backup_id');
"

printf 'release_commit=%s\nbackup_id=%s\n' "$release_commit" "$backup_id"

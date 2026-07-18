#!/usr/bin/env bash
set -Eeuo pipefail

release_dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
root_dir="/opt/librechat"
config_file="$root_dir/librechat.yaml"
compose_file="$root_dir/compose.yaml"
env_file="$root_dir/.env"
api_container="LibreChat-API"
codeapi_container="LibreChat-CodeAPI"
rag_container="LibreChat-RAG-API"
nginx_container="LibreChat-NGINX"
mongo_container="chat-mongodb"
admin_container="LibreChat-Admin-Panel"
office_skill_host="$root_dir/skill/office-document-parser/SKILL.md"
office_skill_container="/app/skill/office-document-parser/SKILL.md"
expected_office_skill_sha="29bfde2a0442b0c4013ecea4d58858e6d779b562e47057eb4237d2f22b93285a"
main_url="https://152.32.172.162.sslip.io"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_id="context-safety-stage-a-$timestamp"
backup_dir="$root_dir/backups/$backup_id"
candidate_config="$release_dir/.candidate-librechat-$timestamp.yaml"
result_file="$release_dir/DEPLOY_RESULT.txt"
merge_script="$release_dir/scripts/merge-config.cjs"
mongo_script="$release_dir/scripts/mongo-config.js"
test_script="$release_dir/scripts/test-release.py"
contract_file="$release_dir/config/large-file-batch-contract.txt"

for path in \
  "$config_file" "$compose_file" "$env_file" "$office_skill_host" \
  "$merge_script" "$mongo_script" "$test_script" "$contract_file"; do
  test -f "$path"
done

python3 "$test_script"
node --check "$merge_script"
node --check "$mongo_script"
docker exec -w /app/api "$api_container" node -e 'require("js-yaml")'

for container in \
  "$api_container" "$codeapi_container" "$rag_container" "$nginx_container" \
  "$mongo_container" "$admin_container"; do
  test "$(docker inspect "$container" --format '{{.State.Running}}')" = "true"
done

test "$(sha256sum "$office_skill_host" | awk '{print $1}')" = "$expected_office_skill_sha"
test "$(docker exec "$api_container" sha256sum "$office_skill_container" | awk '{print $1}')" = "$expected_office_skill_sha"

build_candidate() {
  local input_host="$1"
  local output_host="$2"
  local nonce="context-safety-$timestamp-$RANDOM"
  local input_container="/tmp/$nonce-input.yaml"
  local output_container="/tmp/$nonce-output.yaml"
  local contract_container="/tmp/$nonce-contract.txt"

  docker cp "$input_host" "$api_container:$input_container" >/dev/null
  docker cp "$contract_file" "$api_container:$contract_container" >/dev/null
  docker exec -i -w /app/api "$api_container" \
    node - "$input_container" "$output_container" "$contract_container" <"$merge_script"
  docker cp "$api_container:$output_container" "$output_host" >/dev/null
  docker exec "$api_container" rm -f \
    "$input_container" "$output_container" "$contract_container"
}

run_mongo_mode() {
  local mode="$1"
  docker exec -i \
    -e CONTEXT_SAFETY_MODE="$mode" \
    -e CONTEXT_SAFETY_BACKUP_ID="$backup_id" \
    "$mongo_container" mongosh --quiet LibreChat <"$mongo_script"
}

mongo_preservation_sha() {
  run_mongo_mode preservation | tail -n 1 | sha256sum | awk '{print $1}'
}

wait_for_url() {
  local url="$1"
  local attempts="$2"
  for _ in $(seq 1 "$attempts"); do
    if curl -ksSf "$url" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

build_candidate "$config_file" "$candidate_config"
candidate_twice="$candidate_config.twice"
build_candidate "$candidate_config" "$candidate_twice"
cmp -s "$candidate_config" "$candidate_twice"

mongo_preflight="$(run_mongo_mode preflight | tail -n 1)"
[[ "$mongo_preflight" == preflight=ok* ]]
mongo_preservation_sha_before="$(mongo_preservation_sha)"

config_sha_before="$(sha256sum "$config_file" | awk '{print $1}')"
candidate_sha="$(sha256sum "$candidate_config" | awk '{print $1}')"
api_id_before="$(docker inspect "$api_container" --format '{{.Id}}')"
api_started_before="$(docker inspect "$api_container" --format '{{.State.StartedAt}}')"
api_restarts_before="$(docker inspect "$api_container" --format '{{.RestartCount}}')"

declare -A protected_ids
declare -A protected_started
for container in \
  "$codeapi_container" "$rag_container" "$nginx_container" \
  "$mongo_container" "$admin_container"; do
  protected_ids[$container]="$(docker inspect "$container" --format '{{.Id}}')"
  protected_started[$container]="$(docker inspect "$container" --format '{{.State.StartedAt}}')"
done

public_index_before="$release_dir/.public-index-before-$timestamp.html"
curl -ksSf -o "$public_index_before" "$main_url/"
public_index_sha_before="$(sha256sum "$public_index_before" | awk '{print $1}')"

yaml_configured=false
if cmp -s "$config_file" "$candidate_config"; then
  yaml_configured=true
fi
mongo_configured=false
if run_mongo_mode verify >/dev/null 2>&1; then
  mongo_configured=true
fi

if [[ "${PREFLIGHT_ONLY:-false}" = "true" ]]; then
  printf 'preflight=ok\n'
  printf 'config_sha_before=%s\n' "$config_sha_before"
  printf 'candidate_sha=%s\n' "$candidate_sha"
  printf 'yaml_configured=%s\n' "$yaml_configured"
  printf 'mongo_configured=%s\n' "$mongo_configured"
  printf 'mongo_preservation_sha=%s\n' "$mongo_preservation_sha_before"
  printf 'api_container_id=%s\n' "$api_id_before"
  printf 'office_skill_sha=%s\n' "$expected_office_skill_sha"
  exit 0
fi

if [[ "$yaml_configured" = "true" && "$mongo_configured" = "true" ]]; then
  cat >"$result_file" <<EOF
status=already_deployed
timestamp=$timestamp
config_sha=$config_sha_before
mongo_preservation_sha=$mongo_preservation_sha_before
api_container_id=$api_id_before
api_started_at=$api_started_before
api_restart_count=$api_restarts_before
office_skill_sha=$expected_office_skill_sha
EOF
  cat "$result_file"
  exit 0
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$config_file" "$backup_dir/librechat.yaml"
run_mongo_mode dump >"$backup_dir/base-config.ejson"
chmod 600 "$backup_dir/base-config.ejson"

applied=0
api_recreated=0

restore_base_config_file() {
  local restore_path="/tmp/context-safety-$timestamp-base-config.ejson"
  docker cp "$backup_dir/base-config.ejson" "$mongo_container:$restore_path" >/dev/null
  docker exec "$mongo_container" mongosh --quiet LibreChat --eval "
    const doc = EJSON.parse(cat('$restore_path'));
    const result = db.configs.replaceOne({_id: doc._id}, doc, {upsert: true});
    if (result.acknowledged !== true) quit(2);
  " >/dev/null
  docker exec "$mongo_container" rm -f "$restore_path"
}

rollback() {
  set +e
  cp -a "$backup_dir/librechat.yaml" "$config_file"
  if ! run_mongo_mode rollback >/dev/null 2>&1; then
    restore_base_config_file >/dev/null 2>&1 || true
  fi
  if [[ "$api_recreated" = "1" ]]; then
    cd "$root_dir"
    docker compose up -d --no-deps --force-recreate api >/dev/null 2>&1
    wait_for_url "$main_url/api/config" 120 || true
  fi
}

on_error() {
  local rc=$?
  trap - ERR
  if [[ "$applied" = "1" ]]; then
    rollback
  fi
  exit "$rc"
}
trap on_error ERR

applied=1
next_config="$config_file.next-$timestamp"
cp "$candidate_config" "$next_config"
chmod --reference="$config_file" "$next_config"
chown --reference="$config_file" "$next_config"
mv "$next_config" "$config_file"

mongo_apply="$(run_mongo_mode apply | tail -n 1)"
[[ "$mongo_apply" == apply=ok* || "$mongo_apply" == apply=already_configured* ]]

api_recreated=1
cd "$root_dir"
docker compose up -d --no-deps --force-recreate api >/dev/null

wait_for_url "$main_url/api/config" 120
wait_for_url "$main_url/" 30
test "$(curl -ksS -o /dev/null -w '%{http_code}' "$main_url/office/")" = "401"

host_config_sha="$(sha256sum "$config_file" | awk '{print $1}')"
container_config_sha="$(docker exec "$api_container" sha256sum /app/librechat.yaml | awk '{print $1}')"
test "$host_config_sha" = "$candidate_sha"
test "$container_config_sha" = "$candidate_sha"

test "$(run_mongo_mode verify | tail -n 1 | cut -d' ' -f1)" = "verify=ok"
mongo_preservation_sha_after="$(mongo_preservation_sha)"
test "$mongo_preservation_sha_after" = "$mongo_preservation_sha_before"

docker exec -w /app/api "$api_container" node -e '
  const fs = require("node:fs");
  const yaml = require("js-yaml");
  const config = yaml.load(fs.readFileSync("/app/librechat.yaml", "utf8"));
  const agents = config?.endpoints?.agents;
  if (agents?.maxToolResultChars !== 32000) process.exit(2);
  if (agents?.recursionLimit !== 50) process.exit(3);
  if (agents?.maxRecursionLimit !== 50) process.exit(4);
  for (const name of ["gpt-5.6-sol", "claude-fable-5"]) {
    const matches = (config?.modelSpecs?.list ?? []).filter((item) => item?.name === name);
    if (matches.length !== 1) process.exit(5);
    const prompt = matches[0]?.preset?.promptPrefix;
    if (typeof prompt !== "string") process.exit(6);
    if ((prompt.match(/\[CONTEXT_SAFETY_BATCH_V1\]/g) ?? []).length !== 1) process.exit(7);
    if ((prompt.match(/\[\/CONTEXT_SAFETY_BATCH_V1\]/g) ?? []).length !== 1) process.exit(8);
  }
' >/dev/null

test "$(docker exec "$api_container" sha256sum "$office_skill_container" | awk '{print $1}')" = "$expected_office_skill_sha"
deployment_skill_log="$(docker logs "$api_container" 2>&1 | grep -F '[deploymentSkills] Loaded' | tail -n 1)"
test -n "$deployment_skill_log"

if docker logs "$api_container" 2>&1 \
  | grep -Eiq 'failed to load custom config|custom config validation failed|model spec.*skipped'; then
  echo "LibreChat reported a configuration startup error" >&2
  exit 1
fi

public_index_after="$release_dir/.public-index-after-$timestamp.html"
curl -ksSf -o "$public_index_after" "$main_url/"
public_index_sha_after="$(sha256sum "$public_index_after" | awk '{print $1}')"
test "$public_index_sha_after" = "$public_index_sha_before"

api_id_after="$(docker inspect "$api_container" --format '{{.Id}}')"
api_started_after="$(docker inspect "$api_container" --format '{{.State.StartedAt}}')"
api_restarts_after="$(docker inspect "$api_container" --format '{{.RestartCount}}')"
test "$api_id_after" != "$api_id_before"
test "$api_started_after" != "$api_started_before"

for container in "${!protected_ids[@]}"; do
  test "$(docker inspect "$container" --format '{{.Id}}')" = "${protected_ids[$container]}"
  test "$(docker inspect "$container" --format '{{.State.StartedAt}}')" = "${protected_started[$container]}"
done

trap - ERR

cat >"$result_file" <<EOF
status=deployed
timestamp=$timestamp
backup_id=$backup_id
backup_dir=$backup_dir
config_sha_before=$config_sha_before
config_sha_after=$host_config_sha
container_config_sha=$container_config_sha
mongo_preservation_sha=$mongo_preservation_sha_after
max_tool_result_chars=32000
recursion_limit=50
max_recursion_limit=50
api_recreated=true
api_container_id_before=$api_id_before
api_container_id_after=$api_id_after
api_started_before=$api_started_before
api_started_after=$api_started_after
api_restart_count_before=$api_restarts_before
api_restart_count_after=$api_restarts_after
protected_containers_unchanged=true
public_index_sha=$public_index_sha_after
office_skill_sha=$expected_office_skill_sha
api_config=200
root=200
office=401
EOF

cp "$result_file" "$backup_dir/DEPLOY_RESULT.txt"
cat "$result_file"

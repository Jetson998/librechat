#!/usr/bin/env bash
set -Eeuo pipefail

release_dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
root_dir="/opt/librechat"
env_file="$root_dir/.env"
config_file="$root_dir/librechat.yaml"
compose_file="$root_dir/compose.yaml"
api_container="LibreChat-API"
codeapi_container="LibreChat-CodeAPI"
nginx_container="LibreChat-NGINX"
mongo_container="chat-mongodb"
office_skill_host="$root_dir/skill/office-document-parser/SKILL.md"
office_skill_container="/app/skill/office-document-parser/SKILL.md"
expected_office_skill_sha="29bfde2a0442b0c4013ecea4d58858e6d779b562e47057eb4237d2f22b93285a"
main_url="https://152.32.172.162.sslip.io"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_dir="$root_dir/backups/global-serper-web-search-$timestamp"
candidate_config="$release_dir/.candidate-librechat-$timestamp.yaml"
result_file="$release_dir/DEPLOY_RESULT.txt"
merge_script="$release_dir/scripts/merge-config.cjs"
test_script="$release_dir/scripts/test-release.py"

for path in \
  "$env_file" \
  "$config_file" \
  "$compose_file" \
  "$office_skill_host" \
  "$merge_script" \
  "$test_script"; do
  test -f "$path"
done

python3 "$test_script"
docker exec -w /app/api "$api_container" node -e 'require("js-yaml")'

for container in "$api_container" "$codeapi_container" "$nginx_container" "$mongo_container"; do
  test "$(docker inspect "$container" --format '{{.State.Running}}')" = "true"
done

test "$(sha256sum "$office_skill_host" | awk '{print $1}')" = "$expected_office_skill_sha"
test "$(docker exec "$api_container" sha256sum "$office_skill_container" | awk '{print $1}')" = "$expected_office_skill_sha"

read_env_value() {
  local key="$1"
  local line value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == "$key="* ]] || continue
    value="${line#*=}"
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf '%s' "$value"
    return 0
  done <"$env_file"
  return 1
}

write_env_value() {
  local key="$1"
  local value="$2"
  local next="$env_file.next-$timestamp"
  local line found=0

  umask 077
  : >"$next"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      printf '%s=%s\n' "$key" "$value" >>"$next"
      found=1
    else
      printf '%s\n' "$line" >>"$next"
    fi
  done <"$env_file"
  if [[ "$found" = "0" ]]; then
    printf '%s=%s\n' "$key" "$value" >>"$next"
  fi
  chmod --reference="$env_file" "$next"
  chown --reference="$env_file" "$next"
  mv "$next" "$env_file"
}

build_candidate() {
  local input_host="$1"
  local output_host="$2"
  local nonce="serper-$timestamp-$RANDOM"
  local input_container="/tmp/$nonce-input.yaml"
  local output_container="/tmp/$nonce-output.yaml"

  docker cp "$input_host" "$api_container:$input_container" >/dev/null
  docker exec -i -w /app/api "$api_container" \
    node - "$input_container" "$output_container" <"$merge_script"
  docker cp "$api_container:$output_container" "$output_host" >/dev/null
  docker exec "$api_container" rm -f "$input_container" "$output_container"
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

web_override_count="$(
  docker exec "$mongo_container" mongosh --quiet LibreChat --eval \
    'print(db.configs.countDocuments({"overrides.webSearch": {$exists: true}}))' \
    | tail -n 1 | tr -d '[:space:]'
)"
[[ "$web_override_count" =~ ^[0-9]+$ ]]
test "$web_override_count" -le 1

model_override_count="$(
  docker exec "$mongo_container" mongosh --quiet LibreChat --eval \
    'print(db.configs.countDocuments({"overrides.modelSpecs": {$exists: true}}))' \
    | tail -n 1 | tr -d '[:space:]'
)"
test "$model_override_count" = "0"

current_reference=""
if [[ "$web_override_count" = "1" ]]; then
  current_reference="$(
    docker exec "$mongo_container" mongosh --quiet LibreChat --eval '
      const doc = db.configs.findOne({"overrides.webSearch": {$exists: true}});
      const value = doc?.overrides?.webSearch?.serperApiKey;
      if (typeof value !== "string") quit(2);
      print(value);
    ' | tail -n 1
  )"

  test "$(
    docker exec "$mongo_container" mongosh --quiet LibreChat --eval '
      const doc = db.configs.findOne({"overrides.webSearch": {$exists: true}});
      const value = doc?.overrides?.webSearch;
      if (!value) quit(2);
      if (String(value.searchProvider).toLowerCase() !== "serper") quit(3);
      if (String(value.scraperProvider).toLowerCase() !== "serper") quit(4);
      print("ok");
    ' | tail -n 1 | tr -d '[:space:]'
  )" = "ok"
fi

existing_key="$(read_env_value SERPER_API_KEY || true)"
serper_key=""
secret_source=""
if [[ "$existing_key" =~ ^[A-Za-z0-9_-]{24,128}$ ]]; then
  serper_key="$existing_key"
  secret_source="existing_env"
elif [[ "$current_reference" =~ ^\$\{SERPER_API([0-9a-f]{40})_KEY\}$ ]]; then
  serper_key="${BASH_REMATCH[1]}"
  secret_source="migrated_admin_reference"
else
  printf 'No safe system Serper key source was found.\n' >&2
  exit 1
fi
unset existing_key current_reference

build_candidate "$config_file" "$candidate_config"
candidate_twice="$candidate_config.twice"
build_candidate "$candidate_config" "$candidate_twice"
cmp -s "$candidate_config" "$candidate_twice"

config_sha_before="$(sha256sum "$config_file" | awk '{print $1}')"
candidate_sha="$(sha256sum "$candidate_config" | awk '{print $1}')"
api_id_before="$(docker inspect "$api_container" --format '{{.Id}}')"
api_started_before="$(docker inspect "$api_container" --format '{{.State.StartedAt}}')"
api_restarts_before="$(docker inspect "$api_container" --format '{{.RestartCount}}')"
codeapi_id_before="$(docker inspect "$codeapi_container" --format '{{.Id}}')"
nginx_id_before="$(docker inspect "$nginx_container" --format '{{.Id}}')"

already_configured=false
if cmp -s "$config_file" "$candidate_config" \
  && [[ "$web_override_count" = "0" ]] \
  && docker exec "$api_container" sh -lc 'test -n "$SERPER_API_KEY"'; then
  already_configured=true
fi

if [[ "${PREFLIGHT_ONLY:-false}" = "true" ]]; then
  printf 'preflight=ok\n'
  printf 'secret_source=%s\n' "$secret_source"
  printf 'web_override_count=%s\n' "$web_override_count"
  printf 'model_override_count=%s\n' "$model_override_count"
  printf 'config_sha_before=%s\n' "$config_sha_before"
  printf 'candidate_sha=%s\n' "$candidate_sha"
  printf 'already_configured=%s\n' "$already_configured"
  unset serper_key
  exit 0
fi

if [[ "$already_configured" = "true" ]]; then
  cat >"$result_file" <<EOF
status=already_deployed
config_sha=$config_sha_before
api_container_id=$api_id_before
api_started_at=$api_started_before
api_restart_count=$api_restarts_before
EOF
  cat "$result_file"
  unset serper_key
  exit 0
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$env_file" "$backup_dir/env"
cp -a "$config_file" "$backup_dir/librechat.yaml"

if [[ "$web_override_count" = "1" ]]; then
  docker exec "$mongo_container" mongosh --quiet LibreChat --eval '
    const doc = db.configs.findOne({"overrides.webSearch": {$exists: true}});
    if (!doc) quit(2);
    print(EJSON.stringify(doc));
  ' | tail -n 1 >"$backup_dir/config-doc.ejson"
  chmod 600 "$backup_dir/config-doc.ejson"
else
  : >"$backup_dir/config-doc.absent"
  chmod 600 "$backup_dir/config-doc.absent"
fi

applied=0
api_recreated=0

restore_config_document() {
  if [[ ! -f "$backup_dir/config-doc.ejson" ]]; then
    return 0
  fi
  local restore_path="/tmp/global-serper-config-$timestamp.ejson"
  docker cp "$backup_dir/config-doc.ejson" "$mongo_container:$restore_path" >/dev/null
  docker exec "$mongo_container" mongosh --quiet LibreChat --eval "
    const doc = EJSON.parse(cat('$restore_path'));
    const result = db.configs.replaceOne({_id: doc._id}, doc, {upsert: true});
    if (result.acknowledged !== true) quit(2);
  " >/dev/null
  docker exec "$mongo_container" rm -f "$restore_path"
}

rollback() {
  set +e
  cp -a "$backup_dir/env" "$env_file"
  cp -a "$backup_dir/librechat.yaml" "$config_file"
  restore_config_document
  if [[ "$api_recreated" = "1" ]]; then
    cd "$root_dir"
    docker compose up -d --force-recreate api >/dev/null 2>&1
    wait_for_url "$main_url/api/config" 120 || true
  fi
}

on_error() {
  local rc=$?
  trap - ERR
  if [[ "$applied" = "1" ]]; then
    rollback
  fi
  unset serper_key
  exit "$rc"
}
trap on_error ERR

applied=1
write_env_value SERPER_API_KEY "$serper_key"
unset serper_key

next_config="$config_file.next-$timestamp"
cp "$candidate_config" "$next_config"
chmod --reference="$config_file" "$next_config"
chown --reference="$config_file" "$next_config"
mv "$next_config" "$config_file"

if [[ "$web_override_count" = "1" ]]; then
  test "$(
    docker exec "$mongo_container" mongosh --quiet LibreChat --eval '
      const doc = db.configs.findOne({"overrides.webSearch": {$exists: true}});
      if (!doc) quit(2);
      const result = db.configs.updateOne(
        {_id: doc._id},
        {
          $unset: {"overrides.webSearch": ""},
          $inc: {configVersion: 1},
          $set: {updatedAt: new Date()}
        }
      );
      if (result.matchedCount !== 1) quit(3);
      print("removed");
    ' | tail -n 1 | tr -d '[:space:]'
  )" = "removed"
fi

api_recreated=1
cd "$root_dir"
docker compose up -d --force-recreate api >/dev/null

wait_for_url "$main_url/api/config" 120
wait_for_url "$main_url/" 30
test "$(curl -ksS -o /dev/null -w '%{http_code}' "$main_url/office/")" = "401"

test "$(docker inspect "$api_container" --format '{{.State.Running}}')" = "true"
test "$(docker inspect "$codeapi_container" --format '{{.State.Running}}')" = "true"
test "$(docker inspect "$nginx_container" --format '{{.State.Running}}')" = "true"
docker exec "$api_container" sh -lc 'test -n "$SERPER_API_KEY"'
test "$(docker exec "$api_container" sha256sum "$office_skill_container" | awk '{print $1}')" = "$expected_office_skill_sha"
deployment_skill_log="$(docker logs "$api_container" 2>&1 | grep -F '[deploymentSkills] Loaded' | tail -n 1)"
test -n "$deployment_skill_log"

host_config_sha="$(sha256sum "$config_file" | awk '{print $1}')"
container_config_sha="$(docker exec "$api_container" sha256sum /app/librechat.yaml | awk '{print $1}')"
test "$host_config_sha" = "$candidate_sha"
test "$container_config_sha" = "$candidate_sha"

test "$(
  docker exec "$mongo_container" mongosh --quiet LibreChat --eval \
    'print(db.configs.countDocuments({"overrides.webSearch": {$exists: true}}))' \
    | tail -n 1 | tr -d '[:space:]'
)" = "0"

docker exec -w /app/api "$api_container" node -e '
  const fs = require("node:fs");
  const yaml = require("js-yaml");
  const config = yaml.load(fs.readFileSync("/app/librechat.yaml", "utf8"));
  if (config?.webSearch?.searchProvider !== "serper") process.exit(2);
  if (config?.webSearch?.scraperProvider !== "serper") process.exit(3);
  if (config?.webSearch?.serperApiKey !== "${SERPER_API_KEY}") process.exit(4);
  const specs = config?.modelSpecs?.list ?? [];
  const matches = specs.filter((spec) => spec?.name === "gpt-5.6-sol");
  if (matches.length !== 1 || matches[0].webSearch !== true) process.exit(5);
' >/dev/null

docker exec "$api_container" node -e '
  async function main() {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {"X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json"},
      body: JSON.stringify({q: "LibreChat", num: 1})
    });
    if (!response.ok) process.exit(2);
    const body = await response.json();
    if (!body || typeof body !== "object") process.exit(3);
    console.log("serper_search_probe=ok");
  }
  main().catch(() => process.exit(4));
'

docker exec "$api_container" node -e '
  async function main() {
    const response = await fetch("https://scrape.serper.dev", {
      method: "POST",
      headers: {"X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json"},
      body: JSON.stringify({url: "https://example.com"})
    });
    if (!response.ok) process.exit(2);
    const body = await response.json();
    if (!body || typeof body !== "object") process.exit(3);
    console.log("serper_scrape_probe=ok");
  }
  main().catch(() => process.exit(4));
'

api_id_after="$(docker inspect "$api_container" --format '{{.Id}}')"
api_started_after="$(docker inspect "$api_container" --format '{{.State.StartedAt}}')"
api_restarts_after="$(docker inspect "$api_container" --format '{{.RestartCount}}')"
codeapi_id_after="$(docker inspect "$codeapi_container" --format '{{.Id}}')"
nginx_id_after="$(docker inspect "$nginx_container" --format '{{.Id}}')"

test "$api_id_after" != "$api_id_before"
test "$api_started_after" != "$api_started_before"
test "$codeapi_id_after" = "$codeapi_id_before"
test "$nginx_id_after" = "$nginx_id_before"

trap - ERR

cat >"$result_file" <<EOF
status=deployed
timestamp=$timestamp
backup_dir=$backup_dir
secret_source=$secret_source
config_sha_before=$config_sha_before
config_sha_after=$host_config_sha
container_config_sha=$container_config_sha
api_recreated=true
api_container_id_before=$api_id_before
api_container_id_after=$api_id_after
api_started_before=$api_started_before
api_started_after=$api_started_after
api_restart_count_before=$api_restarts_before
api_restart_count_after=$api_restarts_after
codeapi_unchanged=true
nginx_unchanged=true
office_skill_sha=$expected_office_skill_sha
office_skill_runtime_loaded=true
serper_search_probe=ok
serper_scrape_probe=ok
api_config=200
root=200
office=401
EOF

cat "$result_file"

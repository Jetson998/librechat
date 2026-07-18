#!/usr/bin/env bash
set -Eeuo pipefail

release_dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
root_dir="/opt/librechat"
env_file="$root_dir/.env"
compose_file="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
api_container="LibreChat-API"
codeapi_container="LibreChat-CodeAPI"
rag_container="LibreChat-RAG-API"
nginx_container="LibreChat-NGINX"
mongo_container="chat-mongodb"
admin_container="LibreChat-Admin-Panel"
office_skill_host="$root_dir/skill/office-document-parser/SKILL.md"
office_skill_container="/app/skill/office-document-parser/SKILL.md"
main_url="https://152.32.172.162.sslip.io"
expected_endpoints="anthropic"
target_endpoints="anthropic,agents"
expected_env_sha="42ae4dc3f69618ff4a4304aeac268f3adc93d648148cbf0716e00ae141439b2a"
expected_compose_override_sha="5d2e58ff45c766916ad67edbcd5ec6da4cdcb5ab9911540f455e21a761f3acfb"
expected_office_skill_sha="29bfde2a0442b0c4013ecea4d58858e6d779b562e47057eb4237d2f22b93285a"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_dir="$root_dir/backups/personal-user-skills-$timestamp"
result_file="$release_dir/DEPLOY_RESULT.txt"
test_script="$release_dir/scripts/test-release.py"

for path in \
  "$env_file" \
  "$compose_file" \
  "$compose_override" \
  "$office_skill_host" \
  "$test_script"; do
  test -f "$path"
done

python3 "$test_script"

test "$(sha256sum "$compose_override" | awk '{print $1}')" = "$expected_compose_override_sha"
test "$(sha256sum "$office_skill_host" | awk '{print $1}')" = "$expected_office_skill_sha"
test "$(docker exec "$api_container" sha256sum "$office_skill_container" | awk '{print $1}')" = "$expected_office_skill_sha"

containers=(
  "$api_container"
  "$codeapi_container"
  "$rag_container"
  "$nginx_container"
  "$mongo_container"
  "$admin_container"
)
for container in "${containers[@]}"; do
  test "$(docker inspect "$container" --format '{{.State.Running}}')" = "true"
done

read_env_value() {
  local key="$1"
  local line value found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == "$key="* ]] || continue
    found=$((found + 1))
    value="${line#*=}"
  done <"$env_file"
  test "$found" = "1"
  printf '%s' "$value"
}

normalized_env_sha() {
  sed -E 's/^ENDPOINTS=.*/ENDPOINTS=<normalized>/' "$env_file" | sha256sum | awk '{print $1}'
}

role_documents_sha() {
  docker exec "$mongo_container" mongosh --quiet LibreChat --eval '
    const roles = db.roles.find(
      {name: {$in: ["ADMIN", "USER"]}},
      {name: 1, permissions: 1}
    ).sort({name: 1}).toArray();
    print(EJSON.stringify(roles));
  ' | tail -n 1 | sha256sum | awk '{print $1}'
}

verify_user_skill_permissions() {
  test "$(
    docker exec "$mongo_container" mongosh --quiet LibreChat --eval '
      const role = db.roles.findOne({name: "USER"});
      if (role?.permissions?.SKILLS?.USE !== true) quit(2);
      if (role?.permissions?.SKILLS?.CREATE !== true) quit(3);
      print("ok");
    ' | tail -n 1 | tr -d '[:space:]'
  )" = "ok"
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

current_endpoints="$(read_env_value ENDPOINTS)"
runtime_endpoints="$(docker exec "$api_container" printenv ENDPOINTS)"
env_sha_before="$(sha256sum "$env_file" | awk '{print $1}')"
normalized_env_sha_before="$(normalized_env_sha)"
role_sha_before="$(role_documents_sha)"

case "$current_endpoints" in
  "$expected_endpoints")
    test "$env_sha_before" = "$expected_env_sha"
    ;;
  "$target_endpoints")
    ;;
  *)
    printf 'Unexpected ENDPOINTS baseline: %s\n' "$current_endpoints" >&2
    exit 1
    ;;
esac

verify_user_skill_permissions

api_id_before="$(docker inspect "$api_container" --format '{{.Id}}')"
api_started_before="$(docker inspect "$api_container" --format '{{.State.StartedAt}}')"
api_image_before="$(docker inspect "$api_container" --format '{{.Config.Image}}')"
codeapi_state_before="$(docker inspect "$codeapi_container" --format '{{.Id}} {{.State.StartedAt}}')"
rag_state_before="$(docker inspect "$rag_container" --format '{{.Id}} {{.State.StartedAt}}')"
nginx_state_before="$(docker inspect "$nginx_container" --format '{{.Id}} {{.State.StartedAt}}')"
mongo_state_before="$(docker inspect "$mongo_container" --format '{{.Id}} {{.State.StartedAt}}')"
admin_state_before="$(docker inspect "$admin_container" --format '{{.Id}} {{.State.StartedAt}}')"

already_configured=false
if [[ "$current_endpoints" = "$target_endpoints" && "$runtime_endpoints" = "$target_endpoints" ]]; then
  already_configured=true
fi

if [[ "${PREFLIGHT_ONLY:-false}" = "true" ]]; then
  printf 'preflight=ok\n'
  printf 'env_sha_before=%s\n' "$env_sha_before"
  printf 'compose_override_sha=%s\n' "$expected_compose_override_sha"
  printf 'office_skill_sha=%s\n' "$expected_office_skill_sha"
  printf 'current_endpoints=%s\n' "$current_endpoints"
  printf 'runtime_endpoints=%s\n' "$runtime_endpoints"
  printf 'role_documents_sha=%s\n' "$role_sha_before"
  printf 'already_configured=%s\n' "$already_configured"
  exit 0
fi

if [[ "$already_configured" = "true" ]]; then
  cat >"$result_file" <<EOF
status=already_deployed
endpoints=$target_endpoints
env_sha=$env_sha_before
compose_override_sha=$expected_compose_override_sha
office_skill_sha=$expected_office_skill_sha
role_documents_sha=$role_sha_before
api_container_id=$api_id_before
api_started_at=$api_started_before
api_image=$api_image_before
EOF
  cat "$result_file"
  exit 0
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$env_file" "$backup_dir/env"

applied=0
api_recreated=0

rollback() {
  set +e
  cp -a "$backup_dir/env" "$env_file"
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
if [[ "$current_endpoints" != "$target_endpoints" ]]; then
  next_env="$env_file.next-$timestamp"
  umask 077
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "ENDPOINTS="* ]]; then
      printf 'ENDPOINTS=%s\n' "$target_endpoints"
    else
      printf '%s\n' "$line"
    fi
  done <"$env_file" >"$next_env"
  chmod --reference="$env_file" "$next_env"
  chown --reference="$env_file" "$next_env"
  mv "$next_env" "$env_file"
fi

test "$(read_env_value ENDPOINTS)" = "$target_endpoints"
test "$(normalized_env_sha)" = "$normalized_env_sha_before"

api_recreated=1
cd "$root_dir"
docker compose up -d --no-deps --force-recreate api >/dev/null

wait_for_url "$main_url/api/config" 120
wait_for_url "$main_url/" 30
test "$(curl -ksS -o /dev/null -w '%{http_code}' "$main_url/office/")" = "401"
test "$(curl -ksS -o /dev/null -w '%{http_code}' "$main_url/api/skills")" = "401"

test "$(docker inspect "$api_container" --format '{{.State.Running}}')" = "true"
test "$(docker inspect "$api_container" --format '{{.Config.Image}}')" = "$api_image_before"
test "$(docker exec "$api_container" printenv ENDPOINTS)" = "$target_endpoints"
test "$(
  docker exec "$api_container" node -e '
    const { getEnabledEndpoints } = require("librechat-data-provider");
    const enabled = getEnabledEndpoints();
    if (!enabled.includes("anthropic") || !enabled.includes("agents")) process.exit(2);
    if (enabled.length !== 2) process.exit(3);
    process.stdout.write("ok");
  '
)" = "ok"

test "$(docker exec "$api_container" sha256sum "$office_skill_container" | awk '{print $1}')" = "$expected_office_skill_sha"
test -n "$(docker logs "$api_container" 2>&1 | grep -F '[deploymentSkills] Loaded' | tail -n 1)"
verify_user_skill_permissions
test "$(role_documents_sha)" = "$role_sha_before"

test "$(docker inspect "$codeapi_container" --format '{{.Id}} {{.State.StartedAt}}')" = "$codeapi_state_before"
test "$(docker inspect "$rag_container" --format '{{.Id}} {{.State.StartedAt}}')" = "$rag_state_before"
test "$(docker inspect "$nginx_container" --format '{{.Id}} {{.State.StartedAt}}')" = "$nginx_state_before"
test "$(docker inspect "$mongo_container" --format '{{.Id}} {{.State.StartedAt}}')" = "$mongo_state_before"
test "$(docker inspect "$admin_container" --format '{{.Id}} {{.State.StartedAt}}')" = "$admin_state_before"

api_id_after="$(docker inspect "$api_container" --format '{{.Id}}')"
api_started_after="$(docker inspect "$api_container" --format '{{.State.StartedAt}}')"
test "$api_id_after" != "$api_id_before"
test "$api_started_after" != "$api_started_before"

env_sha_after="$(sha256sum "$env_file" | awk '{print $1}')"
cat >"$result_file" <<EOF
status=deployed
timestamp=$timestamp
backup_dir=$backup_dir
endpoints_before=$current_endpoints
endpoints_after=$target_endpoints
env_sha_before=$env_sha_before
env_sha_after=$env_sha_after
compose_override_sha=$expected_compose_override_sha
office_skill_sha=$expected_office_skill_sha
role_documents_sha=$role_sha_before
api_image=$api_image_before
api_container_before=$api_id_before
api_container_after=$api_id_after
api_started_before=$api_started_before
api_started_after=$api_started_after
neighbor_containers_unchanged=true
browser_acceptance=pending
EOF

trap - ERR
cat "$result_file"

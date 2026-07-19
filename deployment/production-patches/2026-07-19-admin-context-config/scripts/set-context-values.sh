#!/usr/bin/env bash
set -Eeuo pipefail

# release-governance:scoped-deployment
# release-governance:target-lock
stage_dir="${1:-/tmp/librechat-admin-context-config}"
patch_dir="$stage_dir/deployment/production-patches/2026-07-19-admin-context-config"
release_commit="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_id="admin-context-config-$timestamp"
mongo_script="/tmp/set-context-values-$timestamp.js"
query='const q={principalType:"role",principalId:"__base__",isActive:true};const d=db.configs.findOne(q);if(db.configs.countDocuments(q)!==1)throw new Error("active base override must be unique");const ts=[["MuskAPI","gpt-5.6-sol"],["MuskAPI-Anthropic","claude-fable-5"]];for(const [e,m] of ts){const es=d.overrides.endpoints.custom.filter(x=>x.name===e);if(es.length!==1)throw new Error("endpoint must be unique");const c=es[0].tokenConfig?.[m];if(!c||typeof c!=="object"||Array.isArray(c))throw new Error("model config missing");print(e+"/"+m+"="+(c.context??"unset"));}'

test -f "$patch_dir/scripts/set-context-values.js"

declare -A protected_ids
for container in LibreChat-API LibreChat-NGINX LibreChat-CodeAPI LibreChat-RAG-API LibreChat-Admin-Panel chat-mongodb; do
  test "$(docker inspect "$container" --format '{{.State.Running}}')" = "true"
  protected_ids[$container]="$(docker inspect "$container" --format '{{.Id}}')"
done
config_count_before="$(docker exec chat-mongodb mongosh --quiet LibreChat --eval 'db.configs.countDocuments({})' | tail -n 1 | tr -d '[:space:]')"

docker exec chat-mongodb mongosh --quiet LibreChat --eval "$query"

if [[ "${PREFLIGHT_ONLY:-false}" = "true" ]]; then
  printf 'preflight_only=ok\nrelease_commit=%s\nconfig_count=%s\n' "$release_commit" "$config_count_before"
  exit 0
fi

docker cp "$patch_dir/scripts/set-context-values.js" "chat-mongodb:$mongo_script"
output="$(docker exec -e RELEASE_COMMIT="$release_commit" -e BACKUP_ID="$backup_id" chat-mongodb \
  mongosh --quiet LibreChat --file "$mongo_script")"
printf '%s\n' "$output"
docker exec chat-mongodb rm -f "$mongo_script"

test "$(docker exec chat-mongodb mongosh --quiet LibreChat --eval 'db.configs.countDocuments({})' | tail -n 1 | tr -d '[:space:]')" = "$config_count_before"
for container in "${!protected_ids[@]}"; do
  test "$(docker inspect "$container" --format '{{.Id}}')" = "${protected_ids[$container]}"
done

root_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/)"
api_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/api/config)"
admin_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://admin.152.32.172.162.sslip.io/)"
office_status="$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/office/)"
test "$root_status" = "200"
test "$api_status" = "200"
test "$admin_status" = "200"
test "$office_status" = "401"

cat >"$stage_dir/CONFIG_RESULT.txt" <<EOF
timestamp=$timestamp
release_commit=$release_commit
backup_id=$backup_id
context_MuskAPI_gpt_5_6_sol=1000000
context_MuskAPI_Anthropic_claude_fable_5=1000000
config_count_before=$config_count_before
config_count_after=$config_count_before
protected_containers_unchanged=true
root=$root_status
api_config=$api_status
admin=$admin_status
office=$office_status
EOF
for container in "${!protected_ids[@]}"; do
  key="${container//-/_}"
  printf 'protected_%s=%s\n' "$key" "${protected_ids[$container]}" >>"$stage_dir/CONFIG_RESULT.txt"
done
printf 'configuration=ok\nbackup_id=%s\n' "$backup_id"


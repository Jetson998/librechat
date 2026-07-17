#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-user-usage-dashboard-closeout}"
implementation_commit="${IMPLEMENTATION_COMMIT:-4c2bbcf875d843c53d0710d3a1db690760b1d828}"
release_root="/opt/librechat/user-usage-dashboard/4c2bbcf875d8-20260718002958"
backup_dir="/opt/librechat/backups/user-usage-dashboard-20260718002958"
api_before="0570b11e1fbe4b2a182c2bbebd127dfcb61add5d263451447ecaaa4b00a4e222"

declare -A expected_ids=(
  [LibreChat-NGINX]="1a5c01b19b73559d6ff2a7b9e053d77d5528946b61bafcd7acae86532f9e03df"
  [LibreChat-CodeAPI]="ddba629a7b6384c8088d012008f0300ba2d1e355b620b26a71c1e5dfaf3428df"
  [LibreChat-RAG-API]="d16e85e1e1036a8d203a338032d367e472f7245e993efc1ef30d06e7bf6373de"
  [chat-mongodb]="01d5bc03e9cb05a5efe43cc8a95c3dfce1e6387f65250923d135debe3050e7c6"
  [LibreChat-Admin-Panel]="bd888ea33f65c88d571c15dd8cff7b9a09be749ffb7ef3566cde56040a5fa8aa"
)

test -d "$release_root/client-dist"
test -d "$backup_dir"
test "$(sha256sum "$release_root/user.js" | awk '{print $1}')" = "$(sha256sum "$stage_dir/api/user.js" | awk '{print $1}')"
test "$(sha256sum "$release_root/usage-dashboard.js" | awk '{print $1}')" = "$(sha256sum "$stage_dir/api/usage-dashboard.js" | awk '{print $1}')"
grep -Fq 'user-usage-dashboard.js' "$release_root/client-dist/index.html"
grep -Fq 'business-upload-label-patch' "$release_root/client-dist/index.html"
grep -Fq 'odysseia-login-page-patch' "$release_root/client-dist/index.html"

for container in "${!expected_ids[@]}"; do
  test "$(docker inspect "$container" --format '{{.Id}}')" = "${expected_ids[$container]}"
done
api_after="$(docker inspect LibreChat-API --format '{{.Id}}')"
test "$api_after" != "$api_before"

curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null
test "$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/api/user/usage-dashboard)" = "401"
curl -ksSf https://152.32.172.162.sslip.io/ | grep -Fq 'user-usage-dashboard.js'

docker cp "$stage_dir/scripts/test-production-aggregation.js" LibreChat-API:/tmp/test-production-aggregation.js
aggregation_result="$(docker exec LibreChat-API node /tmp/test-production-aggregation.js /app/api/server/routes/usage-dashboard.js)"
printf '%s\n' "$aggregation_result" | grep -Fq '"aggregation":"ok"'

cat >"$stage_dir/DEPLOY_RESULT.txt" <<EOF
timestamp=20260718002958
implementation_commit=$implementation_commit
release_root=$release_root
backup_dir=$backup_dir
api_container_before=$api_before
api_container_after=$api_after
client_index_sha=$(sha256sum "$release_root/client-dist/index.html" | awk '{print $1}')
user_route_sha=$(sha256sum "$release_root/user.js" | awk '{print $1}')
usage_route_sha=$(sha256sum "$release_root/usage-dashboard.js" | awk '{print $1}')
protected_containers_unchanged=true
unauthenticated_endpoint_status=401
api_config_health=ok
production_aggregation=$aggregation_result
EOF
cp "$stage_dir/DEPLOY_RESULT.txt" "$backup_dir/DEPLOY_RESULT.txt"
cat "$stage_dir/DEPLOY_RESULT.txt"

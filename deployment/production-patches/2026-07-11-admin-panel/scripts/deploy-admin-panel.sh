#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-admin-panel-release}"
root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
config_file="$root_dir/librechat.yaml"
client_nginx="$root_dir/client/nginx.conf"
host_nginx="/etc/nginx/conf.d/librechat-admin.conf"
admin_host="admin.152.32.172.162.sslip.io"
main_url="https://152.32.172.162.sslip.io"
admin_url="https://$admin_host"
admin_image="registry.librechat.ai/clickhouse/librechat-admin-panel@sha256:1d3916ae84439e83da83507afd4aae14a99bd81ff2e1890079f57d8d377eb8e9"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_dir="$root_dir/backups/admin-panel-$timestamp"

candidate_config="$stage_dir/librechat.yaml"
candidate_override="$stage_dir/compose.override.yaml"
candidate_client_nginx="$stage_dir/client-nginx.conf"
candidate_host_http="$stage_dir/host-nginx-http.conf"
candidate_host_https="$stage_dir/host-nginx.conf"

for path in \
  "$candidate_config" \
  "$candidate_override" \
  "$candidate_client_nginx" \
  "$candidate_host_http" \
  "$candidate_host_https" \
  "$compose_base" \
  "$env_file" \
  "$config_file" \
  "$client_nginx"; do
  test -f "$path"
done

test "$(uname -m)" = "x86_64"
test "$(docker inspect LibreChat-API --format '{{.State.Running}}')" = "true"
test "$(docker inspect LibreChat-NGINX --format '{{.State.Running}}')" = "true"
test "$(docker inspect LibreChat-CodeAPI --format '{{.State.Running}}')" = "true"
getent ahostsv4 "$admin_host" | awk '{print $1}' | grep -Fxq '152.32.172.162'

override_count="$(docker exec chat-mongodb mongosh --quiet LibreChat --eval 'db.configs.countDocuments({})' | tail -n 1 | tr -d '[:space:]')"
test "$override_count" = "0"

secret_length="$(awk -F= '/^ADMIN_PANEL_SESSION_SECRET=/{print length($2); exit}' "$env_file")"
if [[ -n "$secret_length" ]]; then
  test "$secret_length" -ge 32
fi

docker compose \
  --env-file "$env_file" \
  -f "$compose_base" \
  -f "$candidate_override" \
  config >/dev/null

docker pull "$admin_image" >/dev/null
test "$(docker image inspect "$admin_image" --format '{{.Architecture}}')" = "amd64"

if [[ "${PREFLIGHT_ONLY:-false}" = "true" ]]; then
  printf 'preflight=ok\n'
  printf 'config_overrides=%s\n' "$override_count"
  printf 'admin_image=%s\n' "$admin_image"
  exit 0
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

backup_path() {
  local source="$1"
  local name="$2"
  if [[ -e "$source" ]]; then
    cp -a "$source" "$backup_dir/$name"
  else
    : >"$backup_dir/$name.absent"
  fi
}

restore_path() {
  local destination="$1"
  local name="$2"
  if [[ -f "$backup_dir/$name.absent" ]]; then
    rm -f "$destination"
  else
    cp -a "$backup_dir/$name" "$destination"
  fi
}

backup_path "$env_file" env
backup_path "$config_file" librechat.yaml
backup_path "$compose_override" compose.override.yaml
backup_path "$client_nginx" client-nginx.conf
backup_path "$host_nginx" host-nginx.conf

docker exec chat-mongodb mongosh --quiet LibreChat --eval \
  'print(EJSON.stringify(db.configs.find({}).toArray(), null, 2))' \
  >"$backup_dir/config-overrides-before.json"
chmod 600 "$backup_dir/config-overrides-before.json"

applied=0

install_candidate() {
  local source="$1"
  local destination="$2"
  local mode="$3"
  local next="$destination.next-$timestamp"
  cp "$source" "$next"
  chmod "$mode" "$next"
  if [[ -e "$destination" ]]; then
    chown --reference="$destination" "$next"
  fi
  mv "$next" "$destination"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local next="$env_file.next-$timestamp"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$env_file" >"$next"
  chmod --reference="$env_file" "$next"
  chown --reference="$env_file" "$next"
  mv "$next" "$env_file"
}

wait_for_url() {
  local url="$1"
  local attempts="$2"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

rollback() {
  set +e
  restore_path "$env_file" env
  restore_path "$config_file" librechat.yaml
  restore_path "$compose_override" compose.override.yaml
  restore_path "$client_nginx" client-nginx.conf
  restore_path "$host_nginx" host-nginx.conf

  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  cd "$root_dir"
  docker compose up -d api >/dev/null 2>&1
  docker compose up -d --force-recreate client >/dev/null 2>&1
  docker rm -f LibreChat-Admin-Panel >/dev/null 2>&1 || true
  wait_for_url "$main_url/api/config" 90 || true
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
if [[ -z "$secret_length" ]]; then
  set_env_value ADMIN_PANEL_SESSION_SECRET "$(openssl rand -hex 32)"
fi
set_env_value ADMIN_PANEL_URL "$admin_url"

install_candidate "$candidate_config" "$config_file" 644
install_candidate "$candidate_override" "$compose_override" 644
install_candidate "$candidate_client_nginx" "$client_nginx" 644

install_candidate "$candidate_host_http" "$host_nginx" 644
nginx -t >/dev/null
systemctl reload nginx

challenge_dir="/var/www/letsencrypt/.well-known/acme-challenge"
challenge_name="librechat-admin-$timestamp"
mkdir -p "$challenge_dir"
printf '%s' "$challenge_name" >"$challenge_dir/$challenge_name"
test "$(curl -fsS "http://$admin_host/.well-known/acme-challenge/$challenge_name")" = "$challenge_name"
rm -f "$challenge_dir/$challenge_name"

certbot certonly --webroot \
  --webroot-path /var/www/letsencrypt \
  --cert-name "$admin_host" \
  -d "$admin_host" \
  --non-interactive \
  --agree-tos \
  --keep-until-expiring >/dev/null

test -f "/etc/letsencrypt/live/$admin_host/fullchain.pem"
test -f "/etc/letsencrypt/live/$admin_host/privkey.pem"

install_candidate "$candidate_host_https" "$host_nginx" 644
nginx -t >/dev/null
systemctl reload nginx

cd "$root_dir"
docker compose config >/dev/null
docker compose pull admin-panel >/dev/null
docker compose up -d api admin-panel >/dev/null
docker compose up -d --force-recreate client >/dev/null

for container in LibreChat-API LibreChat-NGINX LibreChat-Admin-Panel; do
  for _ in $(seq 1 90); do
    if [[ "$(docker inspect "$container" --format '{{.State.Running}}' 2>/dev/null)" = "true" ]]; then
      break
    fi
    sleep 1
  done
  test "$(docker inspect "$container" --format '{{.State.Running}}')" = "true"
done

wait_for_url "$main_url/api/config" 120
wait_for_url "$main_url/" 30

admin_ready=0
for _ in $(seq 1 120); do
  admin_code="$(curl -sS -o /dev/null -w '%{http_code}' "$admin_url/" || true)"
  if [[ "$admin_code" = "200" || "$admin_code" = "302" || "$admin_code" = "303" || "$admin_code" = "307" || "$admin_code" = "308" ]]; then
    admin_ready=1
    break
  fi
  sleep 1
done
test "$admin_ready" = "1"

admin_html="$(mktemp)"
curl -fsS "$admin_url/" -o "$admin_html"
grep -Fq 'Admin Panel' "$admin_html"
if grep -Fq 'Every AI for Everyone' "$admin_html"; then
  echo 'Admin hostname is serving the main LibreChat client' >&2
  rm -f "$admin_html"
  false
fi
rm -f "$admin_html"

test "$(curl -ksS -o /dev/null -w '%{http_code}' "$main_url/office/")" = "401"
test "$(docker inspect LibreChat-CodeAPI --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')" = "healthy"
test -z "$(docker port LibreChat-Admin-Panel)"
test "$(docker exec LibreChat-API printenv ADMIN_PANEL_URL)" = "$admin_url"
test "$(docker exec chat-mongodb mongosh --quiet LibreChat --eval 'db.configs.countDocuments({})' | tail -n 1 | tr -d '[:space:]')" = "0"

docker exec -i LibreChat-API node <<'NODE'
const fs = require('fs');
const yaml = require('js-yaml');
const config = yaml.load(fs.readFileSync('/app/librechat.yaml', 'utf8'));
const specs = config.modelSpecs?.list ?? [];
const defaults = specs.filter((item) => item?.default === true);
if (defaults.length !== 1 || defaults[0].name !== 'gpt-5.6-sol') {
  throw new Error('GPT-5.6 SOL is not the sole default');
}
if (defaults[0].iconURL !== '/assets/openai.svg') {
  throw new Error('GPT OpenAI icon is not configured');
}
NODE

trap - ERR

printf 'timestamp=%s\n' "$timestamp"
printf 'backup_dir=%s\n' "$backup_dir"
printf 'admin_url=%s\n' "$admin_url"
printf 'admin_image=%s\n' "$admin_image"
sha256sum "$config_file" "$compose_override" "$client_nginx" "$host_nginx"
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' \
  --filter name=LibreChat-API \
  --filter name=LibreChat-NGINX \
  --filter name=LibreChat-Admin-Panel \
  --filter name=LibreChat-CodeAPI

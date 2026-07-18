#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="/opt/librechat"
compose_base="$root_dir/compose.yaml"
compose_override="$root_dir/compose.override.yaml"
env_file="$root_dir/.env"
expected_override_sha="af8367633ecd58e8dff78ad41d90956bbac405ba3b7d85db152148644eaeb33f"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_dir="$root_dir/backups/user-usage-usd-$timestamp"
stage_dir="${1:-/tmp/librechat-user-usage-usd}"

python3 "$stage_dir/scripts/test-release.py"
test "$(sha256sum "$compose_override" | awk '{print $1}')" = "$expected_override_sha"

declare -A protected_ids
for container in LibreChat-NGINX LibreChat-CodeAPI LibreChat-RAG-API chat-mongodb LibreChat-Admin-Panel; do
  protected_ids[$container]="$(docker inspect "$container" --format '{{.Id}}')"
done
api_id_before="$(docker inspect LibreChat-API --format '{{.Id}}')"

candidate="$stage_dir/compose.override.candidate.yaml"
python3 - "$compose_override" "$candidate" <<'PY'
import sys
import yaml

source, destination = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    data = yaml.safe_load(handle)
api = data.setdefault("services", {}).setdefault("api", {})
environment = api.setdefault("environment", [])
updates = {"USER_USAGE_CURRENCY": "USD", "USER_USAGE_USD_RATE": "1"}
remove = {"USER_USAGE_USD_TO_CNY"}
if isinstance(environment, dict):
    for key in remove:
        environment.pop(key, None)
    environment.update(updates)
else:
    kept = []
    for item in environment:
        key = str(item).split("=", 1)[0]
        if key not in remove and key not in updates:
            kept.append(item)
    kept.extend(f"{key}={value}" for key, value in updates.items())
    api["environment"] = kept
with open(destination, "w", encoding="utf-8") as handle:
    yaml.safe_dump(data, handle, allow_unicode=True, sort_keys=False)
PY

docker compose --env-file "$env_file" -f "$compose_base" -f "$candidate" config >/dev/null

if [[ "${PREFLIGHT_ONLY:-false}" = "true" ]]; then
  echo "preflight=ok"
  exit 0
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$compose_override" "$backup_dir/compose.override.yaml"

applied=0
rollback() {
  set +e
  cp -a "$backup_dir/compose.override.yaml" "$compose_override"
  cd "$root_dir"
  docker compose up -d --no-deps --force-recreate api >/dev/null 2>&1
}
on_error() {
  rc=$?
  trap - ERR
  [[ "$applied" = "1" ]] && rollback
  exit "$rc"
}
trap on_error ERR

install -m 0644 "$candidate" "$compose_override.next-$timestamp"
mv "$compose_override.next-$timestamp" "$compose_override"
applied=1
cd "$root_dir"
docker compose up -d --no-deps --force-recreate api >/dev/null

for _ in $(seq 1 120); do
  curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null 2>&1 && break
  sleep 1
done
curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null
test "$(docker exec LibreChat-API printenv USER_USAGE_CURRENCY)" = "USD"
test "$(docker exec LibreChat-API printenv USER_USAGE_USD_RATE)" = "1"
if docker exec LibreChat-API printenv USER_USAGE_USD_TO_CNY >/dev/null 2>&1; then exit 1; fi

for container in "${!protected_ids[@]}"; do
  test "$(docker inspect "$container" --format '{{.Id}}')" = "${protected_ids[$container]}"
done
api_id_after="$(docker inspect LibreChat-API --format '{{.Id}}')"
test "$api_id_after" != "$api_id_before"

trap - ERR
printf 'backup_dir=%s\napi_before=%s\napi_after=%s\ncurrency=USD\nrate=1\n' \
  "$backup_dir" "$api_id_before" "$api_id_after"

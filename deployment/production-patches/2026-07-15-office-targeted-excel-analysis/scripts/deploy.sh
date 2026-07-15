#!/usr/bin/env bash
set -Eeuo pipefail

release_dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
candidate="$release_dir/skill/office-document-parser/SKILL.md"
target="/opt/librechat/skill/office-document-parser/SKILL.md"
api_container="LibreChat-API"
main_url="https://152.32.172.162.sslip.io"
expected_current_sha="98e97c17e1753a0b0316e95be8162f68a6adaf88b13951053539f258a8c33c21"
timestamp="$(date +%Y%m%d%H%M%S)"
backup_dir="/opt/librechat/backups/office-targeted-excel-analysis-$timestamp"
result_file="$release_dir/DEPLOY_RESULT.txt"

test -f "$candidate"
test -f "$target"
node "$release_dir/scripts/test-release.js"

candidate_sha="$(sha256sum "$candidate" | awk '{print $1}')"
current_sha="$(sha256sum "$target" | awk '{print $1}')"

if [[ "$current_sha" == "$candidate_sha" ]]; then
  printf 'status=already_deployed\ncurrent_sha=%s\n' "$current_sha" >"$result_file"
  cat "$result_file"
  exit 0
fi

if [[ "$current_sha" != "$expected_current_sha" ]]; then
  printf 'Unexpected production SKILL.md hash: %s\n' "$current_sha" >&2
  exit 1
fi

grep -Fq 'file named `full_dump`' "$candidate"
grep -Fq 'Reopen the original workbook' "$candidate"
grep -Fq 'A complete export remains opt-in' "$candidate"

if [[ "${PREFLIGHT_ONLY:-false}" == "true" ]]; then
  printf 'status=preflight_passed\ncurrent_sha=%s\ncandidate_sha=%s\n' \
    "$current_sha" "$candidate_sha"
  exit 0
fi

mkdir -p "$backup_dir"
cp -a "$target" "$backup_dir/SKILL.md"

applied=0
rollback() {
  cp -a "$backup_dir/SKILL.md" "$target"
  docker restart "$api_container" >/dev/null
}

on_error() {
  rc=$?
  trap - ERR
  if [[ "$applied" == "1" ]]; then
    rollback
  fi
  exit "$rc"
}
trap on_error ERR

next="$target.next-$timestamp"
cp "$candidate" "$next"
chmod --reference="$target" "$next"
chown --reference="$target" "$next"
mv "$next" "$target"
applied=1

test "$(sha256sum "$target" | awk '{print $1}')" = "$candidate_sha"
docker restart "$api_container" >/dev/null

api_ready=0
for _ in $(seq 1 60); do
  if curl -ksSf "$main_url/api/config" >/dev/null; then
    api_ready=1
    break
  fi
  sleep 1
done
test "$api_ready" = "1"
curl -ksSf "$main_url/" >/dev/null
test "$(curl -ksS -o /dev/null -w '%{http_code}' "$main_url/office/")" = "401"
test "$(docker inspect "$api_container" --format '{{.State.Running}}')" = "true"

trap - ERR

cat >"$result_file" <<EOF
status=deployed
timestamp=$timestamp
backup_dir=$backup_dir
previous_sha=$current_sha
deployed_sha=$candidate_sha
api_running=true
api_config=200
root=200
office=401
EOF

cat "$result_file"

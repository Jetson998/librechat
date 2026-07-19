#!/usr/bin/env bash
# release-governance:scoped-deployment
# release-governance:targets=LibreChat-API,LibreChat-CodeAPI
# release-governance:target-lock
set -Eeuo pipefail

test -n "${SSH_PASS:-}"
test -n "${RELEASE_SOURCE_REVISION:-}"

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
remote_stage="/tmp/librechat-office-preparse-${RELEASE_SOURCE_REVISION:0:12}"
patch_root="deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/office-context-patch"
release_root="deployment/production-patches/2026-07-19-office-preparse-gate/scripts"

for file in "$patch_root/BaseClient.js" "$patch_root/api-index.cjs" "$release_root/remote-apply.sh"; do
  test -f "$file"
done

export LIBRECHAT_DEPLOY_HOST="$host"
export LIBRECHAT_DEPLOY_USER="$user"
export LIBRECHAT_DEPLOY_STAGE="$remote_stage"
export LIBRECHAT_BASECLIENT_SRC="$patch_root/BaseClient.js"
export LIBRECHAT_API_INDEX_SRC="$patch_root/api-index.cjs"
export LIBRECHAT_REMOTE_APPLY_SRC="$release_root/remote-apply.sh"

/usr/bin/expect <<'EXPECT'
set timeout 300
set password $env(SSH_PASS)
set host $env(LIBRECHAT_DEPLOY_HOST)
set user $env(LIBRECHAT_DEPLOY_USER)
set stage $env(LIBRECHAT_DEPLOY_STAGE)

proc authenticate {password} {
  expect {
    -re "(?i)are you sure you want to continue connecting" {
      send -- "yes\r"
      exp_continue
    }
    -re "(?i)password:" {
      send -- "$password\r"
      exp_continue
    }
    eof
  }
  catch wait result
  return [lindex $result 3]
}

spawn ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "$user@$host" "mkdir -p '$stage' && chmod 700 '$stage'"
if {[authenticate $password] != 0} { exit 1 }

spawn scp -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -- \
  $env(LIBRECHAT_BASECLIENT_SRC) \
  $env(LIBRECHAT_API_INDEX_SRC) \
  $env(LIBRECHAT_REMOTE_APPLY_SRC) \
  "$user@$host:$stage/"
if {[authenticate $password] != 0} { exit 1 }

spawn ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "$user@$host" \
  "chmod 700 '$stage/remote-apply.sh' && '$stage/remote-apply.sh' '$stage'"
exit [authenticate $password]
EXPECT

#!/usr/bin/env bash
# release-governance:scoped-deployment
# release-governance:targets=LibreChat-API,chat-mongodb
# release-governance:target-lock
set -Eeuo pipefail

test -n "${SSH_PASS:-}"
test -n "${RELEASE_SOURCE_REVISION:-}"

host="${LIBRECHAT_PRODUCTION_HOST:-152.32.172.162}"
user="${LIBRECHAT_PRODUCTION_USER:-root}"
patch_root="deployment/production-patches/2026-07-24-agent-progress-ledger"
remote_stage="/tmp/librechat-agent-progress-ledger-${RELEASE_SOURCE_REVISION:0:12}"

for file in \
  "$patch_root/api-patch/api-index.cjs" \
  "$patch_root/api-patch/tool-call-normalizer.cjs" \
  "$patch_root/api-patch/tool-progress-ledger.cjs" \
  "$patch_root/scripts/mongo-config.js" \
  "$patch_root/scripts/remote-apply.sh"; do
  test -f "$file"
done

export LIBRECHAT_DEPLOY_HOST="$host"
export LIBRECHAT_DEPLOY_USER="$user"
export LIBRECHAT_DEPLOY_STAGE="$remote_stage"
export LIBRECHAT_RELEASE_REVISION="$RELEASE_SOURCE_REVISION"
export LIBRECHAT_API_INDEX_SRC="$patch_root/api-patch/api-index.cjs"
export LIBRECHAT_TOOL_NORMALIZER_SRC="$patch_root/api-patch/tool-call-normalizer.cjs"
export LIBRECHAT_PROGRESS_LEDGER_SRC="$patch_root/api-patch/tool-progress-ledger.cjs"
export LIBRECHAT_MONGO_CONFIG_SRC="$patch_root/scripts/mongo-config.js"
export LIBRECHAT_REMOTE_APPLY_SRC="$patch_root/scripts/remote-apply.sh"

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
  $env(LIBRECHAT_API_INDEX_SRC) \
  $env(LIBRECHAT_TOOL_NORMALIZER_SRC) \
  $env(LIBRECHAT_PROGRESS_LEDGER_SRC) \
  $env(LIBRECHAT_MONGO_CONFIG_SRC) \
  $env(LIBRECHAT_REMOTE_APPLY_SRC) \
  "$user@$host:$stage/"
if {[authenticate $password] != 0} { exit 1 }

spawn ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "$user@$host" \
  "chmod 700 '$stage/remote-apply.sh' && '$stage/remote-apply.sh' '$stage' '$env(LIBRECHAT_RELEASE_REVISION)'"
exit [authenticate $password]
EXPECT

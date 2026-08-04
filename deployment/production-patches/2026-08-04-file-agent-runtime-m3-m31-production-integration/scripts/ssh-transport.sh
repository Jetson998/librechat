#!/usr/bin/env bash

# Production transport is intentionally key-only in this runner. Passwords are
# never accepted through command arguments, environment variables, or source
# files. Operators may use their existing SSH agent or a configured key.
set -Eeuo pipefail

transport_prepare() {
  local host="$1"
  local user="$2"
  export FILE_AGENT_SSH_TARGET="$user@$host"
  ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 \
    "$FILE_AGENT_SSH_TARGET" true >/dev/null
}

transport_cleanup() {
  unset FILE_AGENT_SSH_TARGET
}

transport_exec() {
  local command="$1"
  ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 \
    "$FILE_AGENT_SSH_TARGET" "$command"
}

transport_copy_to() {
  local local_path="$1"
  local remote_path="$2"
  scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -- \
    "$local_path" "$FILE_AGENT_SSH_TARGET:$remote_path"
}

transport_copy_from() {
  local remote_path="$1"
  local local_path="$2"
  scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -- \
    "$FILE_AGENT_SSH_TARGET:$remote_path" "$local_path"
}

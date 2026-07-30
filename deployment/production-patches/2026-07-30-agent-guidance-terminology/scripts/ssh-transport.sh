#!/usr/bin/env bash

transport_prepare() {
  local host="$1"
  local user="$2"

  export LIBRECHAT_SSH_HOST="$host"
  export LIBRECHAT_SSH_USER="$user"
  export LIBRECHAT_SSH_MODE=""

  if ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 \
    "$user@$host" true >/dev/null 2>&1; then
    LIBRECHAT_SSH_MODE="key"
    export LIBRECHAT_SSH_MODE
    return
  fi

  if [[ ! -r /dev/tty || ! -w /dev/tty ]]; then
    printf '%s\n' \
      'Production SSH requires key authentication or an interactive control terminal.' >&2
    return 1
  fi

  printf 'Production SSH password for %s@%s: ' "$user" "$host" >/dev/tty
  IFS= read -r -s LIBRECHAT_SSH_PASSWORD </dev/tty
  printf '\n' >/dev/tty
  test -n "$LIBRECHAT_SSH_PASSWORD"
  export LIBRECHAT_SSH_PASSWORD
  LIBRECHAT_SSH_MODE="password"
  export LIBRECHAT_SSH_MODE
}

transport_cleanup() {
  unset LIBRECHAT_SSH_PASSWORD LIBRECHAT_SSH_MODE LIBRECHAT_SSH_HOST LIBRECHAT_SSH_USER
}

transport_exec() {
  local command="$1"

  if [[ "$LIBRECHAT_SSH_MODE" == "key" ]]; then
    ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 \
      "$LIBRECHAT_SSH_USER@$LIBRECHAT_SSH_HOST" "$command"
    return
  fi

  export LIBRECHAT_REMOTE_COMMAND="$command"
  /usr/bin/expect <<'EXPECT'
set timeout 600
set password $env(LIBRECHAT_SSH_PASSWORD)
set host $env(LIBRECHAT_SSH_HOST)
set user $env(LIBRECHAT_SSH_USER)
set command $env(LIBRECHAT_REMOTE_COMMAND)

spawn ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "$user@$host" $command
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
exit [lindex $result 3]
EXPECT
  unset LIBRECHAT_REMOTE_COMMAND
}

transport_copy_to() {
  local local_path="$1"
  local remote_path="$2"

  if [[ "$LIBRECHAT_SSH_MODE" == "key" ]]; then
    scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -- \
      "$local_path" "$LIBRECHAT_SSH_USER@$LIBRECHAT_SSH_HOST:$remote_path"
    return
  fi

  export LIBRECHAT_LOCAL_PATH="$local_path"
  export LIBRECHAT_REMOTE_PATH="$remote_path"
  /usr/bin/expect <<'EXPECT'
set timeout 600
set password $env(LIBRECHAT_SSH_PASSWORD)
set host $env(LIBRECHAT_SSH_HOST)
set user $env(LIBRECHAT_SSH_USER)
set local_path $env(LIBRECHAT_LOCAL_PATH)
set remote_path $env(LIBRECHAT_REMOTE_PATH)

spawn scp -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -- \
  $local_path "$user@$host:$remote_path"
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
exit [lindex $result 3]
EXPECT
  unset LIBRECHAT_LOCAL_PATH LIBRECHAT_REMOTE_PATH
}

transport_copy_from() {
  local remote_path="$1"
  local local_path="$2"

  if [[ "$LIBRECHAT_SSH_MODE" == "key" ]]; then
    scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -- \
      "$LIBRECHAT_SSH_USER@$LIBRECHAT_SSH_HOST:$remote_path" "$local_path"
    return
  fi

  export LIBRECHAT_LOCAL_PATH="$local_path"
  export LIBRECHAT_REMOTE_PATH="$remote_path"
  /usr/bin/expect <<'EXPECT'
set timeout 600
set password $env(LIBRECHAT_SSH_PASSWORD)
set host $env(LIBRECHAT_SSH_HOST)
set user $env(LIBRECHAT_SSH_USER)
set local_path $env(LIBRECHAT_LOCAL_PATH)
set remote_path $env(LIBRECHAT_REMOTE_PATH)

spawn scp -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -- \
  "$user@$host:$remote_path" $local_path
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
exit [lindex $result 3]
EXPECT
  unset LIBRECHAT_LOCAL_PATH LIBRECHAT_REMOTE_PATH
}

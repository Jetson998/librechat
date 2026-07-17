#!/usr/bin/env bash
set -Eeuo pipefail

swap_file="${SWAP_FILE:-/swapfile-librechat-build}"
swap_size_gb="${SWAP_SIZE_GB:-4}"
fstab_line="$swap_file none swap sw 0 0"

test "$(id -u)" = "0"
exec 9>/run/librechat-build-swap.lock
flock 9

if ! swapon --show=NAME --noheadings | awk '{print $1}' | grep -Fqx "$swap_file"; then
  if [[ ! -e "$swap_file" ]]; then
    fallocate -l "${swap_size_gb}G" "$swap_file"
    chmod 600 "$swap_file"
    mkswap -L librechat-build "$swap_file" >/dev/null
  fi
  chmod 600 "$swap_file"
  swapon "$swap_file"
fi

if ! grep -Fqx "$fstab_line" /etc/fstab; then
  printf '%s\n' "$fstab_line" >>/etc/fstab
fi

swap_total_mb="$(awk '/^SwapTotal:/ {print int($2 / 1024)}' /proc/meminfo)"
test "$swap_total_mb" -ge 3072
printf 'build_swap=ready\nfile=%s\nswap_total_mb=%s\n' "$swap_file" "$swap_total_mb"

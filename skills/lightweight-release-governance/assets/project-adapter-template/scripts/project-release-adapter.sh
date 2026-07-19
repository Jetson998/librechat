#!/usr/bin/env sh
set -eu

command_name=${1:-unknown}
printf 'adapter_not_implemented: implement project adapter command %s before use\n' "$command_name" >&2
exit 78

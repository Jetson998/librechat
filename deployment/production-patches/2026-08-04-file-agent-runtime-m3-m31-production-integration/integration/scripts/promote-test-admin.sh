#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${1:-$INTEGRATION_DIR/.env.integration}"
COMPOSE_FILE="$INTEGRATION_DIR/compose.integration.yaml"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

STATE_DIR="${INTEGRATION_STATE_DIR:-$INTEGRATION_DIR/.state}"
PATHS_ENV="$STATE_DIR/config/integration.paths.env"
API_ENV="$STATE_DIR/config/api-runtime.env"
if [[ ! -f "$PATHS_ENV" || ! -f "$API_ENV" ]]; then
  printf 'integration state is incomplete\n' >&2
  exit 2
fi
set -a
# shellcheck disable=SC1090
source "$PATHS_ENV"
# shellcheck disable=SC1090
source "$API_ENV"
set +a

users_file="${INTEGRATION_TEST_USERS_FILE:?INTEGRATION_TEST_USERS_FILE is required}"
evidence_file="${2:-${INTEGRATION_EVIDENCE_DIR:?INTEGRATION_EVIDENCE_DIR is required}/integration-test-admin.json}"
if [[ -L "$users_file" || ! -f "$users_file" ]]; then
  printf 'integration test user file is missing or unsafe\n' >&2
  exit 3
fi

user_record="$(node - "$users_file" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (value?.schemaVersion !== 1 || !Array.isArray(value.users) || value.users.length !== 1) {
  throw new Error('exactly one integration test user is required');
}
const user = value.users[0];
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) || !/^[0-9a-f]{24}$/.test(user.userId)) {
  throw new Error('integration test user identity is invalid');
}
process.stdout.write(`${user.email}\t${user.userId}`);
NODE
)"
IFS=$'\t' read -r user_email expected_user_id <<< "$user_record"

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}")
result="$("${compose[@]}" exec -T \
  -e INTEGRATION_ADMIN_EMAIL="$user_email" \
  -e INTEGRATION_ADMIN_USER_ID="$expected_user_id" \
  mongodb mongosh LibreChatIntegration --quiet --eval '
const email = process.env.INTEGRATION_ADMIN_EMAIL;
const expectedId = process.env.INTEGRATION_ADMIN_USER_ID;
const expectedObjectId = ObjectId.createFromHexString(expectedId);
const update = db.users.updateOne({ email, _id: expectedObjectId }, { $set: { role: "ADMIN" } });
const cleanup = db.users.deleteMany({ _id: { $ne: expectedObjectId } });
const user = db.users.findOne({ email }, { _id: 1, email: 1, role: 1 });
const userCount = db.users.countDocuments({});
if (!user || String(user._id) !== expectedId || user.role !== "ADMIN" || update.matchedCount !== 1 || userCount !== 1) quit(7);
JSON.stringify({ status: "passed", userId: String(user._id), email: user.email, role: user.role, matchedCount: update.matchedCount, modifiedCount: update.modifiedCount, removedOtherUsers: cleanup.deletedCount, userCount });
')"

mkdir -p "$(dirname -- "$evidence_file")"
printf '%s\n' "$result" > "$evidence_file"
chmod 600 "$evidence_file"
printf 'integration_test_admin=passed\n'
printf 'evidence_file=%s\n' "$evidence_file"

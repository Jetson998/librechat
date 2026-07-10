#!/usr/bin/env bash
set -Eeuo pipefail

stage_dir="${1:-/tmp/librechat-gpt56-sol-default}"
candidate="$stage_dir/librechat.yaml"
destination="/opt/librechat/librechat.yaml"
container_candidate="/tmp/librechat-gpt56-sol-default.yaml"
timestamp="$(date +%Y%m%d%H%M%S)"
backup="$destination.bak-$timestamp"

test -f "$candidate"
test -f "$destination"
test "$(docker inspect LibreChat-API --format '{{.State.Running}}')" = "true"

cleanup() {
  docker exec LibreChat-API rm -f "$container_candidate" >/dev/null 2>&1 || true
  if [[ -n "${next:-}" ]]; then
    rm -f "$next"
  fi
}

trap cleanup EXIT

docker cp "$candidate" "LibreChat-API:$container_candidate" >/dev/null
docker exec -i LibreChat-API node <<'NODE'
const fs = require('fs');
const yaml = require('js-yaml');

const path = '/tmp/librechat-gpt56-sol-default.yaml';
const config = yaml.load(fs.readFileSync(path, 'utf8'));
const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const endpoints = config.endpoints ?? {};
const allowed = endpoints.agents?.allowedProviders ?? [];
assert(JSON.stringify(allowed) === JSON.stringify(['anthropic', 'MuskAPI']), 'provider allowlist mismatch');

const custom = (endpoints.custom ?? []).filter((item) => item?.name === 'MuskAPI');
assert(custom.length === 1, 'MuskAPI endpoint must exist exactly once');
const muskapi = custom[0];
assert(muskapi.apiKey === '${ANTHROPIC_API_KEY}', 'relay key must remain an env placeholder');
assert(muskapi.baseURL === 'https://api.muskapis.com/v1', 'relay base URL mismatch');
assert(JSON.stringify(muskapi.models?.default) === JSON.stringify(['gpt-5.6-sol']), 'model allowlist mismatch');
assert(muskapi.models?.fetch === false, 'model fetch must be disabled');
assert(muskapi.addParams?.reasoning_effort === 'max', 'max reasoning is missing');
assert(muskapi.customParams?.defaultParamsEndpoint === 'openAI', 'OpenAI parameter mapping is missing');
assert(muskapi.customParams?.reasoningFormat === 'reasoning_effort', 'reasoning parameter format mismatch');

const specs = config.modelSpecs?.list ?? [];
assert(specs.length === 2, 'expected exactly two model specs');
assert(specs.filter((item) => item?.default === true).map((item) => item.name).join(',') === 'gpt-5.6-sol', 'GPT must be the sole default');
const gpt = specs.find((item) => item?.name === 'gpt-5.6-sol');
const fable = specs.find((item) => item?.name === 'claude-fable-5');
assert(gpt?.preset?.endpoint === 'MuskAPI' && gpt?.preset?.model === 'gpt-5.6-sol', 'GPT model spec mismatch');
assert(gpt?.skills === true && gpt?.executeCode === true, 'GPT tools must remain enabled');
assert(fable?.default === false && fable?.preset?.endpoint === 'anthropic', 'Fable fallback mismatch');
assert(fable?.preset?.effort === 'max', 'Fable max effort changed unexpectedly');

console.log('candidate_config_validation=ok');
NODE

docker exec -i LibreChat-API node --input-type=module <<'NODE'
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  throw new Error('ANTHROPIC_API_KEY is not set');
}

const body = {
  model: 'gpt-5.6-sol',
  messages: [{ role: 'user', content: 'Call get_magic now. Do not answer normally.' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_magic',
        description: 'Return the magic value',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ],
  tool_choice: 'auto',
  reasoning_effort: 'max',
  max_completion_tokens: 128,
};

const response = await fetch('https://api.muskapis.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(150000),
});

const payload = await response.json();
if (!response.ok || payload?.error) {
  throw new Error(`relay probe failed: status=${response.status} type=${payload?.error?.type ?? 'unknown'} code=${payload?.error?.code ?? 'unknown'}`);
}
if (payload?.model !== 'gpt-5.6-sol') {
  throw new Error(`relay returned unexpected model: ${payload?.model ?? 'missing'}`);
}
const toolCall = payload?.choices?.[0]?.message?.tool_calls?.[0];
if (toolCall?.function?.name !== 'get_magic') {
  throw new Error('relay model did not return the expected function tool call');
}

console.log(`relay_model_probe=ok model=${payload.model} finish_reason=${payload.choices[0].finish_reason}`);
NODE

cp -a "$destination" "$backup"

applied=0

rollback() {
  cp -a "$backup" "$destination"
  docker restart LibreChat-API >/dev/null
  for _ in $(seq 1 60); do
    if curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

on_error() {
  rc=$?
  trap - ERR
  if [[ "$applied" == "1" ]]; then
    rollback || true
  fi
  exit "$rc"
}

trap on_error ERR

next="$destination.next-$timestamp"
cp "$candidate" "$next"
chmod --reference="$destination" "$next"
chown --reference="$destination" "$next"
applied=1
mv "$next" "$destination"

test "$(sha256sum "$candidate" | awk '{print $1}')" = "$(sha256sum "$destination" | awk '{print $1}')"

restart_since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker restart LibreChat-API >/dev/null

for _ in $(seq 1 60); do
  if [[ "$(docker inspect LibreChat-API --format '{{.State.Running}}')" == "true" ]]; then
    break
  fi
  sleep 1
done
test "$(docker inspect LibreChat-API --format '{{.State.Running}}')" = "true"

api_ready=0
for _ in $(seq 1 90); do
  if curl -ksSf https://152.32.172.162.sslip.io/api/config >/dev/null; then
    api_ready=1
    break
  fi
  sleep 1
done
test "$api_ready" = "1"

curl -ksSf https://152.32.172.162.sslip.io/ >/dev/null
test "$(curl -ksS -o /dev/null -w '%{http_code}' https://152.32.172.162.sslip.io/office/)" = "401"
test "$(docker inspect LibreChat-CodeAPI --format '{{.State.Running}}')" = "true"
test "$(docker inspect LibreChat-CodeAPI --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')" = "healthy"

if docker logs --since "$restart_since" LibreChat-API 2>&1 \
  | grep -Eiq 'failed to load custom config|custom config validation failed|invalid custom endpoint|model spec.*skipped'; then
  echo "LibreChat reported a custom-config startup error" >&2
  exit 1
fi

docker exec -i LibreChat-API node <<'NODE'
const fs = require('fs');
const yaml = require('js-yaml');
const config = yaml.load(fs.readFileSync('/app/librechat.yaml', 'utf8'));
const defaults = (config.modelSpecs?.list ?? []).filter((item) => item?.default === true);
if (defaults.length !== 1 || defaults[0].name !== 'gpt-5.6-sol') {
  throw new Error('running container does not see GPT-5.6 SOL as the sole default');
}
const endpoint = (config.endpoints?.custom ?? []).find((item) => item?.name === 'MuskAPI');
if (endpoint?.addParams?.reasoning_effort !== 'max') {
  throw new Error('running container does not see max reasoning');
}
console.log('running_config_validation=ok');
NODE

trap - ERR

printf 'timestamp=%s\n' "$timestamp"
printf 'backup=%s\n' "$backup"
sha256sum "$destination"
docker ps --format '{{.Names}} {{.Status}}' --filter name=LibreChat-API --filter name=LibreChat-CodeAPI

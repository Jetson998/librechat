import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const apiPort = Number(process.env.INTEGRATION_API_PORT || 3081);
const apiBase = `http://127.0.0.1:${apiPort}`;
const stateDir = path.resolve(process.env.INTEGRATION_STATE_DIR || '.state');
const evidenceDir = path.resolve(process.env.INTEGRATION_EVIDENCE_DIR || path.join(stateDir, 'evidence'));
const usersFile = path.resolve(
  process.env.INTEGRATION_TEST_USERS_FILE || path.join(stateDir, 'config/integration-test-users.json'),
);
const evidenceFile = path.join(evidenceDir, 'admin-access-smoke.json');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${apiBase}${pathname}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let value = null;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    value = null;
  }
  return { status: response.status, ok: response.ok, value };
}

try {
  const stored = JSON.parse(await readFile(usersFile, 'utf8'));
  assert(stored?.schemaVersion === 1 && Array.isArray(stored.users) && stored.users.length === 1,
    'exactly one integration test administrator is required');
  const user = stored.users[0];
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: user.email, password: user.password },
  });
  assert(login.ok, `administrator login returned HTTP ${login.status}`);
  const token = login.value?.token ?? login.value?.accessToken;
  assert(typeof token === 'string' && token !== '', 'administrator login returned no access token');

  const verify = await request('/api/admin/verify', { token });
  assert(verify.ok, `admin verification returned HTTP ${verify.status}`);
  assert(verify.value?.user?.role === 'ADMIN', 'admin verification did not return role ADMIN');

  const effective = await request('/api/admin/grants/effective', { token });
  assert(effective.ok, `effective capabilities returned HTTP ${effective.status}`);
  const capabilities = Array.isArray(effective.value?.capabilities) ? effective.value.capabilities : [];
  assert(capabilities.includes('manage:configs'), 'administrator lacks manage:configs');

  const config = await request('/api/admin/config/base', { token });
  assert(config.ok, `base configuration returned HTTP ${config.status}`);

  const summary = {
    schemaVersion: 1,
    status: 'passed',
    userId: user.userId,
    email: user.email,
    role: verify.value.user.role,
    adminVerifyStatus: verify.status,
    effectiveCapabilitiesStatus: effective.status,
    manageConfigs: true,
    baseConfigurationStatus: config.status,
    credentialsRecorded: false,
    productionWrite: false,
  };
  await writeFile(evidenceFile, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`admin_access_smoke=passed\nevidence_file=${evidenceFile}\n`);
} catch (error) {
  process.stderr.write(`admin access smoke failed: ${String(error?.message ?? error).slice(0, 500)}\n`);
  process.exitCode = 1;
}

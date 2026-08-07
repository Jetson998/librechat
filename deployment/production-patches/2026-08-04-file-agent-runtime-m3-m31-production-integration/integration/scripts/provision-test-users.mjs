import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const apiPort = Number(process.env.INTEGRATION_API_PORT || 3081);
const apiBase = `http://127.0.0.1:${apiPort}`;
const stateDir = path.resolve(process.env.INTEGRATION_STATE_DIR || '.state');
const evidenceDir = path.resolve(process.env.INTEGRATION_EVIDENCE_DIR || path.join(stateDir, 'evidence'));
const usersFile = path.resolve(
  process.env.INTEGRATION_TEST_USERS_FILE || path.join(stateDir, 'config/integration-test-users.json'),
);
const allowlistFile = path.resolve(
  process.env.FILE_AGENT_ALLOWLIST_HOST_FILE || path.join(stateDir, 'secrets/file-agent-allowlist'),
);
const evidenceFile = path.join(evidenceDir, 'integration-test-users.json');
const models = [
  process.env.INTEGRATION_MODEL || 'gpt-5.6-sol',
  process.env.INTEGRATION_SECOND_MODEL || 'claude-fable-5',
];
const configuredEmail = String(process.env.INTEGRATION_TEST_USER_EMAIL || '').trim();
const configuredPassword = String(process.env.INTEGRATION_TEST_USER_PASSWORD || '');

function safeText(value, limit = 500) {
  return String(value ?? '')
    .replace(/Bearer\s+[^\s]+/giu, 'Bearer [redacted]')
    .replace(/("?(?:apiKey|authorization|password|secret|token)"?\s*[:=]\s*")[^"\r\n]+/giu, '$1[redacted]')
    .slice(0, limit);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class CookieJar {
  #cookies = new Map();

  capture(headers) {
    const values = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator > 0) this.#cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  header() {
    return [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function userIdFrom(value) {
  const candidates = [value?.id, value?._id, value?.userId, value?.sub, value?.user?.id, value?.user?._id];
  return candidates.find((candidate) => typeof candidate === 'string' && candidate.trim() !== '')?.trim() ?? null;
}

async function request(pathname, { method = 'GET', jar = null, body } = {}) {
  const headers = {};
  if (jar?.header()) headers.cookie = jar.header();
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
  jar?.capture(response.headers);
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${pathname} returned ${response.status}: ${safeText(text)}`);
  return text ? JSON.parse(text) : null;
}

async function login(user) {
  const jar = new CookieJar();
  const value = await request('/api/auth/login', {
    method: 'POST',
    jar,
    body: { email: user.email, password: user.password },
  });
  let token = value?.token ?? value?.accessToken ?? null;
  if (!token) {
    const refresh = await request('/api/auth/refresh', { method: 'POST', jar, body: {} });
    token = refresh?.token ?? refresh?.accessToken ?? null;
  }
  assert(typeof token === 'string' && token !== '', 'LibreChat login did not return an access token');
  const userId = userIdFrom(value) ?? userIdFrom(decodeJwt(token));
  assert(userId, 'LibreChat login did not expose an internal user identity');
  if (user.userId) assert(user.userId === userId, `stored test user ${user.index} identity changed`);
  return { ...user, userId };
}

async function register(index, { email: requestedEmail = '', password: requestedPassword = '' } = {}) {
  const suffix = `${Date.now()}-${index}-${randomBytes(4).toString('hex')}`;
  const user = {
    index,
    models,
    name: requestedEmail ? 'Test Claude' : `File Agent Integration ${index}`,
    username: requestedEmail ? 'test' : `file-agent-integration-${suffix}`,
    email: requestedEmail || `file-agent-integration-${suffix}@example.invalid`,
    password: requestedPassword || `Integration-${randomBytes(18).toString('base64url')}`,
  };
  const jar = new CookieJar();
  await request('/api/auth/register', {
    method: 'POST',
    jar,
    body: {
      name: user.name,
      username: user.username,
      email: user.email,
      password: user.password,
      confirm_password: user.password,
    },
  });
  return login(user);
}

async function regularFileOrMissing(filename) {
  try {
    const value = await lstat(filename);
    assert(value.isFile() && !value.isSymbolicLink(), `refusing non-regular integration file: ${filename}`);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function loadOrCreateUsers() {
  if (await regularFileOrMissing(usersFile)) {
    const stored = JSON.parse(await readFile(usersFile, 'utf8'));
    assert(stored?.schemaVersion === 1 && Array.isArray(stored.users) && stored.users.length === 1,
      'stored integration test users are invalid');
    return Promise.all(stored.users.map((user) => login(user)));
  }
  let user;
  if (configuredEmail && configuredPassword) {
    try {
      user = await login({ index: 1, email: configuredEmail, password: configuredPassword, models });
    } catch {
      user = await register(1, { email: configuredEmail, password: configuredPassword });
    }
  } else {
    user = await register(1);
  }
  const users = [user];
  await writeFile(usersFile, `${JSON.stringify({
    schemaVersion: 1,
    generatedFor: 'non-production-file-agent-integration',
    users: users.map(({ index, userId, models: selectedModels, name, username, email, password }) => ({
      index, userId, models: selectedModels, name, username, email, password,
    })),
  }, null, 2)}\n`, { mode: 0o600 });
  return users;
}

try {
  assert(new Set(models).size === 2, 'integration user provisioning requires two distinct models');
  assert(Boolean(configuredEmail) === Boolean(configuredPassword),
    'configured integration test user email and password must be provided together');
  assert(await regularFileOrMissing(allowlistFile), 'integration allowlist file is missing');
  const users = await loadOrCreateUsers();
  assert(users.length === 1, 'integration environment must retain exactly one permanent test user');
  const allowlist = `${users.map((user) => user.userId).join('\n')}\n`;
  await writeFile(allowlistFile, allowlist, { mode: 0o600 });
  await writeFile(evidenceFile, `${JSON.stringify({
    schemaVersion: 1,
    status: 'passed',
    scope: 'disposable-integration-test-users',
    userCount: users.length,
    users: users.map(({ index, userId, models: selectedModels }) => ({
      index,
      userId,
      models: selectedModels,
      role: 'ADMIN',
    })),
    allowlistSha256: createHash('sha256').update(allowlist).digest('hex'),
    credentialsStoredInStateOnly: true,
    productionCredentialsUsed: false,
  }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`integration_test_users=ready\nuser_count=${users.length}\nevidence_file=${evidenceFile}\n`);
} catch (error) {
  process.stderr.write(`integration test user provisioning failed: ${safeText(error?.stack ?? error)}\n`);
  process.exitCode = 1;
}

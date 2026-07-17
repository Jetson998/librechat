'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const candidate = path.resolve(process.argv[2] || './api-index.cjs');
const { createAdminUsersHandlers } = require(candidate);

const makeResponse = () => ({
  statusCode: 200,
  body: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

const createdUser = {
  _id: { toString: () => '507f1f77bcf86cd799439011' },
  name: 'Release Test',
  email: 'admin-user-release-test@example.local',
  username: 'admin-user-release-test',
  role: 'USER',
  provider: 'local',
  createdAt: new Date('2026-07-17T00:00:00Z'),
  updatedAt: new Date('2026-07-17T00:00:00Z'),
};

async function testCreate() {
  let findCall = 0;
  let registrationInput;
  const handlers = createAdminUsersHandlers({
    findUsers: async () => (++findCall === 1 ? [] : [createdUser]),
    countUsers: async () => 1,
    deleteUserById: async () => ({ deletedCount: 1 }),
    deleteConfig: async () => undefined,
    deleteAclEntries: async () => undefined,
    registerUser: async (input, additional) => {
      registrationInput = input;
      assert.equal(input.password, 'release-test-password');
      assert.equal(input.confirm_password, 'release-test-password');
      assert.equal(Object.keys(input).includes('password'), false);
      assert.equal(Object.keys(input).includes('confirm_password'), false);
      assert.deepEqual(additional, { emailVerified: true, role: 'USER', provider: 'local' });
      return { status: 200 };
    },
  });
  const response = makeResponse();
  await handlers.createUser(
    {
      user: { id: 'admin-1' },
      body: {
        name: 'Release Test',
        email: 'ADMIN-USER-RELEASE-TEST@example.local',
        username: 'Admin-User-Release-Test',
        password: 'release-test-password',
        role: 'USER',
        emailVerified: true,
      },
    },
    response,
  );
  assert.ok(registrationInput);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.user.email, createdUser.email);
  assert.equal('password' in response.body.user, false);
}

async function testDuplicate() {
  let registerCalled = false;
  const handlers = createAdminUsersHandlers({
    findUsers: async () => [createdUser],
    countUsers: async () => 1,
    deleteUserById: async () => ({ deletedCount: 1 }),
    deleteConfig: async () => undefined,
    deleteAclEntries: async () => undefined,
    registerUser: async () => {
      registerCalled = true;
      return { status: 200 };
    },
  });
  const response = makeResponse();
  await handlers.createUser(
    {
      user: { id: 'admin-1' },
      body: {
        name: 'Duplicate',
        email: createdUser.email,
        username: createdUser.username,
        password: 'release-test-password',
      },
    },
    response,
  );
  assert.equal(response.statusCode, 409);
  assert.equal(registerCalled, false);
}

async function testValidation() {
  const handlers = createAdminUsersHandlers({
    findUsers: async () => [],
    countUsers: async () => 1,
    deleteUserById: async () => ({ deletedCount: 1 }),
    deleteConfig: async () => undefined,
    deleteAclEntries: async () => undefined,
    registerUser: async () => ({ status: 200 }),
  });
  const response = makeResponse();
  await handlers.createUser(
    {
      user: { id: 'admin-1' },
      body: {
        name: 'Short Password',
        email: 'short@example.local',
        username: 'short-password',
        password: 'short',
      },
    },
    response,
  );
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /Password/);
}

Promise.all([testCreate(), testDuplicate(), testValidation()])
  .then(() => process.stdout.write('admin_user_api_handler: ok\n'))
  .catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ROLE = 'USER' as never;

const apiFetchMock = vi.fn();
const extractApiErrorMock = vi.fn(async (_response: Response, fallback: string) => {
  throw new Error(fallback);
});

vi.mock('zod', () => {
  const schema = {
    email: () => schema,
    max: () => schema,
    min: () => schema,
  };
  return {
    z: {
      boolean: () => schema,
      nativeEnum: () => schema,
      object: () => schema,
      string: () => schema,
    },
  };
});

vi.mock('./utils/api', () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
  extractApiError: (response: Response, fallback: string) =>
    extractApiErrorMock(response, fallback),
}));

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({
    handler: (fn: (...args: unknown[]) => unknown) => fn,
    inputValidator: () => ({
      handler: (fn: (...args: unknown[]) => unknown) => fn,
    }),
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  queryOptions: (options: unknown) => options,
}));

import { createUserFn } from './users';

describe('createUserFn', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    extractApiErrorMock.mockClear();
  });

  it('forwards the complete user creation request without confirmPassword', async () => {
    const user = {
      id: 'user-1',
      name: 'Example User',
      email: 'user@example.local',
      username: 'example',
      role: USER_ROLE,
    };
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ user }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      createUserFn({
        data: {
          name: ' Example User ',
          email: ' user@example.local ',
          username: ' example ',
          password: 'password123',
          confirmPassword: 'password123',
          role: USER_ROLE,
          emailVerified: true,
        },
      }),
    ).resolves.toEqual({ user });

    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Example User',
        email: 'user@example.local',
        username: 'example',
        password: 'password123',
        role: USER_ROLE,
        emailVerified: true,
      }),
    });
  });

  it('rejects mismatched passwords before calling the API', async () => {
    await expect(
      createUserFn({
        data: {
          name: 'Example User',
          email: 'user@example.local',
          username: 'example',
          password: 'password123',
          confirmPassword: 'different123',
          role: USER_ROLE,
          emailVerified: true,
        },
      }),
    ).rejects.toThrow('Passwords do not match');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('uses the API error extractor for rejected creation requests', async () => {
    apiFetchMock.mockResolvedValue(new Response('{}', { status: 409 }));

    await expect(
      createUserFn({
        data: {
          name: 'Example User',
          email: 'user@example.local',
          username: 'example',
          password: 'password123',
          confirmPassword: 'password123',
          role: USER_ROLE,
          emailVerified: true,
        },
      }),
    ).rejects.toThrow('Failed to create user');
    expect(extractApiErrorMock).toHaveBeenCalledOnce();
  });
});

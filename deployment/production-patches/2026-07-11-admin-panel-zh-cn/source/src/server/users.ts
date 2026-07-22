/**
 * Server functions for user management.
 *
 * Calls the LibreChat Admin API (/api/admin/users) for user lifecycle actions.
 */

import { z } from 'zod';
import { queryOptions } from '@tanstack/react-query';
import { SystemRoles } from 'librechat-data-provider';
import { createServerFn } from '@tanstack/react-start';
import type { AdminUserSearchResult } from '@librechat/data-schemas';
import type { TUser } from 'librechat-data-provider';
import { apiFetch, extractApiError } from './utils/api';

// ── Server functions ─────────────────────────────────────────────────

export const getUsersFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ users: TUser[] }> => {
    const response = await apiFetch('/api/admin/users');
    if (!response.ok) {
      throw new Error(`Failed to fetch users: ${response.status}`);
    }
    const json = (await response.json()) as { users: TUser[] };
    return { users: json.users ?? [] };
  },
);

export const usersQueryOptions = queryOptions({
  queryKey: ['users'],
  queryFn: () => getUsersFn().then((r) => r.users),
  staleTime: 30_000,
});

export const createUserFn = createServerFn({ method: 'POST' })
  .inputValidator(
    z.object({
      name: z.string().min(1),
      email: z.string().email(),
      username: z.string().min(2).max(64),
      password: z.string().min(8).max(128),
      confirmPassword: z.string().min(8).max(128),
      role: z.nativeEnum(SystemRoles),
      emailVerified: z.boolean(),
    }),
  )
  .handler(async ({ data }): Promise<{ user: TUser }> => {
    if (data.password !== data.confirmPassword) {
      throw new Error('Passwords do not match');
    }
    const response = await apiFetch('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        name: data.name.trim(),
        email: data.email.trim(),
        username: data.username.trim(),
        password: data.password,
        role: data.role,
        emailVerified: data.emailVerified,
      }),
    });
    if (!response.ok) {
      await extractApiError(response, 'Failed to create user');
    }
    return (await response.json()) as { user: TUser };
  });

export const deleteUserFn = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data }) => {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(data.id)}`, {
      method: 'DELETE',
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to delete user: ${response.status}`);
    }
  });

export const searchUsersFn = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ query: z.string() }))
  .handler(async ({ data }): Promise<{ users: AdminUserSearchResult[] }> => {
    const response = await apiFetch(`/api/admin/users/search?q=${encodeURIComponent(data.query)}`);
    if (!response.ok) {
      await extractApiError(response, 'Failed to search users');
    }
    const json = (await response.json()) as { users: AdminUserSearchResult[] };
    return { users: json.users ?? [] };
  });

export interface UserBalanceAdjustment {
  adjustmentId: string;
  amountUsd: number;
  balanceAfterUsd: number | null;
  note: string;
  createdAt: string;
  administratorId: string;
}

export interface UserBalanceResponse {
  balanceEnabled: boolean;
  balanceUsd: number;
  adjustments: UserBalanceAdjustment[];
  applied?: boolean;
}

export const getUserBalanceFn = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<UserBalanceResponse> => {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(data.id)}/balance`);
    if (!response.ok) await extractApiError(response, 'Failed to load user balance');
    return (await response.json()) as UserBalanceResponse;
  });

export const adjustUserBalanceFn = createServerFn({ method: 'POST' })
  .inputValidator(
    z.object({
      id: z.string().min(1),
      adjustmentId: z.string().min(8).max(100),
      amountUsd: z
        .number()
        .finite()
        .refine((value) => value !== 0),
      note: z.string().max(200),
    }),
  )
  .handler(async ({ data }): Promise<UserBalanceResponse> => {
    const response = await apiFetch(
      `/api/admin/users/${encodeURIComponent(data.id)}/balance-adjustments`,
      {
        method: 'POST',
        body: JSON.stringify({
          adjustmentId: data.adjustmentId,
          amountUsd: data.amountUsd,
          note: data.note.trim(),
        }),
      },
    );
    if (!response.ok) await extractApiError(response, 'Failed to adjust user balance');
    return (await response.json()) as UserBalanceResponse;
  });

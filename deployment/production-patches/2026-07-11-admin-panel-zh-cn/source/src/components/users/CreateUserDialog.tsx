import { useState } from 'react';
import { SystemRoles } from 'librechat-data-provider';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type * as t from '@/types';
import { notifySuccess, notifyError } from '@/utils';
import { FormDialog } from '@/components/shared';
import { createUserFn } from '@/server';
import { useLocalize } from '@/hooks';

export function CreateUserDialog({ open, onClose }: t.CreateUserDialogProps) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [role, setRole] = useState<SystemRoles>(SystemRoles.USER);
  const [emailVerified, setEmailVerified] = useState(true);
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async ({ name: submittedName }: { name: string }) => {
      await createUserFn({
        data: {
          name: submittedName,
          email,
          username,
          password,
          confirmPassword,
          role,
          emailVerified,
        },
      });
      return { name: submittedName };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      notifySuccess(localize('com_toast_user_created', { name: data.name }));
      resetAndClose();
    },
    onError: (err: Error) => notifyError(err.message),
  });

  const resetAndClose = () => {
    setName('');
    setEmail('');
    setUsername('');
    setUsernameTouched(false);
    setPassword('');
    setConfirmPassword('');
    setRole(SystemRoles.USER);
    setEmailVerified(true);
    setError('');
    onClose();
  };

  const doSubmit = () => {
    setError('');
    if (!name.trim()) {
      setError(localize('com_access_name_required'));
      return;
    }
    if (!email.trim()) {
      setError(localize('com_users_email_required'));
      return;
    }
    if (!username.trim()) {
      setError(localize('com_users_username_required'));
      return;
    }
    if (password.length < 8) {
      setError(localize('com_users_password_min'));
      return;
    }
    if (password !== confirmPassword) {
      setError(localize('com_users_password_mismatch'));
      return;
    }
    mutation.mutate({ name });
  };

  const handleEmailChange = (value: string) => {
    setEmail(value);
    if (!usernameTouched) {
      const suggested =
        value
          .split('@')[0]
          ?.replace(/[^a-zA-Z0-9._-]/g, '')
          .slice(0, 64) ?? '';
      setUsername(suggested);
    }
  };

  return (
    <FormDialog
      open={open}
      title={localize('com_users_add')}
      submitLabel={localize('com_users_add')}
      submitDisabled={
        !name.trim() ||
        !email.trim() ||
        !username.trim() ||
        password.length < 8 ||
        password !== confirmPassword
      }
      saving={mutation.isPending}
      error={error}
      size="lg"
      onSubmit={doSubmit}
      onClose={resetAndClose}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="user-name" className="text-sm font-medium text-(--cui-color-text-default)">
          {localize('com_access_col_name')}
        </label>
        <input
          id="user-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={localize('com_users_name_placeholder')}
          autoFocus
          className="rounded-lg border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-3 py-2 text-sm text-(--cui-color-text-default) placeholder:text-(--cui-color-text-disabled)"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="user-email" className="text-sm font-medium text-(--cui-color-text-default)">
          {localize('com_auth_email_label')}
        </label>
        <input
          id="user-email"
          type="email"
          value={email}
          onChange={(e) => handleEmailChange(e.target.value)}
          placeholder={localize('com_users_email_placeholder')}
          className="rounded-lg border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-3 py-2 text-sm text-(--cui-color-text-default) placeholder:text-(--cui-color-text-disabled)"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="user-username"
          className="text-sm font-medium text-(--cui-color-text-default)"
        >
          {localize('com_users_username_label')}
        </label>
        <input
          id="user-username"
          type="text"
          value={username}
          onChange={(e) => {
            setUsernameTouched(true);
            setUsername(e.target.value);
          }}
          placeholder={localize('com_users_username_placeholder')}
          autoComplete="off"
          className="rounded-lg border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-3 py-2 text-sm text-(--cui-color-text-default) placeholder:text-(--cui-color-text-disabled)"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="user-password"
            className="text-sm font-medium text-(--cui-color-text-default)"
          >
            {localize('com_users_password_label')}
          </label>
          <input
            id="user-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={localize('com_users_password_placeholder')}
            autoComplete="new-password"
            className="rounded-lg border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-3 py-2 text-sm text-(--cui-color-text-default) placeholder:text-(--cui-color-text-disabled)"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="user-confirm-password"
            className="text-sm font-medium text-(--cui-color-text-default)"
          >
            {localize('com_users_confirm_password_label')}
          </label>
          <input
            id="user-confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder={localize('com_users_confirm_password_placeholder')}
            autoComplete="new-password"
            className="rounded-lg border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-3 py-2 text-sm text-(--cui-color-text-default) placeholder:text-(--cui-color-text-disabled)"
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="user-role" className="text-sm font-medium text-(--cui-color-text-default)">
          {localize('com_users_role_label')}
        </label>
        <select
          id="user-role"
          value={role}
          onChange={(e) => setRole(e.target.value as SystemRoles)}
          className="rounded-lg border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-3 py-2 text-sm text-(--cui-color-text-default)"
        >
          <option value={SystemRoles.USER}>{localize('com_nav_users')}</option>
          <option value={SystemRoles.ADMIN}>{localize('com_users_admins')}</option>
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm text-(--cui-color-text-default)">
        <input
          type="checkbox"
          checked={emailVerified}
          onChange={(e) => setEmailVerified(e.target.checked)}
          className="size-4 accent-(--cui-color-text-accent)"
        />
        {localize('com_users_email_verified_label')}
      </label>
    </FormDialog>
  );
}

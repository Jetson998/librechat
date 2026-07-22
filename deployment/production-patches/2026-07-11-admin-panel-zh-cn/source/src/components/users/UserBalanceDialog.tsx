import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type * as t from '@/types';
import { adjustUserBalanceFn, getUserBalanceFn } from '@/server';
import { FormDialog } from '@/components/shared';
import { useLocalize } from '@/hooks';
import { cn, notifyError, notifySuccess } from '@/utils';

const formatUsd = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);

export function UserBalanceDialog({ user, onClose }: t.UserBalanceDialogProps) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'add' | 'deduct'>('add');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const queryKey = ['userBalance', user?.id];
  const balanceQuery = useQuery({
    queryKey,
    queryFn: () => getUserBalanceFn({ data: { id: user!.id } }),
    enabled: !!user,
  });

  useEffect(() => {
    if (!user) {
      setMode('add');
      setAmount('');
      setNote('');
      setError('');
    }
  }, [user]);

  const mutation = useMutation({
    mutationFn: async () => {
      const parsed = Number(amount);
      const amountUsd = mode === 'deduct' ? -parsed : parsed;
      return adjustUserBalanceFn({
        data: {
          id: user!.id,
          adjustmentId: crypto.randomUUID().replaceAll('-', '_'),
          amountUsd,
          note,
        },
      });
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      notifySuccess(localize('com_users_balance_updated'));
      setAmount('');
      setNote('');
      setError('');
    },
    onError: (err: Error) => notifyError(err.message),
  });

  const parsedAmount = Number(amount);
  const invalidAmount = !Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedAmount > 100000;
  const submit = () => {
    setError('');
    if (invalidAmount) {
      setError(localize('com_users_balance_amount_error'));
      return;
    }
    if (mode === 'deduct' && parsedAmount > Number(balanceQuery.data?.balanceUsd || 0)) {
      setError(localize('com_users_balance_insufficient'));
      return;
    }
    mutation.mutate();
  };

  const close = () => {
    if (!mutation.isPending) onClose();
  };

  return (
    <FormDialog
      open={!!user}
      title={localize('com_users_balance_title', { name: user?.name ?? '' })}
      submitLabel={
        mode === 'add'
          ? localize('com_users_balance_add_action')
          : localize('com_users_balance_deduct_action')
      }
      submitDisabled={
        invalidAmount || balanceQuery.isLoading || balanceQuery.data?.balanceEnabled === false
      }
      saving={mutation.isPending}
      error={error || (balanceQuery.error instanceof Error ? balanceQuery.error.message : '')}
      size="lg"
      onSubmit={submit}
      onClose={close}
    >
      <div className="rounded-lg border border-(--cui-color-stroke-default) bg-(--cui-color-background-muted) p-4">
        <p className="text-xs text-(--cui-color-text-muted)">{localize('com_users_balance_current')}</p>
        <p className="mt-1 text-2xl font-semibold text-(--cui-color-text-default)">
          {balanceQuery.isLoading ? '...' : formatUsd(balanceQuery.data?.balanceUsd || 0)}
        </p>
        <p className="mt-1 text-xs text-(--cui-color-text-muted)">
          {balanceQuery.data?.balanceEnabled === false
            ? localize('com_users_balance_disabled')
            : localize('com_users_balance_admin_only')}
        </p>
      </div>

      <div
        className={cn('flex gap-1', balanceQuery.data?.balanceEnabled === false && 'opacity-50')}
        role="group"
        aria-label={localize('com_users_balance_type')}
      >
        {(['add', 'deduct'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
            disabled={balanceQuery.data?.balanceEnabled === false}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              mode === value
                ? 'bg-(--cui-color-background-active) text-(--cui-color-text-default)'
                : 'text-(--cui-color-text-muted) hover:bg-(--cui-color-background-hover)',
            )}
          >
            {value === 'add'
              ? localize('com_users_balance_add')
              : localize('com_users_balance_deduct')}
          </button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="balance-amount" className="text-sm font-medium text-(--cui-color-text-default)">
            {localize('com_users_balance_amount')}
          </label>
          <div className="flex rounded-lg border border-(--cui-color-stroke-default) bg-(--cui-color-background-default)">
            <span className="border-r border-(--cui-color-stroke-default) px-3 py-2 text-sm text-(--cui-color-text-muted)">$</span>
            <input
              id="balance-amount"
              type="number"
              min="0.000001"
              max="100000"
              step="0.000001"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              disabled={balanceQuery.data?.balanceEnabled === false}
              placeholder="10.00"
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-(--cui-color-text-default) outline-none"
              autoFocus
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="balance-note" className="text-sm font-medium text-(--cui-color-text-default)">
            {localize('com_users_balance_note')}
          </label>
          <input
            id="balance-note"
            type="text"
            maxLength={200}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={localize('com_users_balance_note_placeholder')}
            className="rounded-lg border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-3 py-2 text-sm text-(--cui-color-text-default)"
          />
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-(--cui-color-text-default)">
          {localize('com_users_balance_records')}
        </h3>
        <div className="max-h-48 overflow-auto rounded-lg border border-(--cui-color-stroke-default)">
          {(balanceQuery.data?.adjustments || []).length ? (
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-(--cui-color-background-muted) text-(--cui-color-text-muted)">
                <tr>
                  <th className="px-3 py-2 font-medium">{localize('com_users_balance_time')}</th>
                  <th className="px-3 py-2 font-medium">{localize('com_users_balance_change')}</th>
                  <th className="px-3 py-2 font-medium">{localize('com_users_balance_after')}</th>
                  <th className="px-3 py-2 font-medium">{localize('com_users_balance_note')}</th>
                </tr>
              </thead>
              <tbody>
                {balanceQuery.data!.adjustments.map((entry) => (
                  <tr key={entry.adjustmentId} className="border-t border-(--cui-color-stroke-default)">
                    <td className="whitespace-nowrap px-3 py-2 text-(--cui-color-text-muted)">
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td
                      className={cn(
                        'whitespace-nowrap px-3 py-2 font-medium',
                        entry.amountUsd >= 0
                          ? 'text-(--cui-color-text-success)'
                          : 'text-(--cui-color-text-danger)',
                      )}
                    >
                      {entry.amountUsd >= 0 ? '+' : ''}
                      {formatUsd(entry.amountUsd)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-(--cui-color-text-default)">
                      {entry.balanceAfterUsd == null ? '-' : formatUsd(entry.balanceAfterUsd)}
                    </td>
                    <td className="px-3 py-2 text-(--cui-color-text-default)">{entry.note || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="px-3 py-6 text-center text-sm text-(--cui-color-text-muted)">
              {localize('com_users_balance_no_records')}
            </p>
          )}
        </div>
      </div>
    </FormDialog>
  );
}

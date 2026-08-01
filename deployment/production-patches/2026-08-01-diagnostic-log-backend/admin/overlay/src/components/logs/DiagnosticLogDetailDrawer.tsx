import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { Button, IconButton } from '@clickhouse/click-ui';
import type { ReactNode } from 'react';
import type { DiagnosticLogEntry } from '@/server';
import { LoadingState } from '@/components/shared';
import { useLocalize } from '@/hooks';
import { diagnosticLogEntryQueryOptions } from '@/server';
import { cn } from '@/utils';

const LEVEL_LABEL_KEYS: Record<DiagnosticLogEntry['level'], string> = {
  error: 'com_diagnostic_logs_level_error',
  warning: 'com_diagnostic_logs_level_warning',
  info: 'com_diagnostic_logs_level_info',
};

const STAGE_LABEL_KEYS: Record<DiagnosticLogEntry['stage'], string> = {
  request: 'com_diagnostic_logs_stage_request',
  office_preparse: 'com_diagnostic_logs_stage_office_preparse',
  generation: 'com_diagnostic_logs_stage_generation',
  followup: 'com_diagnostic_logs_stage_followup',
};

export function DiagnosticLogDetailDrawer({
  entryId,
  open,
  onClose,
}: {
  entryId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const localize = useLocalize();
  const { data, isPending, isError } = useQuery(diagnosticLogEntryQueryOptions(entryId ?? undefined));
  const entry = data?.entry ?? null;
  const notFound = !isPending && !isError && data?.entry === null;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-(--z-overlay) bg-black/30 backdrop-blur-[1px]',
            'data-[state=closed]:animate-overlay-out data-[state=open]:animate-overlay-in',
          )}
        />
        <Dialog.Content
          aria-label={localize('com_diagnostic_logs_detail_title')}
          onEscapeKeyDown={onClose}
          className={cn(
            'fixed top-0 right-0 z-(--z-overlay) flex h-full w-full flex-col bg-(--cui-color-background-panel) shadow-xl sm:w-120',
            'border-l border-(--cui-color-stroke-default)',
            'will-change-transform',
            'data-[state=closed]:animate-drawer-out data-[state=open]:animate-drawer-in',
          )}
        >
          <Dialog.Title className="sr-only">
            {localize('com_diagnostic_logs_detail_title')}
          </Dialog.Title>
          <header className="flex items-center justify-between gap-3 border-b border-(--cui-color-stroke-default) px-4 py-3">
            <span className="text-sm font-semibold text-(--cui-color-text-default)">
              {localize('com_diagnostic_logs_detail_title')}
            </span>
            <IconButton
              icon="cross"
              type="ghost"
              size="sm"
              aria-label={localize('com_diagnostic_logs_detail_close')}
              onClick={onClose}
            />
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {isPending ? (
              <div className="flex h-full items-center justify-center px-4 py-8">
                <LoadingState />
              </div>
            ) : isError ? (
              <DetailMessage message={localize('com_diagnostic_logs_detail_load_error')} />
            ) : notFound ? (
              <DetailMessage message={localize('com_diagnostic_logs_detail_not_found')} />
            ) : entry ? (
              <DiagnosticLogDetail entry={entry} localize={localize} />
            ) : null}
          </div>

          <footer className="flex items-center justify-end border-t border-(--cui-color-stroke-default) px-4 py-3">
            <Button
              type="primary"
              label={localize('com_diagnostic_logs_detail_close')}
              onClick={onClose}
            />
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DiagnosticLogDetail({
  entry,
  localize,
}: {
  entry: DiagnosticLogEntry;
  localize: ReturnType<typeof useLocalize>;
}) {
  return (
    <div className="flex flex-col gap-5 px-4 py-4" data-diagnostic-log-detail="true">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            entry.level === 'error'
              ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200'
              : entry.level === 'warning'
                ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
                : 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
          )}
        >
          {localize(LEVEL_LABEL_KEYS[entry.level])}
        </span>
        <span className="font-mono text-xs text-(--cui-color-text-muted)">{entry.event}</span>
      </div>

      <dl className="flex flex-col gap-3">
        <DetailRow label={localize('com_diagnostic_logs_detail_stage')}>
          {localize(STAGE_LABEL_KEYS[entry.stage])}
        </DetailRow>
        <DetailRow label={localize('com_diagnostic_logs_detail_time')}>
          <div className="flex flex-col gap-0.5">
            <span>{formatTimestamp(entry.timestamp)}</span>
          <MonoValue value={entry.timestamp} />
          </div>
        </DetailRow>
        <DetailRow label={localize('com_diagnostic_logs_detail_request_id')}>
          <MonoValue value={entry.requestId} />
        </DetailRow>
        <DetailRow label={localize('com_diagnostic_logs_detail_conversation_id')}>
          <MonoValue value={entry.conversationId} />
        </DetailRow>
        <DetailRow label={localize('com_diagnostic_logs_detail_stream_id')}>
          <MonoValue value={entry.streamId} />
        </DetailRow>
        <DetailRow label={localize('com_diagnostic_logs_detail_message_id')}>
          <MonoValue value={entry.messageId} />
        </DetailRow>
        <DetailRow label={localize('com_diagnostic_logs_detail_model')}>
          {entry.model ?? '—'}
        </DetailRow>
        <DetailRow label={localize('com_diagnostic_logs_detail_error_code')}>
          {entry.errorCode ?? '—'}
        </DetailRow>
        <DetailRow label={localize('com_diagnostic_logs_detail_error_name')}>
          {entry.errorName ?? '—'}
        </DetailRow>
        <DetailRow label={localize('com_diagnostic_logs_detail_duration')}>
          {entry.durationMs == null ? '—' : `${entry.durationMs} ms`}
        </DetailRow>
        <DetailRow label={localize('com_diagnostic_logs_detail_release')}>
          {entry.release ?? '—'}
        </DetailRow>
        <DetailRow label={localize('com_diagnostic_logs_detail_user_hash')}>
          {entry.userIdHash ?? '—'}
        </DetailRow>
      </dl>

      {entry.errorMessage && (
        <DetailSection title={localize('com_diagnostic_logs_detail_error_message')}>
          <p className="whitespace-pre-wrap break-words text-sm text-(--cui-color-text-default)">
            {entry.errorMessage}
          </p>
        </DetailSection>
      )}

      {entry.stack && (
        <DetailSection title={localize('com_diagnostic_logs_detail_stack')}>
          <pre className="max-h-90 overflow-auto whitespace-pre-wrap break-words rounded-md bg-(--cui-color-background-muted) p-3 font-mono text-[11px] text-(--cui-color-text-muted)">
            {entry.stack}
          </pre>
        </DetailSection>
      )}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[128px_1fr] gap-3">
      <dt className="text-xs font-medium tracking-wide text-(--cui-color-text-muted) uppercase">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-sm text-(--cui-color-text-default)">{children}</dd>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-(--cui-color-stroke-default) pt-4">
      <h3 className="text-xs font-semibold tracking-wide text-(--cui-color-text-muted) uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function MonoValue({ value }: { value?: string }) {
  if (!value) return <span>—</span>;
  return <span className="font-mono text-xs text-(--cui-color-text-muted)">{value}</span>;
}

function DetailMessage({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 py-12 text-center text-sm text-(--cui-color-text-muted)">
      {message}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

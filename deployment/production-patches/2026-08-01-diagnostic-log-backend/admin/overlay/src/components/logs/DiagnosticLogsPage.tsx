import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Icon } from '@clickhouse/click-ui';
import type { DiagnosticLogEntry, DiagnosticLogFilters, DiagnosticLogsResult } from '@/server';
import { EmptyState, LoadingState } from '@/components/shared';
import { useDebouncedFilter, useLocalize } from '@/hooks';
import { diagnosticLogsQueryOptions } from '@/server';
import { DiagnosticLogDetailDrawer } from './DiagnosticLogDetailDrawer';

type LogLevel = 'all' | 'error' | 'warning' | 'info';
type LogStage = 'all' | 'request' | 'office_preparse' | 'generation' | 'followup';

const LEVEL_LABEL_KEYS: Record<Exclude<LogLevel, 'all'>, string> = {
  error: 'com_diagnostic_logs_level_error',
  warning: 'com_diagnostic_logs_level_warning',
  info: 'com_diagnostic_logs_level_info',
};

const STAGE_LABEL_KEYS: Record<Exclude<LogStage, 'all'>, string> = {
  request: 'com_diagnostic_logs_stage_request',
  office_preparse: 'com_diagnostic_logs_stage_office_preparse',
  generation: 'com_diagnostic_logs_stage_generation',
  followup: 'com_diagnostic_logs_stage_followup',
};

export function DiagnosticLogsPage() {
  const localize = useLocalize();
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [level, setLevel] = useState<LogLevel>('all');
  const [stage, setStage] = useState<LogStage>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const resetToFirstPage = useCallback(() => setCursorHistory([]), []);
  const searchFilter = useDebouncedFilter('', resetToFirstPage);
  const currentCursor = cursorHistory[cursorHistory.length - 1];

  const filters = useMemo<DiagnosticLogFilters>(
    () => ({
      lookup: searchFilter.debouncedValue.trim() || undefined,
      level: level === 'all' ? undefined : level,
      stage: stage === 'all' ? undefined : stage,
      from: from || undefined,
      to: to || undefined,
      cursor: currentCursor,
    }),
    [currentCursor, from, level, searchFilter.debouncedValue, stage, to],
  );

  const { data, isPending, isFetching, isError, refetch } = useQuery(
    diagnosticLogsQueryOptions(filters),
  );
  const page = !isError && data?.available === true ? data : undefined;
  const entries = page?.entries ?? [];
  const errorCount = entries.filter((entry) => entry.level === 'error').length;
  const latestTimestamp = page ? getLatestTimestamp(entries) : undefined;

  const clearFilters = () => {
    searchFilter.onChange('');
    setLevel('all');
    setStage('all');
    setFrom('');
    setTo('');
    resetToFirstPage();
  };

  const goNext = () => {
    if (page?.nextCursor) setCursorHistory((history) => [...history, page.nextCursor as string]);
  };

  const goPrevious = () => {
    setCursorHistory((history) => history.slice(0, -1));
  };

  const stateMessage = getStateMessage(localize, isPending, isError, data, entries);
  let tableBody: ReactNode;
  if (isPending) {
    tableBody = (
      <tr>
        <td colSpan={6}>
          <LoadingState />
        </td>
      </tr>
    );
  } else if (stateMessage) {
    tableBody = (
      <tr>
        <td colSpan={6}>
          <div role="status">
            <EmptyState
              className="px-4 py-12 text-center text-sm text-(--cui-color-text-muted)"
              message={stateMessage}
            />
          </div>
        </td>
      </tr>
    );
  } else {
    tableBody = entries.map((entry) => (
      <DiagnosticLogRow
        key={entry.id}
        entry={entry}
        localize={localize}
        onOpen={() => setSelectedEntryId(entry.id)}
      />
    ));
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-3 pb-6"
      data-release-marker="admin-diagnostic-logs"
    >
      <section className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-(--cui-color-title-default)">
            {localize('com_diagnostic_logs_title')}
          </h1>
          <p className="mt-1 text-sm text-(--cui-color-text-muted)">
            {localize('com_diagnostic_logs_subtitle')}
          </p>
        </div>
        <Button
          type="secondary"
          iconLeft="refresh"
          label={localize('com_diagnostic_logs_refresh')}
          onClick={() => void refetch()}
          disabled={isFetching}
        />
      </section>

      <section
        className="flex flex-wrap items-end gap-3 rounded-lg border border-(--cui-color-stroke-default) bg-(--cui-color-background-panel) p-4"
        aria-label={localize('com_a11y_filters')}
      >
        <label className="flex min-w-55 flex-1 flex-col gap-1 text-xs text-(--cui-color-text-muted)">
          {localize('com_diagnostic_logs_search')}
          <span className="relative">
            <Icon
              name="search"
              size="xs"
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-(--cui-color-text-muted)"
            />
            <input
              value={searchFilter.value}
              onChange={(event) => searchFilter.onChange(event.target.value)}
              placeholder={localize('com_diagnostic_logs_search_placeholder')}
              className="h-9 w-full rounded-md border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) pr-2.5 pl-8 text-sm text-(--cui-color-text-default) outline-none focus:border-(--cui-color-stroke-intense)"
            />
          </span>
        </label>

        <label className="flex min-w-35 flex-col gap-1 text-xs text-(--cui-color-text-muted)">
          {localize('com_diagnostic_logs_level')}
          <select
            value={level}
            onChange={(event) => {
              setLevel(event.target.value as LogLevel);
              resetToFirstPage();
            }}
            className="h-9 rounded-md border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-2.5 text-sm text-(--cui-color-text-default) outline-none focus:border-(--cui-color-stroke-intense)"
          >
            <option value="all">{localize('com_ui_all')}</option>
            <option value="error">{localize(LEVEL_LABEL_KEYS.error)}</option>
            <option value="warning">{localize(LEVEL_LABEL_KEYS.warning)}</option>
            <option value="info">{localize(LEVEL_LABEL_KEYS.info)}</option>
          </select>
        </label>

        <label className="flex min-w-42 flex-col gap-1 text-xs text-(--cui-color-text-muted)">
          {localize('com_diagnostic_logs_stage')}
          <select
            value={stage}
            onChange={(event) => {
              setStage(event.target.value as LogStage);
              resetToFirstPage();
            }}
            className="h-9 rounded-md border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-2.5 text-sm text-(--cui-color-text-default) outline-none focus:border-(--cui-color-stroke-intense)"
          >
            <option value="all">{localize('com_ui_all')}</option>
            <option value="request">{localize(STAGE_LABEL_KEYS.request)}</option>
            <option value="office_preparse">
              {localize(STAGE_LABEL_KEYS.office_preparse)}
            </option>
            <option value="generation">{localize(STAGE_LABEL_KEYS.generation)}</option>
            <option value="followup">{localize(STAGE_LABEL_KEYS.followup)}</option>
          </select>
        </label>

        <label className="flex min-w-35 flex-col gap-1 text-xs text-(--cui-color-text-muted)">
          {localize('com_diagnostic_logs_from')}
          <input
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              resetToFirstPage();
            }}
            className="h-9 rounded-md border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-2.5 text-sm text-(--cui-color-text-default) outline-none focus:border-(--cui-color-stroke-intense)"
          />
        </label>

        <label className="flex min-w-35 flex-col gap-1 text-xs text-(--cui-color-text-muted)">
          {localize('com_diagnostic_logs_to')}
          <input
            type="date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              resetToFirstPage();
            }}
            className="h-9 rounded-md border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-2.5 text-sm text-(--cui-color-text-default) outline-none focus:border-(--cui-color-stroke-intense)"
          />
        </label>

        {(searchFilter.value || level !== 'all' || stage !== 'all' || from || to) && (
          <Button
            type="danger"
            iconLeft="cross"
            label={localize('com_ui_clear')}
            onClick={clearFilters}
          />
        )}
      </section>

      <section
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
        aria-label={localize('com_diagnostic_logs_summary')}
      >
        <SummaryItem
          label={localize('com_diagnostic_logs_summary_events')}
          value={page ? String(entries.length) : '--'}
        />
        <SummaryItem
          label={localize('com_diagnostic_logs_summary_errors')}
          value={page ? String(errorCount) : '--'}
        />
        <SummaryItem
          label={localize('com_diagnostic_logs_summary_last')}
          value={latestTimestamp ? formatTimestamp(latestTimestamp) : '--'}
        />
      </section>

      <section
        className="min-h-70 overflow-hidden rounded-lg border border-(--cui-color-stroke-default) bg-(--cui-color-background-panel)"
        aria-label={localize('com_diagnostic_logs_title')}
        aria-busy={isFetching}
      >
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{localize('com_diagnostic_logs_title')}</caption>
          <thead>
            <tr className="border-b border-(--cui-color-stroke-default) bg-(--cui-color-background-muted)">
              <th scope="col" className="px-4 py-2.5 font-medium text-(--cui-color-text-muted)">
                {localize('com_diagnostic_logs_col_level')}
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium text-(--cui-color-text-muted)">
                {localize('com_diagnostic_logs_col_event')}
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium text-(--cui-color-text-muted)">
                {localize('com_diagnostic_logs_col_stage')}
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium text-(--cui-color-text-muted)">
                {localize('com_diagnostic_logs_col_context')}
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium text-(--cui-color-text-muted)">
                {localize('com_diagnostic_logs_col_time')}
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium text-(--cui-color-text-muted)">
                {localize('com_diagnostic_logs_col_details')}
              </th>
            </tr>
          </thead>
          <tbody>{tableBody}</tbody>
        </table>
      </section>

      {page && entries.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-(--cui-color-text-muted)">
          <span>
            {localize('com_diagnostic_logs_page_status', {
              page: cursorHistory.length + 1,
            })}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="secondary"
              label={localize('com_diagnostic_logs_previous')}
              onClick={goPrevious}
              disabled={cursorHistory.length === 0 || isFetching}
            />
            <Button
              type="secondary"
              label={localize('com_diagnostic_logs_next')}
              onClick={goNext}
              disabled={!page.nextCursor || isFetching}
            />
          </div>
        </div>
      )}

      <p className="text-xs text-(--cui-color-text-muted)">
        {localize('com_diagnostic_logs_privacy_note')}
      </p>

      <DiagnosticLogDetailDrawer
        entryId={selectedEntryId}
        open={selectedEntryId !== null}
        onClose={() => setSelectedEntryId(null)}
      />
    </div>
  );
}

function DiagnosticLogRow({
  entry,
  localize,
  onOpen,
}: {
  entry: DiagnosticLogEntry;
  localize: ReturnType<typeof useLocalize>;
  onOpen: () => void;
}) {
  return (
    <tr className="border-b border-(--cui-color-stroke-default) last:border-b-0">
      <td className="px-4 py-3 align-top">
        <span className="font-medium text-(--cui-color-text-default)">
          {localize(LEVEL_LABEL_KEYS[entry.level])}
        </span>
      </td>
      <td className="max-w-100 px-4 py-3 align-top">
        <div className="font-mono text-xs text-(--cui-color-text-default)">{entry.event}</div>
        {entry.errorSummary && (
          <div
            className="mt-1 truncate text-xs text-(--cui-color-text-muted)"
            title={entry.errorSummary}
          >
            {entry.errorSummary}
          </div>
        )}
      </td>
      <td className="px-4 py-3 align-top text-xs text-(--cui-color-text-muted)">
        {localize(STAGE_LABEL_KEYS[entry.stage])}
      </td>
      <td className="max-w-100 px-4 py-3 align-top font-mono text-[11px] text-(--cui-color-text-muted)">
        {formatContext(entry)}
      </td>
      <td className="whitespace-nowrap px-4 py-3 align-top text-xs text-(--cui-color-text-muted)">
        {formatTimestamp(entry.timestamp)}
      </td>
      <td className="px-4 py-3 align-top">
        <button
          type="button"
          className="rounded-md border border-(--cui-color-stroke-default) px-2.5 py-1 text-xs font-medium text-(--cui-color-text-default) hover:bg-(--cui-color-background-hover)"
          onClick={onOpen}
        >
          {localize('com_diagnostic_logs_detail_open')}
        </button>
      </td>
    </tr>
  );
}

function formatContext(entry: DiagnosticLogEntry): string {
  const parts = [
    entry.requestId && `req:${entry.requestId}`,
    entry.conversationId && `conv:${entry.conversationId}`,
    entry.streamId && `stream:${entry.streamId}`,
    entry.model,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function getStateMessage(
  localize: ReturnType<typeof useLocalize>,
  isPending: boolean,
  isError: boolean,
  data: DiagnosticLogsResult | undefined,
  entries: DiagnosticLogEntry[],
): string | null {
  if (isPending) return null;
  if (isError) return localize('com_diagnostic_logs_load_error');
  if (data?.available === false) {
    return data.reason === 'not_configured'
      ? localize('com_diagnostic_logs_not_connected')
      : localize('com_diagnostic_logs_unavailable');
  }
  if (entries.length === 0) return localize('com_diagnostic_logs_empty');
  return null;
}

function getLatestTimestamp(entries: DiagnosticLogEntry[]): string | undefined {
  return entries.reduce<string | undefined>((latest, entry) => {
    if (!latest || entry.timestamp > latest) return entry.timestamp;
    return latest;
  }, undefined);
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

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-(--cui-color-stroke-default) bg-(--cui-color-background-panel) px-4 py-3">
      <span className="text-xs text-(--cui-color-text-muted)">{label}</span>
      <span className="font-mono text-sm text-(--cui-color-text-default)">{value}</span>
    </div>
  );
}

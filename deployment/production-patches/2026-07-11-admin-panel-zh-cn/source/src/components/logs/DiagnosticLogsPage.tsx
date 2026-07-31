import { useState } from 'react';
import { Button, Icon } from '@clickhouse/click-ui';
import { EmptyState } from '@/components/shared';
import { useLocalize } from '@/hooks';

type LogLevel = 'all' | 'error' | 'warning' | 'info';
type LogStage = 'all' | 'request' | 'office_preparse' | 'generation' | 'followup';

/**
 * UI contract for the future diagnostic-events endpoint. The page intentionally
 * does not create sample rows: a visible empty state is safer than presenting
 * invented production events while the API is being implemented.
 */
export function DiagnosticLogsPage() {
  const localize = useLocalize();
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState<LogLevel>('all');
  const [stage, setStage] = useState<LogStage>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const clearFilters = () => {
    setSearch('');
    setLevel('all');
    setStage('all');
    setFrom('');
    setTo('');
  };

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
          disabled
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
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={localize('com_diagnostic_logs_search_placeholder')}
              className="h-9 w-full rounded-md border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) pr-2.5 pl-8 text-sm text-(--cui-color-text-default) outline-none focus:border-(--cui-color-stroke-intense)"
            />
          </span>
        </label>

        <label className="flex min-w-35 flex-col gap-1 text-xs text-(--cui-color-text-muted)">
          {localize('com_diagnostic_logs_level')}
          <select
            value={level}
            onChange={(event) => setLevel(event.target.value as LogLevel)}
            className="h-9 rounded-md border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-2.5 text-sm text-(--cui-color-text-default) outline-none focus:border-(--cui-color-stroke-intense)"
          >
            <option value="all">{localize('com_ui_all')}</option>
            <option value="error">{localize('com_diagnostic_logs_level_error')}</option>
            <option value="warning">{localize('com_diagnostic_logs_level_warning')}</option>
            <option value="info">{localize('com_diagnostic_logs_level_info')}</option>
          </select>
        </label>

        <label className="flex min-w-42 flex-col gap-1 text-xs text-(--cui-color-text-muted)">
          {localize('com_diagnostic_logs_stage')}
          <select
            value={stage}
            onChange={(event) => setStage(event.target.value as LogStage)}
            className="h-9 rounded-md border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-2.5 text-sm text-(--cui-color-text-default) outline-none focus:border-(--cui-color-stroke-intense)"
          >
            <option value="all">{localize('com_ui_all')}</option>
            <option value="request">{localize('com_diagnostic_logs_stage_request')}</option>
            <option value="office_preparse">
              {localize('com_diagnostic_logs_stage_office_preparse')}
            </option>
            <option value="generation">{localize('com_diagnostic_logs_stage_generation')}</option>
            <option value="followup">{localize('com_diagnostic_logs_stage_followup')}</option>
          </select>
        </label>

        <label className="flex min-w-35 flex-col gap-1 text-xs text-(--cui-color-text-muted)">
          {localize('com_diagnostic_logs_from')}
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="h-9 rounded-md border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-2.5 text-sm text-(--cui-color-text-default) outline-none focus:border-(--cui-color-stroke-intense)"
          />
        </label>

        <label className="flex min-w-35 flex-col gap-1 text-xs text-(--cui-color-text-muted)">
          {localize('com_diagnostic_logs_to')}
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="h-9 rounded-md border border-(--cui-color-stroke-default) bg-(--cui-color-background-default) px-2.5 text-sm text-(--cui-color-text-default) outline-none focus:border-(--cui-color-stroke-intense)"
          />
        </label>

        {(search || level !== 'all' || stage !== 'all' || from || to) && (
          <Button
            type="danger"
            iconLeft="cross"
            label={localize('com_ui_clear')}
            onClick={clearFilters}
          />
        )}
      </section>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label={localize('com_diagnostic_logs_summary')}>
        <SummaryItem label={localize('com_diagnostic_logs_summary_events')} value="--" />
        <SummaryItem label={localize('com_diagnostic_logs_summary_errors')} value="--" />
        <SummaryItem label={localize('com_diagnostic_logs_summary_last')} value="--" />
      </section>

      <section
        className="min-h-70 overflow-hidden rounded-lg border border-(--cui-color-stroke-default) bg-(--cui-color-background-panel)"
        aria-label={localize('com_diagnostic_logs_title')}
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
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={5}>
                <EmptyState
                  className="px-4 py-12 text-center text-sm text-(--cui-color-text-muted)"
                  message={localize('com_diagnostic_logs_not_connected')}
                />
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <p className="text-xs text-(--cui-color-text-muted)">
        {localize('com_diagnostic_logs_privacy_note')}
      </p>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-(--cui-color-stroke-default) bg-(--cui-color-background-panel) px-4 py-3">
      <span className="text-xs text-(--cui-color-text-muted)">{label}</span>
      <span className="font-mono text-sm text-(--cui-color-text-default)">{value}</span>
    </div>
  );
}

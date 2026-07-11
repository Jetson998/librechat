import { useState, useEffect } from 'react';
import type * as t from '@/types';
import { TextareaField } from './TextareaField';
import { KeyValueField } from './KeyValueField';
import { TextField } from './TextField';
import { ListField } from './ListField';
import { useLocalize } from '@/hooks';

type Mode = 'simple' | 'advanced';

function inferMode(value: t.ConfigValue): Mode {
  if (Array.isArray(value)) return 'advanced';
  if (typeof value === 'object' && value !== null) return 'advanced';
  return 'simple';
}

function isMultiEntryRecord(value: t.ConfigValue): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 1
  );
}

export function TextRecordField({
  id,
  value,
  onChange,
  disabled,
  variant,
  'aria-label': ariaLabel,
}: t.TextRecordFieldProps) {
  const localize = useLocalize();
  const [mode, setMode] = useState<Mode>(() => inferMode(value));

  const valueKind = Array.isArray(value) ? 'array' : typeof value;
  useEffect(() => {
    setMode(inferMode(value));
  }, [valueKind]); // re-sync mode when value type changes (e.g. external reset)

  const handleToggle = () => {
    if (mode === 'simple') {
      if (variant === 'record') {
        const str = typeof value === 'string' ? value : '';
        onChange(str ? { '': str } : {});
      } else {
        const str = typeof value === 'string' ? value : '';
        onChange(str ? str.split('\n\n').filter(Boolean) : []);
      }
      setMode('advanced');
    } else {
      if (variant === 'record') {
        const obj =
          typeof value === 'object' && value !== null && !Array.isArray(value)
            ? (value as Record<string, t.ConfigValue>)
            : {};
        const first = Object.values(obj)[0];
        onChange(typeof first === 'string' ? first : '');
      } else {
        const arr = Array.isArray(value) ? value : [];
        onChange(arr.filter((v): v is string => typeof v === 'string').join('\n\n'));
      }
      setMode('simple');
    }
  };

  const canSimplify =
    mode === 'advanced' && variant === 'record' ? !isMultiEntryRecord(value) : true;

  return (
    <div id={id} className="w-full max-w-75">
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={handleToggle}
          disabled={disabled || !canSimplify}
          title={!canSimplify ? localize('com_config_simplify_disabled') : undefined}
          className="rounded border border-[--click-control-border-color] px-2 py-0.5 text-xs text-[--click-text-secondary] hover:bg-[--click-control-bg-hover] disabled:opacity-50"
        >
          {mode === 'advanced' && localize('com_config_mode_simple')}
          {mode === 'simple' &&
            (variant === 'record'
              ? localize('com_config_mode_i18n')
              : localize('com_config_mode_multi'))}
        </button>
      </div>
      {mode === 'simple' && variant === 'record' && (
        <TextField
          id={`${id}-text`}
          value={typeof value === 'string' ? value : ''}
          onChange={(v) => onChange(v)}
          disabled={disabled}
          aria-label={ariaLabel}
        />
      )}
      {mode === 'simple' && variant === 'array' && (
        <TextareaField
          id={`${id}-textarea`}
          value={typeof value === 'string' ? value : ''}
          onChange={(v) => onChange(v)}
          disabled={disabled}
          rows={4}
          aria-label={ariaLabel}
        />
      )}
      {mode === 'advanced' && variant === 'record' && (
        <KeyValueField
          id={`${id}-kv`}
          pairs={objectToPairs(value)}
          onChange={(pairs) => onChange(pairsToObject(pairs))}
          disabled={disabled}
          keyPlaceholder="locale"
          valuePlaceholder="translation"
          aria-label={ariaLabel}
        />
      )}
      {mode === 'advanced' && variant === 'array' && (
        <ListField
          id={`${id}-list`}
          values={
            Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
          }
          onChange={(v) => onChange(v)}
          disabled={disabled}
          itemLabel="paragraph"
          aria-label={ariaLabel}
        />
      )}
    </div>
  );
}

function objectToPairs(value: t.ConfigValue): t.KeyValuePair[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, t.ConfigValue>).map(([key, v]) => ({
    key,
    value: typeof v === 'string' ? v : String(v ?? ''),
  }));
}

function pairsToObject(pairs: t.KeyValuePair[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const p of pairs) {
    if (p.key) result[p.key] = p.value;
  }
  return result;
}

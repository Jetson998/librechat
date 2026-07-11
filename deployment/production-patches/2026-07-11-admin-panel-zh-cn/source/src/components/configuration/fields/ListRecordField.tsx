import { useState, useEffect } from 'react';
import type * as t from '@/types';
import { ListField } from './ListField';
import { CodeField } from './CodeField';
import { useLocalize } from '@/hooks';

type Mode = 'list' | 'advanced';

function inferMode(value: t.ConfigValue): Mode {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return 'advanced';
  return 'list';
}

export function ListRecordField({
  id,
  value,
  onChange,
  disabled,
  'aria-label': ariaLabel,
}: t.ListRecordFieldProps) {
  const localize = useLocalize();
  const [mode, setMode] = useState<Mode>(() => inferMode(value));

  const valueKind = Array.isArray(value) ? 'array' : typeof value;
  useEffect(() => {
    setMode(inferMode(value));
  }, [valueKind]);

  const handleToggle = () => {
    if (mode === 'list') {
      const arr = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string')
        : [];
      const record: Record<string, Record<string, never>> = {};
      for (const key of arr) record[key] = {};
      onChange(record);
      setMode('advanced');
    } else {
      const obj =
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as Record<string, t.ConfigValue>)
          : {};
      onChange(Object.keys(obj));
      setMode('list');
    }
  };

  return (
    <div id={id} className="w-full max-w-75">
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={handleToggle}
          disabled={disabled}
          className="rounded border border-[--click-control-border-color] px-2 py-0.5 text-xs text-[--click-text-secondary] hover:bg-[--click-control-bg-hover] disabled:opacity-50"
        >
          {mode === 'list'
            ? localize('com_config_mode_advanced')
            : localize('com_config_mode_simple')}
        </button>
      </div>
      {mode === 'list' && (
        <ListField
          id={`${id}-list`}
          values={
            Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
          }
          onChange={(v) => onChange(v)}
          disabled={disabled}
          aria-label={ariaLabel}
        />
      )}
      {mode === 'advanced' && (
        <CodeField
          id={`${id}-code`}
          value={value}
          onChange={onChange}
          disabled={disabled}
          aria-label={ariaLabel}
        />
      )}
    </div>
  );
}

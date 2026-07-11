import { useState, useEffect, useRef } from 'react';
import { NumberField as CUINumberField } from '@clickhouse/click-ui';
import type * as t from '@/types';
import { useLocalize } from '@/hooks';

export function NumberField({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  min,
  max,
  step = 1,
  ...ariaProps
}: t.NumberFieldProps) {
  const localize = useLocalize();
  const [local, setLocal] = useState(value != null ? String(value) : '');
  const externalRef = useRef(value);

  useEffect(() => {
    if (value !== externalRef.current) {
      externalRef.current = value;
      setLocal(value != null ? String(value) : '');
    }
  }, [value]);

  const commit = () => {
    const parsed = local === '' ? undefined : Number(local);
    if (parsed !== externalRef.current) {
      externalRef.current = parsed;
      onChange(parsed);
    }
  };

  return (
    <div className="cui-field max-w-75">
      <CUINumberField
        id={id}
        value={local}
        onChange={setLocal}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        placeholder={placeholder ?? localize('com_ui_enter_number')}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        loading={false}
        hideControls
        {...ariaProps}
      />
    </div>
  );
}

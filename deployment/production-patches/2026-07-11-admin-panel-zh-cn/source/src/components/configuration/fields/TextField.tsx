import { useState, useEffect, useRef } from 'react';
import { TextField as CUITextField } from '@clickhouse/click-ui';
import type * as t from '@/types';
import { useLocalize } from '@/hooks';

export function TextField({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  type = 'text',
  ...ariaProps
}: t.TextFieldProps) {
  const localize = useLocalize();
  const [local, setLocal] = useState(value);
  const externalRef = useRef(value);

  useEffect(() => {
    if (value !== externalRef.current) {
      externalRef.current = value;
      setLocal(value);
    }
  }, [value]);

  const commit = () => {
    if (local !== externalRef.current) {
      externalRef.current = local;
      onChange(local);
    }
  };

  return (
    <div className="cui-field max-w-75">
      <CUITextField
        id={id}
        type={type}
        value={local}
        onChange={setLocal}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        placeholder={placeholder ?? localize('com_ui_enter_value')}
        disabled={disabled}
        {...ariaProps}
      />
    </div>
  );
}

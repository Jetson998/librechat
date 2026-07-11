import { TextAreaField } from '@clickhouse/click-ui';
import type * as t from '@/types';
import { useLocalize } from '@/hooks';

export function TextareaField({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  rows = 3,
  ...ariaProps
}: t.TextareaFieldProps) {
  const localize = useLocalize();

  return (
    <div className="cui-field max-w-75">
      <TextAreaField
        id={id}
        value={value}
        onChange={onChange}
        placeholder={placeholder ?? localize('com_ui_enter_text')}
        disabled={disabled}
        rows={rows}
        {...ariaProps}
      />
    </div>
  );
}

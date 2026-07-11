import { Switch } from '@clickhouse/click-ui';
import type * as t from '@/types';

export function ToggleField({
  id,
  checked,
  onChange,
  disabled,
  'aria-label': ariaLabel,
}: t.ToggleFieldProps) {
  return (
    <Switch
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={ariaLabel}
    />
  );
}

import { IconButton } from '@clickhouse/click-ui';
import type * as t from '@/types';

export function EditButton({ onClick, ariaLabel, size = 'sm', disabled }: t.EditButtonProps) {
  return (
    <IconButton
      icon="pencil"
      size={size}
      onClick={onClick}
      aria-label={ariaLabel}
      disabled={disabled}
    />
  );
}

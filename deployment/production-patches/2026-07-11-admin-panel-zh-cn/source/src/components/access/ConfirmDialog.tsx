import { ConfirmationDialog } from '@clickhouse/click-ui';
import type * as t from '@/types';
import { useLocalize } from '@/hooks';

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  confirmType = 'danger',
  saving,
  error,
  onConfirm,
  onCancel,
}: t.ConfirmDialogProps) {
  const localize = useLocalize();

  return (
    <ConfirmationDialog
      open={open}
      title={title}
      message={description}
      primaryActionLabel={confirmLabel}
      primaryActionType={confirmType}
      secondaryActionLabel={localize('com_ui_cancel')}
      loading={saving}
      onConfirm={onConfirm}
      onCancel={onCancel}
      showClose
      className="modal-frost"
    >
      {error && (
        <p role="alert" className="text-sm text-(--cui-color-text-danger)">
          {error}
        </p>
      )}
    </ConfirmationDialog>
  );
}

import { useState } from 'react';
import { Alert, Icon } from '@clickhouse/click-ui';
import type * as t from '@/types';
import { getScopeTypeConfig } from '@/constants';
import { useLocalize } from '@/hooks';

export function InfoBanner({
  text,
  dismissible = true,
  variant = 'info',
  scopeSelection,
  onBackToBase,
}: t.InfoBannerProps) {
  const localize = useLocalize();
  const [dismissed, setDismissed] = useState(false);

  const [prevKey, setPrevKey] = useState(`${variant}:${text}`);
  const key = `${variant}:${text}`;
  if (key !== prevKey) {
    setPrevKey(key);
    setDismissed(false);
  }

  if (dismissed) return null;

  if (
    (variant === 'scope-edit' || variant === 'scope-preview') &&
    scopeSelection?.type === 'SCOPE'
  ) {
    const scope = scopeSelection.scope;
    const config = getScopeTypeConfig(scope.principalType);

    return (
      <div
        className="scope-preview-banner flex items-center gap-2 rounded-md px-3 py-2 text-sm"
        role="status"
        aria-live="polite"
      >
        <span aria-hidden="true" style={{ color: config.color }}>
          <Icon name={config.icon} size="sm" />
        </span>
        <span className="flex-1 text-(--cui-color-text-default)">
          {localize('com_scope_editing', {
            type: localize(config.labelKey),
            name: scope.name,
          })}
        </span>
        {onBackToBase && (
          <button
            type="button"
            onClick={onBackToBase}
            className="shrink-0 cursor-pointer rounded-md border border-(--cui-color-stroke-default) bg-transparent px-2.5 py-1 text-xs font-medium text-(--cui-color-text-default) transition-colors hover:bg-(--cui-color-background-hover)"
          >
            {localize('com_scope_back_to_base')}
          </button>
        )}
      </div>
    );
  }

  return (
    <Alert
      text={text}
      state="info"
      dismissible={dismissible}
      onDismiss={() => setDismissed(true)}
    />
  );
}

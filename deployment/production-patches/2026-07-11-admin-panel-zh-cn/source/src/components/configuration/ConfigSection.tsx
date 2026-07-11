import { Icon } from '@clickhouse/click-ui';
import { useState, useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type * as t from '@/types';
import { useLocalize } from '@/hooks';
import { cn } from '@/utils';

function renderCollapsible(isExpanded: boolean, hasEverExpanded: boolean, children: ReactNode) {
  const shouldRender = isExpanded || hasEverExpanded;
  return (
    <div
      className={cn(
        'config-section-grid',
        isExpanded ? 'config-section-grid-open' : 'config-section-grid-closed',
      )}
      inert={!isExpanded ? true : undefined}
    >
      <div className="config-section-inner">
        <div className="flex flex-col gap-4 pb-4 pl-7">{shouldRender && children}</div>
      </div>
    </div>
  );
}

export function ConfigSection({
  sectionId,
  title,
  description,
  learnMoreUrl,
  children,
  hidden,
  configuredCount = 0,
  totalCount = 0,
  defaultExpanded,
  inline,
  showConfiguredOnly,
}: t.ConfigSectionProps) {
  const localize = useLocalize();
  const [isExpanded, setIsExpanded] = useState(() => defaultExpanded ?? configuredCount > 0);
  const [hasEverExpanded, setHasEverExpanded] = useState(isExpanded);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (isExpanded && !hasEverExpanded) setHasEverExpanded(true);
  }, [isExpanded, hasEverExpanded]);

  useEffect(() => {
    if (showConfiguredOnly && configuredCount > 0 && !isExpanded) setIsExpanded(true);
  }, [showConfiguredOnly]);

  const toggle = useCallback(() => setIsExpanded((prev) => !prev), []);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const expand = () => setIsExpanded(true);
    const collapse = () => setIsExpanded(false);
    el.addEventListener('config:expand', expand);
    el.addEventListener('config:collapse', collapse);
    return () => {
      el.removeEventListener('config:expand', expand);
      el.removeEventListener('config:collapse', collapse);
    };
  }, []);

  if (hidden) return null;

  const hasConfigured = configuredCount > 0;

  if (inline) {
    return (
      <section
        id={sectionId ? `section-${sectionId}` : undefined}
        aria-label={title}
        className="flex w-full flex-col"
      >
        <div className="config-row flex w-full items-center gap-6 rounded-md px-2.5 py-3">
          <div className="flex w-[20%] max-w-75 min-w-0 shrink-0 flex-col gap-1 pl-2.5">
            <span className="text-sm font-semibold text-(--cui-color-text-default)">{title}</span>
            {description && (
              <span className="text-xs text-(--cui-color-text-muted)">{description}</span>
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">{children}</div>
        </div>
        <hr className="border-(--cui-color-stroke-default)" />
      </section>
    );
  }

  return (
    <section
      ref={sectionRef}
      id={sectionId ? `section-${sectionId}` : undefined}
      aria-label={title}
      className="flex w-full flex-col"
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isExpanded}
        data-section-id={sectionId ? `section-${sectionId}` : undefined}
        className="group sticky top-0 z-(--z-sticky) flex w-full cursor-pointer items-start gap-4 rounded-lg border-none bg-(--cui-color-background-panel) px-0 py-3 text-left transition-colors select-none hover:bg-(--cui-color-background-hover)"
      >
        <span
          className={cn(
            'mt-0.5 flex shrink-0 items-center justify-center transition-transform duration-200',
            isExpanded && 'rotate-90',
          )}
        >
          <Icon name="chevron-right" size="sm" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-(--cui-color-text-default)">{title}</span>
            {totalCount > 0 && (
              <span
                className={cn(
                  'config-count-badge',
                  hasConfigured ? 'config-count-badge-active' : 'config-count-badge-muted',
                )}
              >
                {configuredCount}/{totalCount}
              </span>
            )}
          </span>
          {description && (
            <span className="text-xs text-(--cui-color-text-muted)">
              {description}
              {learnMoreUrl && (
                <>
                  {' '}
                  <a
                    href={learnMoreUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-(--cui-color-text-link) hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {localize('com_ui_read_more')}
                  </a>
                </>
              )}
            </span>
          )}
        </span>
      </button>
      {renderCollapsible(isExpanded, hasEverExpanded, children)}
      <hr className="border-(--cui-color-stroke-default)" />
    </section>
  );
}

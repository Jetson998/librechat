import type * as t from '@/types';
import { useLocalize } from '@/hooks';

export function SectionHeader({
  title,
  description,
  learnMoreUrl,
  htmlFor,
  titleAdornment,
  subtitle,
  children,
}: t.SectionHeaderProps) {
  const localize = useLocalize();

  const titleClasses = 'wrap-break-word text-sm font-medium text-(--cui-color-text-default)';

  return (
    <div className="flex w-[20%] max-w-75 min-w-0 shrink-0 flex-col gap-1 pl-2.5">
      <div className="flex flex-col">
        <span className="flex items-center gap-1.5">
          {htmlFor ? (
            <label htmlFor={htmlFor} className={titleClasses}>
              {title}
            </label>
          ) : (
            <span className={titleClasses} title={title}>
              {title}
            </span>
          )}
          {titleAdornment}
        </span>
        {subtitle}
      </div>
      {description && (
        <span className="text-sm wrap-break-word text-(--cui-color-text-muted)">
          {description}
          {learnMoreUrl && (
            <>
              {' '}
              <a
                href={learnMoreUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-(--cui-color-text-link) hover:underline"
              >
                {localize('com_ui_read_more')}
              </a>
            </>
          )}
        </span>
      )}
      {children}
    </div>
  );
}

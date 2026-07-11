import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type * as t from '@/types';
import { useLocalize } from '@/hooks';
import { cn } from '@/utils';

const LANGUAGE_OPTIONS: Array<{ value: t.LanguageOption; labelKey: t.TranslationKeys }> = [
  { value: 'zh-Hans', labelKey: 'com_language_zh_hans' },
  { value: 'en', labelKey: 'com_language_en' },
];

function getLanguageLabel(
  localize: t.LocalizeFn,
  option: (typeof LANGUAGE_OPTIONS)[number],
  compact: boolean,
): string {
  if (!compact) return localize(option.labelKey);
  if (option.value === 'zh-Hans') return localize('com_language_zh_short');
  return localize('com_language_en_short');
}

export function LanguageSelector({ compact = false }: t.LanguageSelectorProps) {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const language: t.LanguageOption = i18n.resolvedLanguage?.startsWith('en') ? 'en' : 'zh-Hans';

  const changeLanguage = useCallback(
    (value: t.LanguageOption) => {
      try {
        localStorage.setItem('i18nextLng', value);
      } catch {}
      void i18n.changeLanguage(value);
    },
    [i18n],
  );

  return (
    <div
      role="group"
      aria-label={localize('com_language_label')}
      className="flex shrink-0 gap-1 rounded-lg border border-(--cui-color-stroke-default) p-0.5"
    >
      {LANGUAGE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => changeLanguage(option.value)}
          className={cn(
            'cursor-pointer rounded-md px-3 py-1 text-xs font-medium transition-colors',
            language === option.value
              ? 'bg-(--cui-color-background-active) text-(--cui-color-text-default)'
              : 'text-(--cui-color-text-muted) hover:text-(--cui-color-text-default)',
          )}
          aria-pressed={language === option.value}
        >
          {getLanguageLabel(localize, option, compact)}
        </button>
      ))}
    </div>
  );
}

import { describe, expect, it } from 'vitest';
import i18n, { defaultLanguage, resolveLanguage, syncDocumentLanguage } from './i18n';
import translationZhHans from './zh-Hans/translation.json';
import translationEn from './en/translation.json';

const placeholders = (value: string): string[] =>
  Array.from(value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g), (match) => match[1]).sort();

describe('Admin Panel locales', () => {
  it('keeps identical keys in English and Simplified Chinese', () => {
    expect(Object.keys(translationZhHans).sort()).toEqual(Object.keys(translationEn).sort());
  });

  it('keeps identical interpolation placeholders for every key', () => {
    for (const [key, english] of Object.entries(translationEn)) {
      expect(placeholders(translationZhHans[key as keyof typeof translationZhHans])).toEqual(
        placeholders(english),
      );
    }
  });

  it('uses Simplified Chinese as the default document language', () => {
    expect(defaultLanguage).toBe('zh-Hans');
    expect(resolveLanguage(null)).toBe('zh-Hans');
    syncDocumentLanguage(defaultLanguage);
    expect(document.documentElement.lang).toBe('zh-Hans');
  });

  it('keeps the full Simplified Chinese language code supported', async () => {
    await i18n.changeLanguage(defaultLanguage);
    expect(i18n.resolvedLanguage).toBe(defaultLanguage);
    expect(i18n.t('com_language_zh_hans')).toBe('简体中文');
  });

  it('synchronizes the document language when English is selected', () => {
    expect(resolveLanguage('en')).toBe('en');
    syncDocumentLanguage('en');
    expect(document.documentElement.lang).toBe('en');
  });
});

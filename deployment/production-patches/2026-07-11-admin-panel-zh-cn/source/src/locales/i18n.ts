import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import translationEn from './en/translation.json';
import translationZhHans from './zh-Hans/translation.json';

export const defaultNS = 'translation';
export const defaultLanguage = 'zh-Hans';

export function resolveLanguage(savedLanguage: string | null): 'zh-Hans' | 'en' {
  return savedLanguage?.startsWith('en') ? 'en' : defaultLanguage;
}

function readSavedLanguage(): 'zh-Hans' | 'en' {
  if (typeof localStorage === 'undefined') return defaultLanguage;
  try {
    return resolveLanguage(localStorage.getItem('i18nextLng'));
  } catch {
    return defaultLanguage;
  }
}

export const resources = {
  en: { translation: translationEn },
  'zh-Hans': { translation: translationZhHans },
} as const;

i18n.use(initReactI18next).init({
    supportedLngs: ['zh-Hans', 'en'],
    nonExplicitSupportedLngs: true,
    load: 'currentOnly',
    fallbackLng: {
      'zh-Hans': ['en'],
      en: ['en'],
      default: [defaultLanguage, 'en'],
    },
    fallbackNS: 'translation',
    ns: ['translation'],
    debug: false,
    defaultNS,
    resources,
    lng: readSavedLanguage(),
    interpolation: { escapeValue: false },
});

export function syncDocumentLanguage(language: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language.startsWith('en') ? 'en' : defaultLanguage;
}

syncDocumentLanguage(i18n.resolvedLanguage ?? i18n.language ?? defaultLanguage);
i18n.on('languageChanged', syncDocumentLanguage);

export default i18n;

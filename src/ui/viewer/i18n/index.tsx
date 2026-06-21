import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { en, TranslationKeys } from './locales/en';
import { zhCN } from './locales/zh-CN';

export type Locale = 'en' | 'zh-CN';

const LOCALES: Record<Locale, TranslationKeys> = {
  'en': en,
  'zh-CN': zhCN,
};

const STORAGE_KEY = 'claude-mem-locale';

/**
 * Detect the user's preferred locale from browser settings.
 * Returns 'zh-CN' if any Chinese variant is detected, otherwise 'en'.
 */
function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored in LOCALES) {
      return stored as Locale;
    }
  } catch {
    // localStorage unavailable
  }

  const languages = navigator.languages || [navigator.language];
  for (const lang of languages) {
    const normalized = lang.toLowerCase();
    if (normalized.startsWith('zh')) {
      return 'zh-CN';
    }
  }
  return 'en';
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TranslationKeys;
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  setLocale: () => {},
  t: en,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    try {
      localStorage.setItem(STORAGE_KEY, newLocale);
    } catch {
      // localStorage unavailable
    }
    // Update html lang attribute
    document.documentElement.lang = newLocale === 'zh-CN' ? 'zh-CN' : 'en';
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh-CN' ? 'zh-CN' : 'en';
  }, [locale]);

  const t = LOCALES[locale];

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}

export { LOCALES };

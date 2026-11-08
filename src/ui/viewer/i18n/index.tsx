import React, { createContext, useContext, useSyncExternalStore } from 'react';
import { en, TranslationKeys } from './locales/en';
import { zhCN } from './locales/zh-CN';

import { getLocale, setLocale, subscribeLocale, type Locale } from '../../i18n/core';
export type { Locale } from '../../i18n/core';
const LOCALES: Record<Locale, TranslationKeys> = {
  'en': en,
  'zh-CN': zhCN,
};

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TranslationKeys;
}

export const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  setLocale: () => {},
  t: en,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => 'en' as Locale);

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

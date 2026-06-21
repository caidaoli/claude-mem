import React from 'react';
import { useI18n, Locale } from '../i18n';

const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'en', label: 'EN' },
  { value: 'zh-CN', label: '中文' },
];

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  return (
    <select
      className="language-switcher"
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      title={t.language.label}
      aria-label={t.language.label}
    >
      {LOCALE_OPTIONS.map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

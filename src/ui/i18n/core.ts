// Browser binding for the DOM-free locale state shared by both React bundles.
import { LANGUAGE_STORAGE_KEY, type Locale } from './locale.ts';
import { getLocale, switchLocale, subscribeLocale } from './state.ts';

export { getLocale, subscribeLocale, type Locale } from './state.ts';
export { interpolate } from './locale.ts';

function readLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === 'en' || stored === 'zh-CN') return stored;
  } catch {
    // Browser privacy settings may deny storage; language selection still works.
  }
  return (navigator.languages ?? [navigator.language]).some(language => language.toLowerCase().startsWith('zh')) ? 'zh-CN' : 'en';
}

export function setLocale(locale: Locale): void {
  try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, locale); }
  catch { /* Keep the explicit choice in memory when storage is unavailable. */ }
  switchLocale(locale);
}

if (typeof document !== 'undefined') {
  switchLocale(readLocale());
  const applyLanguage = () => { document.documentElement.lang = getLocale(); };
  applyLanguage();
  subscribeLocale(applyLanguage);
  window.addEventListener('storage', event => {
    if (event.key === LANGUAGE_STORAGE_KEY || event.key === null) switchLocale(readLocale());
  });
}

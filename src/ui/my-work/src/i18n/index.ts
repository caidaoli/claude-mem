import { useSyncExternalStore } from 'react'
import { getLocale, subscribeLocale, switchLocale, t, type Locale } from './translate.ts'

export { getLocale, intlLocale, subscribeLocale, t, type Locale } from './translate.ts'

// Shared with the memory viewer, so both pages follow one choice.
const STORAGE_KEY = 'claude-mem-locale'

function detectLocale(): Locale {
  // Server rendering and tests stay English regardless of the host's language.
  if (typeof document === 'undefined') return 'en'
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'en' || stored === 'zh-CN') return stored
  } catch { /* Browser storage may be unavailable. */ }
  return (navigator.languages ?? [navigator.language]).some((language) => language?.toLowerCase().startsWith('zh')) ? 'zh-CN' : 'en'
}

function applyDocumentLocale() {
  if (typeof document === 'undefined') return
  document.documentElement.lang = getLocale()
  document.title = t('My Work · claude-mem')
}

switchLocale(detectLocale())
applyDocumentLocale()
subscribeLocale(applyDocumentLocale)

export function setLocale(next: Locale) {
  try { localStorage.setItem(STORAGE_KEY, next) } catch { /* Browser storage may be unavailable. */ }
  switchLocale(next)
}

/** Re-renders the caller when the language changes. The app root uses it; memo() components that call t() need it too. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale)
}

import { useSyncExternalStore } from 'react'
import { getLocale, subscribeLocale, t, type Locale } from './translate.ts'

export { getLocale, intlLocale, subscribeLocale, t, type Locale } from './translate.ts'

export { setLocale } from '../../../i18n/core.ts'

function applyDocumentLocale() {
  if (typeof document === 'undefined') return
  document.documentElement.lang = getLocale()
  document.title = t('My Work · claude-mem')
}

applyDocumentLocale()
subscribeLocale(applyDocumentLocale)

/** Re-renders the caller when the language changes. The app root uses it; memo() components that call t() need it too. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale)
}

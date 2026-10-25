import { APP_ZH_CN } from './zh-CN/app.ts'
import { SETUP_ZH_CN } from './zh-CN/setup.ts'
import { STEER_ZH_CN } from './zh-CN/steer.ts'
import { WORK_ZH_CN } from './zh-CN/work.ts'

/**
 * Fork localization. Source text stays English and doubles as the key, so
 * upstream copy edits only fall back to English instead of breaking the build.
 * Call t() while rendering or mapping a model, never at module scope: a language
 * switch re-renders the tree but cannot reach strings captured at import time.
 *
 * This file stays free of DOM and React so the live models can use it under node;
 * index.ts binds it to the browser.
 */
export type Locale = 'en' | 'zh-CN'

const ZH_CN: Readonly<Record<string, string>> = { ...APP_ZH_CN, ...WORK_ZH_CN, ...STEER_ZH_CN, ...SETUP_ZH_CN }

let current: Locale = 'en'
const listeners = new Set<() => void>()

export const getLocale = (): Locale => current

/** Changes the language and notifies subscribers. The browser's setLocale() also remembers the choice. */
export function switchLocale(next: Locale) {
  if (next === current) return
  current = next
  for (const listener of listeners) listener()
}

/** Calls listener after every language change; returns the unsubscribe. */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Translates English source text; `{name}` placeholders are filled from vars after translation. */
export function t(text: string, vars?: Readonly<Record<string, string | number>>): string {
  const template = current === 'zh-CN' ? ZH_CN[text] ?? text : text
  return vars ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : template
}

/** The Intl locale for dates and numbers shown in the chosen language. */
export const intlLocale = (): string => (current === 'zh-CN' ? 'zh-CN' : 'en-US')

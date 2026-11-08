import type { Locale } from './locale.ts';

export type { Locale } from './locale.ts';
let current: Locale = 'en';
const listeners = new Set<() => void>();

export const getLocale = (): Locale => current;

export function switchLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  listeners.forEach(listener => listener());
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

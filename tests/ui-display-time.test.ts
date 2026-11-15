import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { setLocale } from '../src/ui/i18n/core';
import { displayTime } from '../src/ui/my-work/src/lib/display-time';

// My Work shows model-written display dates such as "Today 3:45 pm"; only the UI language changes how they read.
describe('displayTime', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  beforeAll(() => {
    let stored: string | null = null;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
      getItem: () => stored,
      setItem: (_key: string, value: string) => { stored = value; },
    } } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { lang: 'en' } } });
  });
  afterAll(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  });

  it('leaves English as written', () => {
    setLocale('en');
    expect(displayTime('Today 3:45 pm')).toBe('Today 3:45 pm');
  });

  it('keeps the Chinese wording as before', () => {
    setLocale('zh-CN');
    expect(displayTime('Today 3:45 pm')).toBe('今天 3:45 下午');
    expect(displayTime('Nov 3')).toBe('11月3日');
  });

  it('uses French dates and a 24-hour clock', () => {
    setLocale('fr');
    expect(displayTime('Today 3:45 pm')).toBe('Aujourd’hui 15:45');
    expect(displayTime('Yesterday 9:05am')).toBe('Hier 09:05');
    expect(displayTime('12:00 am')).toBe('00:00');
    expect(displayTime('12:00 pm')).toBe('12:00');
    expect(displayTime('Nov 3')).toBe('3 nov.');
    const date = new Date(2026, 10, 3, 15, 45);
    expect(displayTime(date.toISOString())).toBe(new Intl.DateTimeFormat('fr', {
      dateStyle: 'medium', timeStyle: 'short',
    }).format(date));
  });
});

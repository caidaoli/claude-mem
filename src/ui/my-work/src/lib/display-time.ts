import { getLocale, type Locale } from '@/i18n'

const WORDS: Partial<Record<Locale, Record<string, string>>> = {
  'zh-CN': { Today: '今天', Yesterday: '昨天', am: '上午', pm: '下午' },
  fr: { Today: 'Aujourd’hui', Yesterday: 'Hier' },
}

/** Localize recorded display dates without changing model timestamps or their sort keys. */
export function displayTime(value: string): string {
  const locale = getLocale()
  const words = WORDS[locale]
  if (!words || !value) return value
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const text = value.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})\b/g, (_, month, day) =>
    new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(2026, months.indexOf(month), Number(day))))
    .replace(/\b(Today|Yesterday)\b/g, (word: string) => words[word] ?? word)
  if (locale === 'fr') {
    return text.replace(/\b(0?[1-9]|1[0-2]):([0-5]\d) ?(am|pm)\b/g, (_, hour, minutes, half) => {
      const hours = Number(hour) % 12 + (half === 'pm' ? 12 : 0)
      return `${String(hours).padStart(2, '0')}:${minutes}`
    })
  }
  return text.replace(/\b(am|pm)\b/g, (half: string) => words[half] ?? half)
}

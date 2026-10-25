import { LanguagesIcon } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { setLocale, t, useLocale, type Locale } from '@/i18n'

const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'en', label: 'EN' },
  { value: 'zh-CN', label: '中文' },
]

/** Same choice as the memory viewer's switcher: both read and write claude-mem-locale. */
export function LanguageSwitcher() {
  const locale = useLocale()
  return (
    <Select value={locale} onValueChange={(value) => setLocale(value as Locale)}>
      <SelectTrigger size="sm" className="gap-1 px-2 text-xs" aria-label={t('Language')} title={t('Language')}>
        <LanguagesIcon className="size-3.5 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {LOCALE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value} className="text-xs">{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

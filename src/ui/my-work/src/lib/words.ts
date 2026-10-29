// Small wording helpers shared by the focus screens.
import { t } from '@/i18n'

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
/** "asked once", "asked 3×": how often the owner asked, as the owner-goals run counted it. */
export const timesLabel = (times: number) => times === 1 ? t('asked once') : t('asked {count}×', { count: times })

import { getLocale } from '../../i18n/core';

export function formatDate(epoch: number): string {
  return new Date(epoch).toLocaleString(getLocale());
}

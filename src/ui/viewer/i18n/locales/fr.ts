import { viewerFr } from '../../../i18n/viewer-fr.ts';
import { settingsFr } from '../../../i18n/settings-fr.ts';
import { en, type TranslationKeys } from './en.ts';

const catalog: Record<string, string> = { ...viewerFr, ...settingsFr };
type Messages = { readonly [key: string]: string | Messages };

// Adapt upstream's English-keyed catalog to the viewer's typed message tree.
function translate(messages: Messages): Messages {
  return Object.fromEntries(Object.entries(messages).map(([key, value]) => [
    key, typeof value === 'string' ? catalog[value] ?? value : translate(value),
  ]));
}

export const fr = translate(en) as TranslationKeys;

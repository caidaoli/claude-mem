import { en, type TranslationKeys } from '../viewer/i18n/locales/en';

/** Translate application-owned errors while preserving opaque server details. */
export function translateViewerError(message: string, t: TranslationKeys): string {
  for (const key of Object.keys(en.deleteFailure) as (keyof typeof en.deleteFailure)[]) {
    if (message === en.deleteFailure[key]) return t.deleteFailure[key];
  }
  for (const key of ['loadFailed', 'historyChanged', 'refreshOverloaded', 'refreshFailed', 'latestNotice'] as const) {
    if (message === en.feed[key]) return t.feed[key];
  }
  for (const key of ['historyChanged', 'invalidPage'] as const) {
    if (message === en.sessions[key]) return t.sessions[key];
  }

  const http = /^Not deleted: the worker answered HTTP (\d+)\.$/.exec(message);
  if (http) return t.deleteFailure.httpStatus.replace('{status}', http[1]);

  const page = /^Failed to load (observations|summaries|prompts): ([\s\S]*)$/.exec(message);
  if (page) {
    return t.feed.pageFailed.replace('{kind}', t.feed[page[1] as 'observations' | 'summaries' | 'prompts'])
      .replace('{error}', () => page[2]);
  }

  const timeout = /^Loading (observations|summaries|prompts) timed out\. Try again\.$/.exec(message);
  if (timeout) return t.feed.loadTimedOut.replace('{kind}', t.feed[timeout[1] as 'observations' | 'summaries' | 'prompts']);

  const sessionsPrefix = 'Could not load sessions: ';
  if (message.startsWith(sessionsPrefix)) {
    return t.sessions.loadFailed.replace('{error}', () => message.slice(sessionsPrefix.length));
  }
  const refreshPrefix = `${en.feed.refreshFailed} `;
  if (message.startsWith(refreshPrefix)) {
    return `${t.feed.refreshFailed} ${translateViewerError(message.slice(refreshPrefix.length), t)}`;
  }
  return message;
}

/** Settings state stays in English, including unmodified server response details. */
export function translateSettingsStatus(message: string, t: TranslationKeys): string {
  for (const [prefix, template] of [
    ['Could not load settings: ', t.settings.loadFailed],
    ['\u2717 Error: ', t.settings.saveError],
  ]) {
    if (message.startsWith(prefix)) {
      return template.replace('{error}', () => message.slice(prefix.length));
    }
  }
  if (message === en.settings.saving) return t.settings.saving;
  if (message === en.settings.saved) return t.settings.saved;
  return message;
}

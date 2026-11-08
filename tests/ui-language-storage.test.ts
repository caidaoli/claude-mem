import { it } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';

it('shares the saved language, keeps denied writes in memory and follows changes from another page', () => {
  const html = { lang: 'en' };
  let stored = 'en';
  let denyWrite = true;
  let onStorage!: (event: { key: string }) => void;
  const localStorage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { if (denyWrite) throw new Error('quota'); stored = value; },
  };
  const compiled = buildSync({ entryPoints: [fileURLToPath(new URL('../src/ui/i18n/core.ts', import.meta.url))],
    bundle: true, write: false, platform: 'browser', format: 'cjs' }).outputFiles[0].text;
  const module = { exports: {} as typeof import('../src/ui/i18n/core.ts') };
  runInNewContext(compiled, { module, exports: module.exports,
    window: { localStorage, addEventListener(_event: string, listener: typeof onStorage) { onStorage = listener; } },
    document: { documentElement: html }, navigator: { languages: ['zh-CN'] } });
  const { getLocale, setLocale } = module.exports;
  assert.equal(getLocale(), 'en');
  setLocale('zh-CN');
  assert.equal(getLocale(), 'zh-CN');
  assert.equal(html.lang, 'zh-CN');
  assert.equal(stored, 'en');
  setLocale('en');
  assert.equal(getLocale(), 'en');
  denyWrite = false;
  setLocale('zh-CN');
  assert.equal(stored, 'zh-CN');
  stored = 'en';
  onStorage({ key: 'claude-mem-locale' });
  assert.equal(getLocale(), 'en');
  assert.equal(html.lang, 'en');
});

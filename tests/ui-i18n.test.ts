import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { LOCALE_NAMES, parseLocale, interpolate, placeholders } from '../src/ui/i18n/locale.ts';
import { APP_ZH_CN } from '../src/ui/my-work/src/i18n/zh-CN/app.ts';
import { WORK_ZH_CN } from '../src/ui/my-work/src/i18n/zh-CN/work.ts';
import { STEER_ZH_CN } from '../src/ui/my-work/src/i18n/zh-CN/steer.ts';
import { SETUP_ZH_CN } from '../src/ui/my-work/src/i18n/zh-CN/setup.ts';
import { viewerFr } from '../src/ui/i18n/viewer-fr.ts';
import { myworkFr } from '../src/ui/i18n/mywork-fr.ts';
import { setupFr } from '../src/ui/i18n/setup-fr.ts';
import { settingsFr } from '../src/ui/i18n/settings-fr.ts';
import { fr } from '../src/ui/viewer/i18n/locales/fr.ts';
import { t, intlLocale, getLocale, switchLocale } from '../src/ui/my-work/src/i18n/translate.ts';
const catalogs = { APP_ZH_CN, WORK_ZH_CN, STEER_ZH_CN, SETUP_ZH_CN, viewerFr, myworkFr, setupFr, settingsFr };

describe('UI language catalogs', () => {
  it('keeps English as the default and accepts the supported Chinese locale', () => {
    assert.equal(parseLocale(null), 'en');
    assert.equal(parseLocale('fr'), 'fr');
    assert.equal(LOCALE_NAMES.fr, 'Français');
    assert.equal(parseLocale('fr-FR'), 'en');
    assert.equal(parseLocale('zh-CN'), 'zh-CN');
  });

  it('uses French in the typed viewer and My Work without changing user values', () => {
    assert.equal(fr.sessions.actions, 'Actions de la session');
    assert.equal(fr.language.label, 'Langue');
    const previous = getLocale();
    try {
      switchLocale('fr');
      assert.equal(intlLocale(), 'fr');
      assert.equal(t('at this pace, about {day}', { day: '3 nov.' }), 'à ce rythme, vers le 3 nov.');
      assert.equal(t('From {count} messages across {names}: the bigger picture of what you’re working toward.', {
        count: 2, names: '$& {count}',
      }), 'À partir de 2 messages provenant de $& {count} : une vue d’ensemble de vos objectifs.');
    } finally {
      switchLocale(previous);
    }
  });

  it('interpolates values without interpreting them as replacement syntax', () => {
    assert.equal(interpolate('Delete {count} items for {name}?', { count: 2, name: '$&' }), 'Delete 2 items for $&?');
    assert.equal(interpolate('{unknown}', {}), '{unknown}');
  });

  for (const [name, catalog] of Object.entries(catalogs)) {
    it(`${name} has nonempty translations and preserves interpolation placeholders`, () => {
      assert.ok(Object.keys(catalog).length > 0);
      for (const [english, chinese] of Object.entries(catalog)) {
        assert.ok(english.trim(), `${name}: empty source`);
        assert.ok(chinese.trim(), `${name}: empty translation for ${english}`);
        assert.deepEqual(placeholders(chinese), placeholders(english), `${name}: ${english}`);
      }
    });
  }

  it('every literal t() call has a catalog entry', () => {
    const catalog = { ...APP_ZH_CN, ...WORK_ZH_CN, ...STEER_ZH_CN, ...SETUP_ZH_CN };
    const missing: string[] = [];
    function scan(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { scan(path); continue; }
        if (!/\.tsx?$/.test(path) || path.includes('.test.')) continue;
        const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
        function visit(node: ts.Node) {
          if (ts.isCallExpression(node) && node.expression.getText(source) === 't'
            && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
            const key = node.arguments[0].text;
            if (!(key in catalog) && key !== 'GitHub') missing.push(`${path}: ${key}`);
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
    const root = fileURLToPath(new URL('../src/ui/', import.meta.url));
    scan(join(root, 'my-work/src'));
    assert.deepEqual(missing, []);
  });

  for (const catalogs of [
    [viewerFr, myworkFr, setupFr, settingsFr],
  ]) {
    it('shared English phrases have the same translation across catalogs', () => {
      const seen = new Map<string, string>();
      for (const catalog of catalogs) {
        for (const [key, value] of Object.entries(catalog)) {
          if (seen.has(key)) assert.equal(value, seen.get(key), key);
          seen.set(key, value);
        }
      }
    });
  }
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parseLocale, interpolate, placeholders } from '../src/ui/i18n/locale.ts';
import { APP_ZH_CN } from '../src/ui/my-work/src/i18n/zh-CN/app.ts';
import { WORK_ZH_CN } from '../src/ui/my-work/src/i18n/zh-CN/work.ts';
import { STEER_ZH_CN } from '../src/ui/my-work/src/i18n/zh-CN/steer.ts';
import { SETUP_ZH_CN } from '../src/ui/my-work/src/i18n/zh-CN/setup.ts';
const catalogs = { APP_ZH_CN, WORK_ZH_CN, STEER_ZH_CN, SETUP_ZH_CN };

describe('UI language catalogs', () => {
  it('keeps English as the default and accepts the supported Chinese locale', () => {
    assert.equal(parseLocale(null), 'en');
    assert.equal(parseLocale('fr'), 'en');
    assert.equal(parseLocale('zh-CN'), 'zh-CN');
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

});

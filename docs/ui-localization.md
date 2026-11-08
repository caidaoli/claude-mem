# UI language: English and Simplified Chinese

The classic memory viewer (`/viewer`), My Work, first-run setup, and Observation
TV support English and Simplified Chinese. Use the **Language** menu in the
viewer header, My Work header, or setup header to select **简体中文**.

The saved choice takes precedence; otherwise Chinese browser locales use Simplified Chinese
and other locales use English. The choice is saved under `claude-mem-locale` in browser local storage and
shared between pages on the same origin (including TV); it does not change
worker configuration or send a language setting to any provider. If browser
storage is unavailable, the choice lasts for the current page.

## What is translated

Application navigation, headings, controls, state labels, prompts, confirmation
dialogs, accessibility labels, settings descriptions and known UI error envelopes.
Recorded requests, memory titles, narratives, quotes, file paths, model identifiers,
commands, product names and opaque server error details remain verbatim.
The display language does not change the language of generated memories. Configure
`CLAUDE_MEM_MODE=code--zh` separately when Chinese observations are wanted.

## Development

- `src/ui/i18n/core.ts`: shared locale storage and subscriptions, without React.
- `src/ui/i18n/locale.ts`: locale normalization and safe placeholder interpolation.
- Viewer components use `useI18n()` and typed keys from `src/ui/viewer/i18n/locales/`.
- My Work and setup use `t('English {name}', { name })`, with dictionaries in
  `src/ui/my-work/src/i18n/zh-CN/`; `useLocale()` subscribes memoized components.
- `UiMessage` keeps application-owned templates separate from opaque server errors
  and user text, so changing language does not alter stored evidence or repeat requests.
- Values are substituted once, preserving dollar signs and placeholder-like text.

Run `npm run typecheck` at the repository root, then `npm run build` and `npm test`
in `src/ui/my-work`. Additional checks run with:

```sh
node --test tests/ui-i18n.test.ts tests/ui-mywork-interpolation.test.ts
# Viewer tests import TSX; use Bun as in the existing viewer test suite:
bun test tests/viewer/i18n-errors.test.ts
```

The tests verify catalog content, matching placeholders, coverage
of literal `t()` calls, safe user-text interpolation and language-independent
stored error messages. They do not claim every possible server-produced message
is translated.

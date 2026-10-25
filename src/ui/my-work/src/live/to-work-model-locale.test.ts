// Fork: the work model formats its display times in the chosen language (i18n/translate.ts).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { switchLocale, type Locale } from '../i18n/translate.ts'
import { measuredEstimate } from './measured-estimate.ts'
import { toWorkModel } from './to-work-model.ts'
import type { WorkViewSnapshot } from './work-view-api-types.ts'

const snapshot = JSON.parse(readFileSync(new URL('../../test-fixtures/work-view-snapshot.trimmed.json', import.meta.url), 'utf8')) as WorkViewSnapshot
const open = snapshot.humanRequests.find((raw) => raw.startedAtEpoch && !raw.completedAtEpoch && raw.progress?.state !== 'shipped')

function mapIn(locale: Locale, now: number) {
  switchLocale(locale)
  try {
    return toWorkModel(snapshot, now).requests.find((request) => request.id === open?.id)
  } finally {
    switchLocale('en')
  }
}

test('start and running times follow the chosen language', () => {
  assert.ok(open?.startedAtEpoch, 'fixture has an open request with a start time')
  const now = open.startedAtEpoch + 29 * 60_000
  const en = mapIn('en', now)
  const zh = mapIn('zh-CN', now)
  // ICU differs between runtimes ("Oct 20, 10:29 pm" under node, "Oct 20 at 10:29 pm" under bun); only the shape is fixed.
  assert.match(en?.startedAt ?? '', /^[A-Z][a-z]{2} \d{1,2}\b.*\d{1,2}:\d{2} [ap]m$/)
  assert.equal(en?.runningFor, '29 min')
  assert.match(zh?.startedAt ?? '', /^\d{1,2}月\d{1,2}日.*\d{1,2}:\d{2}$/)
  assert.equal(zh?.runningFor, '29 分钟')
})

test('the ship estimate reads in the chosen language', () => {
  const readings = [{ at: '2026-10-20T12:00:00Z', percent: 40 }, { at: '2026-10-21T12:00:00Z', percent: 60 }]
  switchLocale('zh-CN')
  try {
    assert.match(measuredEstimate(readings, false) ?? '', /^按此进度，预计 \d{1,2}月\d{1,2}日$/)
  } finally {
    switchLocale('en')
  }
})

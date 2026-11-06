// Fork: the work model formats its display times in the chosen language (i18n/translate.ts).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { switchLocale, type Locale } from '../i18n/translate.ts'
import { measuredEstimate } from './measured-estimate.ts'
import { localizeWorkModel } from './localize-work-model.ts'
import { toWorkModel } from './to-work-model.ts'
import type { WorkViewGoalList, WorkViewSnapshot } from './work-view-api-types.ts'

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

test('serialized display facts remap requests, rules, periods and run times without the raw snapshot', () => {
  const raw = structuredClone(snapshot)
  const goals = JSON.parse(readFileSync(new URL('../../test-fixtures/work-view-goals.scrubbed.json', import.meta.url), 'utf8')) as { goals: WorkViewGoalList; goalHistory: WorkViewGoalList[] }
  Object.assign(raw, goals)
  const at = '2026-10-20T12:00:00Z'
  const epoch = Date.parse(at)
  const now = Date.parse('2026-10-22T12:00:00Z')
  raw.humanRequests[0].lifecycle = null
  raw.humanRequests[0].completedAtEpoch = epoch
  raw.humanRequests[0].progress = { state: 'shipped', percent: 100, checkedAt: at, shippedAt: at, milestones: [{ at, text: 'Recorded milestone' }] }
  raw.humanRequests[0].review = { checked: true, checkedAtEpoch: epoch, available: true }
  raw.humanRequests[1].lifecycle = null
  raw.humanRequests[1].progress = { state: 'in-progress', percent: 60, checkedAt: at, readings: [
    { at: '2026-10-19T12:00:00Z', percent: 40 }, { at, percent: 60 },
  ] }
  raw.agents[0].isSubagent = true
  raw.agents[0].presence = { status: 'finished', finishedAt: at }
  raw.rules = [{ ruleId: 'rule', scopeId: 'everywhere', scopeTier: 'everywhere', scopeName: 'Everywhere', when: '', then: 'Keep recorded evidence.',
    setBy: 'owner', status: 'replaced', kind: 'directive', source: 'request-progress', timesSeen: 1, latestAt: at,
    quotes: [{ at, quote: 'Keep the evidence.', kind: 'directive' }], replacedBy: 'new-rule', replacedAt: at, savedAt: at }]
  raw.ruleScopes = [{ id: 'everywhere', tier: 'everywhere', name: 'Everywhere' }]
  raw.rulesLearning = { preferencesFound: 1, newSuggestions: 0, reviewsRead: 1, writtenAt: at }
  raw.story = { story: { narrative: 'A recorded recap.', writtenAt: at } }
  raw.refresh = { state: 'ok', finishedAt: at }
  const wire = JSON.parse(JSON.stringify(toWorkModel(raw, now)))
  switchLocale('zh-CN')
  try {
    const localized = localizeWorkModel(wire)
    assert.deepEqual(JSON.parse(JSON.stringify(localized)), JSON.parse(JSON.stringify(toWorkModel(raw, now))))
    assert.match(localized.requests[0].checkedAt!, /^10月20日/)
    assert.match(localized.requests[1].estimate!, /^按此进度，预计 /)
    assert.match(localized.rules[0].quotes[0].at, /^10月20日/)
    assert.equal(localized.pastPeriods[0].label, '8月18日 – 9月17日')
  } finally { switchLocale('en') }
  assert.deepEqual(localizeWorkModel(wire), wire)
})

import type { Request, SkillRun } from '../data.ts'
import { t } from '../i18n/translate.ts'
import { formatCompletionEstimate } from './measured-estimate.ts'
import { formatDateTime, formatDuration, formatRecordTime, periodLabel, recordedDayLabel } from './to-work-model.ts'
import type { MappedWorkModel } from './work-data-source.ts'

/** Older workers omit the raw facts; keep their supplied display text until they are upgraded. */
export function localizeRequest(request: Request, now?: number): Request {
  if (now === undefined) return request
  const time = request.displayTime ?? {}
  const started = request.startedAtIso ? Date.parse(request.startedAtIso) : undefined
  return {
    ...request,
    ...(started !== undefined ? { startedAt: formatDateTime(started), runningFor: formatDuration((time.endedAt ?? now) - started) } : {}),
    progress: { ...request.progress,
      ...(time.reviewedAt !== undefined ? { reviewedAt: formatRecordTime(time.reviewedAt, now) } : {}),
      ...(time.completedAt !== undefined ? { completedAt: formatDateTime(time.completedAt) } : {}),
    },
    ...(time.checkedAt !== undefined ? { checkedAt: formatDateTime(time.checkedAt) } : {}),
    ...(time.estimateAt !== undefined ? { estimate: formatCompletionEstimate(time.estimateAt) } : {}),
    granular: request.granular.map(record => record.atEpoch === undefined ? record : { ...record, at: formatRecordTime(record.atEpoch, now) }),
    conversations: request.conversations.map(record => record.atEpoch === undefined ? record : { ...record, at: formatDateTime(record.atEpoch) }),
    story: request.story.map(step => step.atEpoch === undefined ? step : { ...step, description: formatRecordTime(step.atEpoch, now) }),
  }
}

const localizeRun = (run: SkillRun | null): SkillRun | null => run?.lastRunAtEpoch === undefined ? run : { ...run, lastRunAt: formatDateTime(run.lastRunAtEpoch) }

/** Compact overview/detail already contain the model; only display facts need remapping in the browser. */
export function localizeWorkModel(model: MappedWorkModel, now = model.displayAt): MappedWorkModel {
  if (now === undefined) return model
  const period = model.currentPeriod?.displayPeriod
  return {
    ...model,
    requests: model.requests.map(request => localizeRequest(request, now)),
    agents: model.agents.map(agent => agent.finishedAtEpoch === undefined ? agent : { ...agent, finishedAt: formatDateTime(agent.finishedAtEpoch) }),
    currentPeriod: model.currentPeriod && period ? { ...model.currentPeriod, label: period.start
      ? periodLabel(period.start, period.end, new Date(period.generatedAt).getFullYear())
      : t('{days} days to {day}', { days: model.currentPeriod.windowDays, day: recordedDayLabel(period.generatedAt) }) } : model.currentPeriod,
    pastPeriods: model.pastPeriods.map(item => item.displayPeriod ? { ...item, label: periodLabel(item.displayPeriod.start, item.displayPeriod.end, item.displayPeriod.year) } : item),
    rules: model.rules.map(rule => ({
      ...rule,
      ...(rule.latestAtEpoch !== undefined ? { latestAt: formatRecordTime(rule.latestAtEpoch, now) } : {}),
      quotes: rule.quotes.map(quote => quote.atEpoch === undefined ? quote : { ...quote, at: formatDateTime(quote.atEpoch) }),
      records: rule.records.map(record => record.atEpoch === undefined ? record : { ...record, at: formatDateTime(record.atEpoch) }),
      ...(rule.replacedBy?.atEpoch !== undefined ? { replacedBy: { ...rule.replacedBy, at: formatRecordTime(rule.replacedBy.atEpoch, now) } } : {}),
    })),
    lastRuns: { goals: localizeRun(model.lastRuns.goals), progress: localizeRun(model.lastRuns.progress) },
    ...(model.refresh?.finishedAtEpoch !== undefined ? { refresh: { ...model.refresh, finishedAt: formatDateTime(model.refresh.finishedAtEpoch) } } : {}),
    ...(model.buildStory?.writtenAtEpoch !== undefined ? { buildStory: { ...model.buildStory, writtenAt: formatRecordTime(model.buildStory.writtenAtEpoch, now) } } : {}),
  }
}

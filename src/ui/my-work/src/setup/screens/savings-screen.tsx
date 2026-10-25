import { ArrowRightIcon } from 'lucide-react'
import { intlLocale, t } from '@/i18n'
import { PLAN, type SetupUsage } from '../setup-data'
import type { MemoryBranch } from '../setup-flow'
import { money } from '../format'

const monthly = (cents: number) => t('{price}/mo', { price: money(cents) })
// setup-usage builds "Last 30 days · Claude Code" in English; only the window needs translating.
const periodLabel = (label: string) => label.replace(/^Last (\d+) days/, (_, days: string) => t('Last {days} days', { days }))
const tokensLabel = (tokens: number) => t('{count} tokens', { count: new Intl.NumberFormat(intlLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(tokens) })

/**
 * Step 4, Token Savings, result only (PROTO #route-savings-result). The persona and 30-day tokens come from the scan, and
 * only for a complete window; otherwise the line says the history is incomplete or missing (DATA-CONTRACT.md).
 * "% more efficient" shows only with real claude-mem observation history. The price card is plan prices (D6).
 * "Use my existing token plan" stays off On The Go: there is no standalone Cloud Sync price yet (gap G1).
 */
export function SavingsScreen({ usage, branch, onPro, onExistingPlan, onSkip }: {
  usage: SetupUsage | null
  branch: MemoryBranch
  onPro: () => void
  onExistingPlan: () => void
  onSkip: () => void
}) {
  const percent = usage?.efficiencyPercent ?? null
  const title = percent !== null && percent > 0 ? t('Based on your usage, CMEM Pro will make your token consumption {percent}% more efficient.', { percent }) : t('Your AI usage.')
  return (
    <section aria-labelledby="savings-title">
      <div className="page-heading">
        <h1 id="savings-title" tabIndex={-1}>{title}</h1>
        {usage?.persona && <p className="persona">{t('You are a {persona}.', { persona: t(usage.persona) })}</p>}
        {usage && <p className="usage-period">{usage.coverage === 'complete' ? `${periodLabel(usage.periodLabel)} · ${tokensLabel(usage.tokens)}` : t(usage.periodLabel)}</p>}
      </div>
      <div className="panel is-memory price-card">
        <h2>{t('Monthly price after your trial')}</h2>
        <dl className="price-table">
          <div><dt>{PLAN.name}</dt><dd>{monthly(PLAN.monthlyCents)}</dd></div>
          <div><dt>{t('Cloud Sync')}</dt><dd><s>{monthly(PLAN.cloudSyncCents)}</s> <strong className="free">{t('Free')}</strong></dd></div>
          <div className="total"><dt>{t('Total')}</dt><dd><s>{monthly(PLAN.monthlyCents + PLAN.cloudSyncCents)}</s> <strong>{monthly(PLAN.monthlyCents)}</strong></dd></div>
        </dl>
      </div>
      <p className="result-trial">{t('$0 today · 30 day free trial')}</p>
      <p className="result-terms">{t('Trial ends after 30 days or when included usage runs out, whichever comes first.')}</p>
      <div className="savings-actions">
        <button type="button" className="primary" onClick={onPro}>{t('Continue with CMEM Pro')} <ArrowRightIcon aria-hidden="true" /></button>
        {branch === 'home' && (
          <button type="button" className="existing-plan" onClick={onExistingPlan}>
            <span>{t('Use my existing token plan to generate memories of my work.')}</span>
            <small>{t('At Home · Free')}</small>
          </button>
        )}
        <button type="button" className="text-action" onClick={onSkip}>{t('Skip for now')}</button>
      </div>
    </section>
  )
}

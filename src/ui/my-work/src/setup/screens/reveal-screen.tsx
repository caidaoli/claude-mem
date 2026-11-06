import { ArrowRightIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useReducedMotion } from 'motion/react'
import { EncryptedText } from '@/components/aceternity/encrypted-text'
import { AgentMark } from '@/components/brand'
import { intlLocale, t } from '@/i18n'
import { formatPromptDay } from '@/lib/prompt-time'
import { agentToolFor, type RevealSets, type SetupExtraction, type SetupRecentPrompt, type SetupScanAgent } from '../setup-data'
import { promptStamp } from '../setup-reveal'
import { joinNames } from '../format'
import { PageHeading } from './shared'

const timesLabel = (times: number) => times === 1 ? t('asked once') : t('asked {times}×', { times })

/** A landed card's title decrypts from scramble into the words read from the prompts. Reduced motion: plain text.
 *  Screen readers get only the final words (sr-only); the scrambling span is hidden from them. */
function LandedTitle({ text }: { text: string }) {
  if (useReducedMotion()) return text
  return <><span className="sr-only">{text}</span><span aria-hidden="true"><EncryptedText text={text} /></span></>
}

/** One of the three sets. `null` items: still being extracted, so it shows placeholders until they land. */
function RevealSet<T>({ title, items, render }: { title: string; items: T[] | null; render: (item: T) => ReactNode }) {
  if (items && items.length === 0) return null
  return (
    <section className={items ? 'reveal-set is-landed' : 'reveal-set'} aria-labelledby={`reveal-${title}`} aria-busy={!items}>
      <h2 id={`reveal-${title}`}>{t(title)}</h2>
      <ol>
        {items ? items.map(render) : [0, 1, 2].map((index) => <li key={index} className="reveal-card is-pending" aria-hidden="true" />)}
      </ol>
    </section>
  )
}

/** No logged-in agent yet: the prompts themselves, counted per agent and quoted as typed. The cards follow in My Work. */
function PromptsOnly({ agents, recentPrompts }: { agents: SetupScanAgent[]; recentPrompts: SetupRecentPrompt[] }) {
  return (
    <div className="reveal-sets">
      <section className="reveal-set is-landed" aria-labelledby="reveal-prompts">
        <h2 id="reveal-prompts">{t('Conversations')}</h2>
        <ol>
          {agents.map((agent) => (
            <li key={agent.id} className="reveal-card">
              <span className="lead-icon" aria-hidden="true"><AgentMark tool={agentToolFor(agent.id)} /></span>
              <div>
                <p className="title">{agent.label}</p>
                <p className="meta">{t('{count} messages', { count: agent.prompts.toLocaleString(intlLocale()) })}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      {recentPrompts.length > 0 && (
        <section className="reveal-set is-landed" aria-labelledby="reveal-latest">
          <h2 id="reveal-latest">{t('Latest')}</h2>
          <ol>
            {recentPrompts.map((prompt) => (
              <li key={`${prompt.agent}-${prompt.at}`} className="reveal-card">
                <span className="lead-icon" aria-hidden="true">“</span>
                <div>
                  <p className="quote">“{prompt.text}”</p>
                  <p className="meta">{formatPromptDay(promptStamp(prompt.at))}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

/** Step 2: Work, Goals and Rules read from the person's own prompts. Live: each set lands as its extraction finishes; Continue never waits. */
export function RevealScreen({ agents, reveal, extraction, uploadedAgents, recentPrompts, hostedNotice, onContinue }: {
  agents: SetupScanAgent[]; reveal: RevealSets; extraction: SetupExtraction | null; uploadedAgents: string[] | null; recentPrompts: SetupRecentPrompt[]; hostedNotice?: string | null; onContinue: () => void
}) {
  // The results came only from the tools the person chose to upload.
  const withPrompts = agents.filter((agent) => agent.prompts > 0 && (!uploadedAgents || uploadedAgents.includes(agent.id)))
  const promptCount = withPrompts.reduce((sum, agent) => sum + agent.prompts, 0)
  const promptsOnly = extraction?.state === 'waiting-for-agent' && !reveal.goals && !reveal.work && !reveal.rules
  // The person kept everything local and no earlier run left results: say that instead of promising knowledge that
  // was never built. This reads the recorded answer, because an upload can also come back with nothing to show.
  const hasResults = !!(reveal.goals?.length || reveal.work?.length || reveal.rules?.length)
  const keptLocal = uploadedAgents?.length === 0 && agents.some((agent) => agent.prompts > 0) && !hasResults
  if (keptLocal || (hostedNotice && !hasResults)) {
    return (
      <section aria-labelledby="reveal-title">
        <PageHeading id="reveal-title" title={t('Continue setup.')}
          lead={t(hostedNotice ?? 'You skipped this step. Continue setting up Claude-Mem.')} />
        <div className="actions is-centered">
          <button type="button" className="primary" onClick={onContinue}>{t('Continue')} <ArrowRightIcon aria-hidden="true" /></button>
        </div>
      </section>
    )
  }
  return (
    <section aria-labelledby="reveal-title">
      <PageHeading id="reveal-title" title={t(hostedNotice ? 'Continue setup.' : 'Claude-Mem already knows your work.')}
        lead={!hostedNotice && promptCount > 0 ? t('From {count} messages across {names}: what you’re working on, what you’re after, and how you like things done.', { count: promptCount.toLocaleString(intlLocale()), names: joinNames(withPrompts.map((agent) => agent.label)) }) : undefined} />
      {hostedNotice && <p className="scan-status" role="status">{t(hostedNotice)}</p>}
      {promptsOnly ? <PromptsOnly agents={withPrompts} recentPrompts={recentPrompts} /> : <div className="reveal-sets">
        <RevealSet title="Work" items={reveal.work} render={(work) => (
          <li key={work.id} className="reveal-card">
            <span className="lead-icon" aria-hidden="true"><AgentMark tool={work.agent} /></span>
            <div>
              <p className="title"><LandedTitle text={work.title} /></p>
              <p className="meta">{t('Last active {day}', { day: formatPromptDay(work.lastActiveAt) })}</p>
              {work.progressPercent !== undefined && <div className="bar" role="img" aria-label={t('{percent}% done', { percent: work.progressPercent })}><span style={{ width: `${work.progressPercent}%` }} /></div>}
            </div>
          </li>
        )} />
        <RevealSet title="Goals" items={reveal.goals} render={(goal) => (
          <li key={goal.id} className="reveal-card">
            <span className="lead-icon" aria-hidden="true">{goal.rank}</span>
            <div>
              <p className="title"><LandedTitle text={goal.title} /></p>
              <p className="meta">{t('{times}, last {day}', { times: timesLabel(goal.timesAsked), day: formatPromptDay(goal.latestAt) })}</p>
            </div>
          </li>
        )} />
        <RevealSet title="Rules" items={reveal.rules} render={(rule) => (
          <li key={rule.id} className="reveal-card">
            <span className="lead-icon" aria-hidden="true">“</span>
            <div>
              <p className="title"><LandedTitle text={rule.text} /></p>
              <p className="quote">“{rule.quote}” · {formatPromptDay(rule.quotedAt)}</p>
            </div>
          </li>
        )} />
      </div>}
      <div className="actions is-centered">
        <button type="button" className="primary" onClick={onContinue}>{t('Continue')} <ArrowRightIcon aria-hidden="true" /></button>
      </div>
    </section>
  )
}

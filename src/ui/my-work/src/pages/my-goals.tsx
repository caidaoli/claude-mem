import { useEffect, useState, type ReactNode } from 'react'
import { ArrowDownIcon, ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon } from 'lucide-react'
import { InlineCitationQuote } from '@/components/ai-elements/inline-citation'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AgentIcon, NextMove, ProgressMeter, RefreshButton, RefreshStatus, StateBadge, useWorkspace } from '@/components/bits'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { t } from '@/i18n'
import { PRODUCT_ICON } from '@/lib/product-icons'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { isSampleHref, SAMPLE_RUNS, useWorkModel, type GoalItem, type LiveState, type Quote, type Request } from '@/data'
import { formatPromptDay, formatPromptTime, promptDayKey, shipDayKey } from '@/lib/prompt-time'

const TOP_COUNT = 5
const goalAnchor = (goalId: string) => `goal-${goalId}`
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Every request a goal can link to: the active model's requests (plus, in sample mode only, older fixture requests). */
function useGoalRequests(): Request[] {
  const { requests, goalOnlyRequests } = useWorkModel()
  return [...requests, ...goalOnlyRequests.filter((older) => !requests.some((request) => request.id === older.id))]
}

/** Where a goal stands, from the requests serving it. The dot uses the same state tokens as My Work; the text stays plain. */
type GoalStatus = 'nothing' | 'your-move' | 'moving' | 'asked-again' | 'shipped' | 'stalled'
const GOAL_STATUS: Record<GoalStatus, { label: string; dot: string; text: string; meter: string }> = {
  nothing: { label: 'Nothing on it', dot: 'bg-attention-foreground', text: 'text-attention-foreground', meter: '' },
  'your-move': { label: 'Waiting on you', dot: 'bg-attention-foreground', text: 'text-attention-foreground', meter: '[&_[data-slot=progress-indicator]]:bg-attention-foreground/75' },
  moving: { label: 'Moving', dot: 'bg-working-foreground', text: 'text-working-foreground', meter: '[&_[data-slot=progress-indicator]]:bg-working-foreground/75' },
  'asked-again': { label: 'Asked again after ship', dot: 'bg-review-foreground', text: 'text-review-foreground', meter: '[&_[data-slot=progress-indicator]]:bg-review-foreground/75' },
  shipped: { label: 'Shipped', dot: 'bg-shipped-foreground', text: 'text-shipped-foreground', meter: '[&_[data-slot=progress-indicator]]:bg-shipped-foreground/75' },
  stalled: { label: 'Stalled', dot: 'bg-idle-foreground', text: 'text-muted-foreground', meter: '[&_[data-slot=progress-indicator]]:bg-idle-foreground/75' },
}

/** Requests come from the active model, so a request's state here always matches My Work. An id the model lacks links to nothing. */
const servingRequests = (goal: GoalItem, goalRequests: Request[]): Request[] => goal.servedBy
  ? goal.servedBy.map((id) => goalRequests.find((request) => request.id === id)).filter((request): request is Request => Boolean(request))
  : goalRequests.filter((request) => request.goalId === goal.id)
const lastShip = (requests: Request[]) => requests.map((request) => request.progress.completedAt).filter(Boolean).sort((a, b) => shipDayKey(b!) - shipDayKey(a!))[0]
/** You asked for it again after the latest ship: what shipped didn't cover it. */
const askedAgainAfter = (goal: GoalItem, requests: Request[]) => {
  const shipped = lastShip(requests)
  return shipped && promptDayKey(goal.latestAt) > shipDayKey(shipped) ? shipped : null
}

function statusOf(goal: GoalItem, requests: Request[]): GoalStatus {
  if (requests.length === 0) return 'nothing'
  const has = (state: LiveState) => requests.some((request) => request.state === state)
  if (has('your-move')) return 'your-move'
  if (has('working') || has('needs-check')) return 'moving'
  if (requests.every((request) => request.state === 'shipped')) return askedAgainAfter(goal, requests) ? 'asked-again' : 'shipped'
  return 'stalled'
}

const requestTitle = (request: Request) => request.title ?? t('New request, title being written')
const timesLabel = (times: number) => t(times === 1 ? 'asked once' : 'asked {count}×', { count: times })
const isReviewed = (request: Request) => request.progress.readings > 0

function GoalStatusText({ status }: { status: GoalStatus }) {
  return (
    <Req ids={['R6.2']}>
      <span className={cn('inline-flex items-center gap-1.5 font-medium', GOAL_STATUS[status].text)}>
        <span className={cn('size-1.5 rounded-full', GOAL_STATUS[status].dot)} />{t(GOAL_STATUS[status].label)}
      </span>
    </Req>
  )
}

/**
 * Combined progress of the requests serving a goal, from memory reviews only (decision 1, §12).
 * The percentage always says how much of the goal it covers, and names what it leaves out.
 */
function Rollup({ status, requests, className }: { status: GoalStatus; requests: Request[]; className?: string }) {
  const reviewed = requests.filter(isReviewed)
  const unreviewed = requests.filter((request) => !isReviewed(request))
  if (requests.length === 0) {
    return <Req ids={['R12.1', 'R5.11']}><p className={cn('text-xs text-muted-foreground', className)}>{t('No requests, so no progress to measure')}</p></Req>
  }
  const percent = reviewed.length ? Math.round(reviewed.reduce((sum, request) => sum + (request.progress.percent ?? 0), 0) / reviewed.length) : 0
  return (
    <Req ids={['D1', 'R5.11', 'R3.9', 'R12.1']}>
      <div className={cn('space-y-1', className)}>
        <Progress value={percent} className={cn('h-1.5 bg-muted', GOAL_STATUS[status].meter)} aria-label={t('{percent}% from {reviewed} of {count} requests reviewed', { percent, reviewed: reviewed.length, count: requests.length })} />
        <p className="text-xs text-muted-foreground">
          {reviewed.length
            ? <><span className="font-medium text-foreground tabular-nums">{percent}%</span> · {t(requests.length === 1 ? '{reviewed} of {count} request reviewed' : '{reviewed} of {count} requests reviewed', { reviewed: reviewed.length, count: requests.length })}</>
            : t(requests.length === 1 ? 'Not reviewed yet · 0 of {count} request' : 'Not reviewed yet · 0 of {count} requests', { count: requests.length })}
        </p>
        {unreviewed.length > 0 && reviewed.length > 0 && (
          <p className="truncate text-xs text-muted-foreground">{t('Not counted: {titles}', { titles: unreviewed.map(requestTitle).join(t(', ')) })}</p>
        )}
      </div>
    </Req>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h4 className="text-xs font-medium text-muted-foreground">{children}</h4>
}

/** One overall request under a goal; opens the request page from My Work (goal → request → detail). */
function RequestRow({ request, onOpen }: { request: Request; onOpen: (request: Request) => void }) {
  return (
    <Req ids={['R3.1', 'R2.1']}>
      {/* Sized by its own width: inside a priority card the row is far narrower than the viewport. */}
      <div className="@container">
        <button type="button" onClick={() => onOpen(request)} className="grid min-h-12 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-lg border bg-card px-3 py-2.5 text-left hover:bg-surface-cool @xl:grid-cols-[auto_minmax(0,1fr)_auto_10rem_auto]">
          <AgentIcon agentId={request.agentId} />
          <span className={cn('line-clamp-2 text-sm @xl:truncate', request.title ? 'font-medium' : 'text-muted-foreground italic')}>{requestTitle(request)}</span>
          <ChevronRightIcon className="size-4 text-muted-foreground @xl:order-last" />
          <span className="col-start-2 flex @xl:col-start-auto"><StateBadge state={request.state} /></span>
          <span className="col-span-2 col-start-2 @xl:col-span-1 @xl:col-start-auto"><ProgressMeter request={request} compact /></span>
        </button>
      </div>
    </Req>
  )
}

/** The owner's words behind a goal, dated to the minute they typed them. */
function Quotes({ quotes }: { quotes: Quote[] }) {
  return (
    <Req ids={['R3.8', 'R5.11']}>
      <div className="space-y-2">
        {quotes.map((quote) => (
          <InlineCitationQuote key={quote.at + quote.quote} className="border-border text-foreground/80 not-italic">
            “{quote.quote}” <time className="ml-1 text-xs whitespace-nowrap text-muted-foreground">{formatPromptTime(quote.at)}</time>
          </InlineCitationQuote>
        ))}
      </div>
    </Req>
  )
}

/** Every quote is kept, behind one disclosure, so the requests and outputs come first (§3). */
function WhyItsHere({ quotes }: { quotes: Quote[] }) {
  return (
    <Req ids={['R3.8']}>
      <Collapsible>
        <CollapsibleTrigger className="group flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />{t(quotes.length === 1 ? 'Why it’s here · {count} quote' : 'Why it’s here · {count} quotes', { count: quotes.length })}
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-1 pb-1"><Quotes quotes={quotes} /></CollapsibleContent>
      </Collapsible>
    </Req>
  )
}

/** Outputs: real artifacts open in a new tab; anything without a real target is marked sample and is not a link. */
function WorkProduct({ requests }: { requests: Request[] }) {
  const products = requests.flatMap((request) => request.workProduct.map((product) => ({ ...product, from: requestTitle(request) })))
  if (products.length === 0) return null
  return (
    <Req ids={['R5.10', 'R12.1']}>
      <div className="space-y-2">
        <SectionLabel>{t('What came out of it')}</SectionLabel>
        <ul className="flex flex-wrap gap-2">
          {products.map((product, index) => {
            const Icon = PRODUCT_ICON[product.kind]
            const chip = 'inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-md border px-3 text-sm'
            return (
              <li key={`${index}-${product.label}`} className="max-w-full">
                {product.href === undefined ? (
                  <span className={cn(chip, 'bg-card')} title={t('From {request}', { request: product.from })}>
                    <Icon className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{product.label}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{t(product.kind)}</span>
                  </span>
                ) : isSampleHref(product.href) ? (
                  <span className={cn(chip, 'border-dashed text-muted-foreground')} title={t('From {request}. Sample: no real artifact yet.', { request: product.from })}>
                    <Icon className="size-4 shrink-0" /><span className="truncate">{product.label}</span>
                    <span className="shrink-0 text-xs">{t('{kind} · sample', { kind: t(product.kind) })}</span>
                  </span>
                ) : (
                  <a href={product.href} target="_blank" rel="noreferrer" className={cn(chip, 'bg-card hover:bg-surface-cool')} title={t('From {request}', { request: product.from })}>
                    <Icon className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{product.label}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{t(product.kind)}</span>
                    <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  </a>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </Req>
  )
}

/** A priority: one summary row, then on open the requests serving it, what came out, and the quotes behind a disclosure (§3). */
function PriorityItem({ goal, highlighted, onOpen }: { goal: GoalItem; highlighted: boolean; onOpen: (request: Request) => void }) {
  const requests = servingRequests(goal, useGoalRequests())
  const status = statusOf(goal, requests)
  const shippedBefore = askedAgainAfter(goal, requests)
  return (
    <Req ids={['D1', 'R3.8']}>
      <AccordionItem value={goal.id} id={goalAnchor(goal.id)} className={cn('@container scroll-mt-24 px-3 sm:px-4 motion-safe:transition-colors motion-safe:duration-700', highlighted && 'bg-accent')}>
        <AccordionTrigger className="min-h-16 items-center gap-3 py-3 hover:no-underline">
          <span className={cn('flex size-7 shrink-0 items-center justify-center self-start rounded-md bg-muted text-xs tabular-nums', goal.rank === 1 ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{goal.rank}</span>
          <span className="min-w-0 flex-1 space-y-1">
            <Req ids={['R10.5']}>
              <span className="block text-[15px] leading-snug font-semibold text-foreground">{goal.title}</span>
            </Req>
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs font-normal text-muted-foreground">
              <GoalStatusText status={status} />
              <span>· {t('{times}, last {day}', { times: timesLabel(goal.timesAsked), day: formatPromptDay(goal.latestAt) })}<span className="hidden sm:inline"> · {t(goal.product)}</span></span>
            </span>
            <Rollup status={status} requests={requests} className="pt-1 font-normal @2xl:hidden" />
          </span>
          <Rollup status={status} requests={requests} className="hidden w-56 shrink-0 font-normal @2xl:block" />
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pb-3 sm:pl-10 [&_a]:no-underline [&_p:not(:last-child)]:mb-0">
          {requests.length > 0 ? (
            <div className="space-y-2">
              <SectionLabel>{t('Requests serving it · {count}', { count: requests.length })}</SectionLabel>
              {requests.map((request) => <RequestRow key={request.id} request={request} onOpen={onOpen} />)}
            </div>
          ) : (
            <Req ids={['R12.1', 'R6.3']}>
              <NextMove next={{ who: 'human', text: t('Start a request for this. Nothing is working on it.') }} />
            </Req>
          )}
          {shippedBefore && (
            <Req ids={['R12.2']}>
              <p className="text-xs text-review-foreground">{t('You asked again on {day}, after the last ship on {shipped}. What shipped doesn’t cover it yet.', { day: formatPromptDay(goal.latestAt), shipped: shippedBefore })}</p>
            </Req>
          )}
          <WorkProduct requests={requests} />
          <WhyItsHere quotes={goal.quotes} />
        </AccordionContent>
      </AccordionItem>
    </Req>
  )
}

/** An open ask: one line, its count, the requests answering it (if any), quotes on demand. */
function AskRow({ ask, highlighted, onOpen }: { ask: GoalItem; highlighted: boolean; onOpen: (request: Request) => void }) {
  const requests = servingRequests(ask, useGoalRequests())
  const shippedBefore = askedAgainAfter(ask, requests)
  return (
    <Req ids={['R3.8']}>
      <div id={goalAnchor(ask.id)} className={cn('scroll-mt-24 space-y-1.5 px-3 pt-3 pb-1 motion-safe:transition-colors motion-safe:duration-700', highlighted && 'bg-accent')}>
        <p className="text-sm leading-snug font-medium">{ask.title}</p>
        <p className="text-xs text-muted-foreground">{t('{times}, last {day}', { times: timesLabel(ask.timesAsked).replace(/^a/, 'A'), day: formatPromptDay(ask.latestAt) })} · {t(ask.product)}</p>
        {requests.map((request) => (
          <button key={request.id} type="button" onClick={() => onOpen(request)} className="flex min-h-11 w-full items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-left text-xs hover:bg-surface-cool">
            <AgentIcon agentId={request.agentId} />
            <span className={cn('min-w-0 flex-1 truncate', !request.title && 'text-muted-foreground italic')}>{requestTitle(request)}</span>
            <StateBadge state={request.state} />
          </button>
        ))}
        {shippedBefore && <p className="text-xs text-review-foreground">{t('Asked again after it shipped {shipped}.', { shipped: shippedBefore })}</p>}
        {requests[0]?.next.text && <p className="text-xs text-muted-foreground">{t('Next ({who}): {text}', { who: t(requests[0].next.who === 'human' ? 'you' : 'agent'), text: t(requests[0].next.text) })}</p>}
        <WhyItsHere quotes={ask.quotes} />
      </div>
    </Req>
  )
}

function OpenAsks({ highlighted, onOpen }: { highlighted: string | null; onOpen: (request: Request) => void }) {
  const { openAsks } = useWorkModel()
  const unserved = openAsks.filter((ask) => !ask.servedBy?.length)
  const served = openAsks.filter((ask) => ask.servedBy?.length)
  const repeated = openAsks.filter((ask) => ask.timesAsked > 1).length
  return (
    <Req ids={['R3.8', 'R6.3', 'R5.8']}>
      <section id="open-asks" className="scroll-mt-24 space-y-4 rounded-xl border bg-card p-4">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold">{t('Open asks')}</h2>
          <Req ids={['R12.2']}>
            <p className="text-xs text-muted-foreground">{t('{repeated} of {count} came up more than once. Repetition shows what keeps coming back, not what’s finished.', { repeated, count: openAsks.length })}</p>
          </Req>
        </div>

        <div className="space-y-1">
          <h3 className="text-xs font-medium text-attention-foreground">{t('Nothing is working on these · {count}', { count: unserved.length })}</h3>
          <p className="text-xs text-muted-foreground">{t('Your move: start a request for each, or drop it.')}</p>
          <div className="-mx-3 divide-y">
            {unserved.map((ask) => <AskRow key={ask.id} ask={ask} highlighted={highlighted === ask.id} onOpen={onOpen} />)}
          </div>
        </div>

        <div className="space-y-1">
          <h3 className="text-xs font-medium text-muted-foreground">{t('Being worked on · {count}', { count: served.length })}</h3>
          <div className="-mx-3 divide-y">
            {served.map((ask) => <AskRow key={ask.id} ask={ask} highlighted={highlighted === ask.id} onOpen={onOpen} />)}
          </div>
        </div>
      </section>
    </Req>
  )
}

/** Work happening outside what you said you want (decision 1). */
function NoGoal({ onOpen }: { onOpen: (request: Request) => void }) {
  const unlinked = useGoalRequests().filter((request) => request.goalId === null)
  return (
    <Req ids={['D1']}>
      <section id="no-goal" className="scroll-mt-24 space-y-2">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold">{t('No goal · {count}', { count: unlinked.length })}</h2>
          <p className="text-xs text-muted-foreground">{t('Requests that serve none of your priorities: work happening outside what you said you want.')}</p>
        </div>
        {unlinked.map((request) => <RequestRow key={request.id} request={request} onOpen={onOpen} />)}
      </section>
    </Req>
  )
}

const STATE_ORDER: LiveState[] = ['your-move', 'working', 'needs-check', 'idle', 'shipped']
const STATE_SHORT: Record<LiveState, string> = { 'your-move': 'your move', working: 'working', 'needs-check': 'not checked', idle: 'idle', shipped: 'shipped' }
const STATE_DOT: Record<LiveState, string> = { 'your-move': 'bg-attention-foreground', working: 'bg-working-foreground', 'needs-check': 'bg-review-foreground', idle: 'bg-idle-foreground', shipped: 'bg-shipped-foreground' }

/** Every request this month by state, as one quiet line: color only on the dot that encodes the state. */
function RequestStateLine({ className }: { className?: string }) {
  const goalRequests = useGoalRequests()
  return (
    <Req ids={['R7.1', 'R6.2']} className={className}>
      <p className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground', className)}>
        <span>{t('{count} requests:', { count: goalRequests.length })}</span>
        {STATE_ORDER.map((state) => {
          const total = goalRequests.filter((request) => request.state === state).length
          return total ? (
            <span key={state} className="inline-flex items-center gap-1 whitespace-nowrap">
              <span className={cn('size-1.5 rounded-full', STATE_DOT[state])} /><span className="font-medium text-foreground tabular-nums">{total}</span> {t(STATE_SHORT[state])}
            </span>
          ) : null
        })}
      </p>
    </Req>
  )
}

/** The bottom line first: is your work moving what you want (§12)? Computed from the sample, never typed in. */
function Lead() {
  const { priorities, openAsks } = useWorkModel()
  const goalRequests = useGoalRequests()
  const top = priorities.slice(0, TOP_COUNT).map((goal) => statusOf(goal, servingRequests(goal, goalRequests)))
  const count = (status: GoalStatus) => top.filter((entry) => entry === status).length
  const unserved = openAsks.filter((ask) => !ask.servedBy?.length)
  const mostAsked = [...unserved].sort((a, b) => b.timesAsked - a.timesAsked)[0]
  const noGoal = goalRequests.filter((request) => request.goalId === null).length
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })
  return (
    <Req ids={['R12.3', 'R12.2', 'R3.9']}>
      <div className="space-y-2">
        <p className="text-base leading-snug font-semibold text-balance sm:text-lg">
          {t('Your work is moving {moving} of your top {top} priorities. {rest}', {
            moving: count('moving'),
            top: top.length,
            rest: t(count('your-move') === 1 ? '{count} is waiting on you' : '{count} are waiting on you', { count: count('your-move') })
              + t(count('nothing') === 1 ? ', and {count} has nothing working on it.' : ', and {count} have nothing working on it.', { count: count('nothing') }),
          })}
        </p>
        <p className="hidden text-sm text-muted-foreground lg:block">
          {mostAsked
            ? t('{count} open asks have no request yet. The one you’ve asked for most is “{title}”, {times} times.', { count: unserved.length, title: mostAsked.title, times: mostAsked.timesAsked })
            : t('{count} open asks have no request yet.', { count: unserved.length })}
        </p>
        <RequestStateLine className="hidden sm:flex" />
        <Req ids={['R11.1', 'R6.3', 'D1']} className="lg:hidden">
          <div className="flex flex-wrap gap-x-5 lg:hidden">
            <button type="button" onClick={() => jump('open-asks')} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-attention-foreground">{t('{count} asks with nothing on them', { count: unserved.length })}<ArrowDownIcon className="size-4" /></button>
            <button type="button" onClick={() => jump('no-goal')} className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground">{t('{count} with no goal', { count: noGoal })}<ArrowDownIcon className="size-4" /></button>
          </div>
        </Req>
      </div>
    </Req>
  )
}

/** Which machine mapped this and when; on the web, a Refresh is queued for a machine that has the transcripts (§13, §14). */
function RunSource() {
  const { mode } = useWorkspace()
  const { lastRuns, currentPeriod } = useWorkModel()
  const run = lastRuns.goals
  if (!run || !currentPeriod) throw new Error('RunSource needs a goals run')
  const device = { name: t(run.deviceName) }
  return (
    <Req ids={['R13.1', 'R13.8', 'R14.11', 'R14.10']}>
      <p className="text-xs text-muted-foreground">
        <span className="sm:hidden">{t('Mapped {at} on {device}', { at: run.lastRunAt.toLowerCase(), device: device.name })} · </span>
        {t('{count} prompts you typed in the last {days} days.', { count: currentPeriod.promptCount, days: currentPeriod.windowDays })}{' '}
        <span className="hidden sm:inline">
          {mode === 'home'
            ? t('Mapped on this machine from your local transcripts.')
            : t('Mapped on {device} and synced. The web can’t read transcripts, so Refresh queues the next run there.', { device: device.name })}
        </span>
        {mode === 'web' && <span className="sm:hidden">{t('Refresh queues on {device}.', { device: device.name })}</span>}
      </p>
    </Req>
  )
}

interface FocusState { openGoals: string[]; setOpenGoals: (open: string[]) => void; moreOpen: boolean; setMoreOpen: (open: boolean) => void; highlighted: string | null }

function NowView({ onOpen, focus }: { onOpen: (request: Request) => void; focus: FocusState }) {
  const { priorities } = useWorkModel()
  return (
    <div className="space-y-6">
      <Lead />

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="contents lg:block lg:space-y-8">
          <Req ids={['R3.1', 'R3.9']}>
            <section className="order-1 space-y-2 lg:order-none">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="shrink-0 text-base font-semibold">{t('Top priorities')}</h2>
                <span className="hidden text-right text-xs text-muted-foreground sm:inline">{t('ranked by how recent, how often and how strongly you asked')}</span>
              </div>
              <div className="overflow-hidden rounded-xl border bg-card">
                <Accordion type="multiple" value={focus.openGoals} onValueChange={focus.setOpenGoals}>
                  {priorities.slice(0, TOP_COUNT).map((goal) => <PriorityItem key={goal.id} goal={goal} highlighted={focus.highlighted === goal.id} onOpen={onOpen} />)}
                </Accordion>
              </div>
              {priorities.length > TOP_COUNT && <Collapsible open={focus.moreOpen} onOpenChange={focus.setMoreOpen}>
                <CollapsibleTrigger className="group flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                  <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />{t('{count} more priorities', { count: priorities.length - TOP_COUNT })}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="overflow-hidden rounded-xl border bg-card">
                    <Accordion type="multiple" value={focus.openGoals} onValueChange={focus.setOpenGoals}>
                      {priorities.slice(TOP_COUNT).map((goal) => <PriorityItem key={goal.id} goal={goal} highlighted={focus.highlighted === goal.id} onOpen={onOpen} />)}
                    </Accordion>
                  </div>
                </CollapsibleContent>
              </Collapsible>}
              <RequestStateLine className="pt-1 sm:hidden" />
            </section>
          </Req>
          <div className="order-3 lg:order-none"><NoGoal onOpen={onOpen} /></div>
        </div>
        <div className="order-2 lg:order-none"><OpenAsks highlighted={focus.highlighted} onOpen={onOpen} /></div>
      </div>
    </div>
  )
}

/** Month by month: a history of what you asked for, one row per saved run (§4). Archived is not the same as done. */
function MonthByMonth({ onOpenCurrent }: { onOpenCurrent: () => void }) {
  const { priorities, currentPeriod, pastPeriods } = useWorkModel()
  if (!currentPeriod) throw new Error('MonthByMonth needs a goals run')
  return (
    <Req ids={['R4.5', 'R12.1']}>
      <div className="space-y-3">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold">{t('History')}</h2>
          <p className="text-sm text-muted-foreground">{t('What you asked for most, month by month, as each owner-goals run saved it. A month closing archives its asks; it doesn’t mean they were done.')}</p>
        </div>
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="hidden grid-cols-[12rem_minmax(0,1fr)_7rem_1rem] gap-3 border-b px-4 py-2 text-xs text-muted-foreground sm:grid">
            <span>{t('Month')}</span><span>{t('Top priority that month')}</span><span className="text-right">{t('Your prompts')}</span><span />
          </div>
          <button type="button" onClick={onOpenCurrent} className="grid min-h-16 w-full grid-cols-[minmax(0,1fr)_1rem] items-center gap-3 border-b px-4 py-3 text-left hover:bg-surface-cool sm:grid-cols-[12rem_minmax(0,1fr)_7rem_1rem]">
            <span className="contents max-sm:flex max-sm:min-w-0 max-sm:flex-col max-sm:gap-0.5">
              <span className="text-sm font-semibold whitespace-nowrap">{currentPeriod.label} <span className="ml-1 text-xs font-medium text-muted-foreground">{t('Current')}</span></span>
              <span className="line-clamp-2 text-sm sm:truncate">{priorities[0]?.title ?? t('No priorities recorded')}</span>
              <span className="text-xs text-muted-foreground sm:text-right sm:text-sm">{currentPeriod.promptCount}<span className="sm:hidden"> {t('prompts · open this month')}</span></span>
            </span>
            <ChevronRightIcon className="size-4 text-muted-foreground" />
          </button>
          <Accordion type="single" collapsible>
            {pastPeriods.map((period) => (
              <AccordionItem key={period.id} value={period.id} className="px-4">
                <AccordionTrigger className="min-h-16 items-center gap-3 py-3 hover:no-underline">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:grid sm:grid-cols-[12rem_minmax(0,1fr)_7rem] sm:items-center sm:gap-3">
                    <span className="text-sm font-semibold whitespace-nowrap">{period.label} <span className="ml-1 text-xs font-normal text-muted-foreground">{t('Archived')}</span></span>
                    <span className="line-clamp-2 text-sm font-normal sm:truncate">{period.priorities[0]?.title ?? t('No priorities saved')}</span>
                    <span className="text-xs font-normal text-muted-foreground sm:text-right sm:text-sm">{period.promptCount}<span className="sm:hidden"> {t('prompts · {count} priorities', { count: period.priorities.length })}</span></span>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="space-y-4 pb-4 sm:pl-[12.75rem] [&_p:not(:last-child)]:mb-0">
                  <p className="text-sm">{t(period.headline)}</p>
                  <ol className="space-y-3">
                    {period.priorities.map((priority, index) => (
                      <li key={priority.title} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                        <span className="flex size-6 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                        <p className="text-sm font-medium">{priority.title}</p>
                        <p className="col-start-2 text-xs text-muted-foreground">{t(priority.product)} · {timesLabel(priority.timesAsked)}</p>
                        {priority.quote && <div className="col-start-2"><Quotes quotes={[priority.quote]} /></div>}
                      </li>
                    ))}
                  </ol>
                  <p className="text-xs text-muted-foreground">{t('No request reviews cover this month, so it shows what you asked for, not what moved.')}</p>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>
    </Req>
  )
}

/** Deep link fallback: `?goal=<id>` opens that goal when the shell doesn't pass focusGoalId. */
const goalFromUrl = () => new URLSearchParams(window.location.search).get('goal') ?? undefined

/**
 * My Goals. `focusGoalId` (from a goal chip, or `?goal=<id>`) scrolls to that goal, opens it and briefly highlights it.
 * Smooth scrolling and the fade are skipped under prefers-reduced-motion.
 */
export function MyGoals({ onOpen, focusGoalId }: { onOpen: (request: Request) => void; focusGoalId?: string }) {
  const { currentPeriod, goalsReadError } = useWorkModel()
  if (!currentPeriod) return <NoGoalsYet readError={goalsReadError} />
  return <GoalsForPeriod onOpen={onOpen} focusGoalId={focusGoalId} />
}

/** No owner-goals run on this computer yet, or one that couldn't be read: say so, and show the automatic refresh that makes one. */
function NoGoalsYet({ readError }: { readError: string | null }) {
  const { refresh } = useWorkModel()
  return (
    <Req ids={['R12.1', 'R3.8']}>
      <Empty className="border bg-card/60">
        <EmptyHeader>
          <EmptyTitle>{t(readError ? 'Can’t read your goals right now' : 'No goals yet')}</EmptyTitle>
          <EmptyDescription>
            {readError ? t('{error}. claude-mem rewrites them on its next automatic refresh.', { error: readError }) : t('No goals yet. claude-mem reads your recent prompts and fills this in automatically.')}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <RefreshStatus refresh={refresh} run={null} ids={['R3.8']} />
        </EmptyContent>
      </Empty>
    </Req>
  )
}

function GoalsForPeriod({ onOpen, focusGoalId }: { onOpen: (request: Request) => void; focusGoalId?: string }) {
  const { sourceKind, priorities, openAsks, currentPeriod, lastRuns, refresh } = useWorkModel()
  const knownGoalIds = new Set([...priorities, ...openAsks].map((goal) => goal.id))
  const isHiddenPriority = (goalId: string) => priorities.findIndex((goal) => goal.id === goalId) >= TOP_COUNT
  const [urlGoal] = useState(goalFromUrl)
  const focusId = focusGoalId ?? urlGoal
  const target = focusId && knownGoalIds.has(focusId) ? focusId : undefined
  const targetIsHiddenPriority = Boolean(target && isHiddenPriority(target))
  const [tab, setTab] = useState<'now' | 'months'>('now')
  const [openGoals, setOpenGoals] = useState<string[]>(() => [...(priorities[0] ? [priorities[0].id] : []), ...(target && target !== priorities[0]?.id ? [target] : [])])
  const [moreOpen, setMoreOpen] = useState(targetIsHiddenPriority)
  const [highlighted, setHighlighted] = useState<string | null>(null)

  useEffect(() => {
    if (!target) return
    setTab('now')
    setOpenGoals((open) => open.includes(target) ? open : [...open, target])
    if (targetIsHiddenPriority) setMoreOpen(true)
    setHighlighted(target)
    // Wait one tick so the tab, the "more" disclosure and the accordion have rendered before scrolling.
    const scroll = setTimeout(() => document.getElementById(goalAnchor(target))?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }), 60)
    const fade = setTimeout(() => setHighlighted(null), 2200)
    return () => { clearTimeout(scroll); clearTimeout(fade) }
  }, [target, targetIsHiddenPriority])

  return (
    <Req ids={['R3.7', 'R4.5', 'R10.2']}>
      <Tabs value={tab} onValueChange={(next) => setTab(next as 'now' | 'months')} className="gap-6">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <TabsList variant="line" className="p-0 group-data-horizontal/tabs:h-11">
              <TabsTrigger value="now" className="h-11 px-3">{t('This month')}<span className="hidden sm:inline">· {currentPeriod!.label}</span></TabsTrigger>
              <TabsTrigger value="months" className="h-11 px-3">{t('Month by month')}</TabsTrigger>
            </TabsList>
            {sourceKind === 'sample' ? <RefreshButton run={SAMPLE_RUNS.goals} ids={['R3.8']} /> : <RefreshStatus refresh={refresh} run={lastRuns.goals} ids={['R3.8']} />}
          </div>
          <RunSource />
        </div>
        <TabsContent value="now"><NowView onOpen={onOpen} focus={{ openGoals, setOpenGoals, moreOpen, setMoreOpen, highlighted }} /></TabsContent>
        <TabsContent value="months"><MonthByMonth onOpenCurrent={() => setTab('now')} /></TabsContent>
      </Tabs>
    </Req>
  )
}

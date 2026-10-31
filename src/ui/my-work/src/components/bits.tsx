import { useEffect, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { BotIcon, CornerLeftUpIcon, MessageSquareIcon, RefreshCwIcon, StarIcon, UserIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { t } from '@/i18n'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { isSampleHref, measuredEstimate, SAMPLE_DEVICES, type Device, type LiveState, type Request, type Run, type SkillRun } from '@/data'
import { agentById, deviceById, useConnection, useWorkModel, useWorkspace } from '@/store'
import type { ConnectionStatus } from '@/live/connection-status'
import type { AutoRefresh } from '@/live/work-data-source'
import { focusAreaLabel, resolveFocusAreaId } from '@/live/to-focus-model'
import { AgentMark } from './brand'

/**
 * The sliding highlight behind the active choice in a nav or toggle group (the `layoutId` pattern from aceternity/tabs).
 * Render it inside the active item only; the item needs `relative` and its content `relative` to sit above it.
 * Each group passes its own `layoutId` so pills never jump between groups.
 */
export function ActivePill({ layoutId, className }: { layoutId: string; className?: string }) {
  return <motion.span layoutId={layoutId} transition={{ type: 'spring', bounce: 0.3, duration: 0.6 }} className={cn('absolute inset-0 rounded-[inherit] bg-accent', className)} />
}


/** Agent mark, plus the machine it ran on (§13: remote agents are already synced, say where the work happened). */
export function AgentIcon({ agentId, withDevice = false }: { agentId: string; withDevice?: boolean }) {
  const agent = agentById(agentId)
  const device = deviceById(agent.deviceId)
  return (
    <Req ids={['R5.1', 'R10.4']}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-card" aria-label={t('{agent}, {role}, on {device}', { agent: t(agent.name), role: t(agent.role), device: t(device.name) })}>
              <AgentMark tool={agent.tool} className="size-4" />
            </span>
            {withDevice && <Req ids={['R13.4']}><span className="truncate text-xs text-muted-foreground">{t(agent.name)} · {t(agent.role)} · {t(device.name)}</span></Req>}
          </span>
        </TooltipTrigger>
        <TooltipContent>{t('{agent} · {role} · on {device}', { agent: t(agent.name), role: t(agent.role), device: t(device.name) })}</TooltipContent>
      </Tooltip>
    </Req>
  )
}

export const STATE_LABEL: Record<LiveState, string> = {
  working: 'Working', 'needs-check': 'Done, not checked', 'your-move': 'Your move', idle: 'Idle', shipped: 'Shipped',
}

/** Attention first: what waits on you, then what to check, then what is moving, then the rest. */
export const ATTENTION_ORDER: LiveState[] = ['your-move', 'needs-check', 'working', 'idle', 'shipped']

/** Each state's colors, shared by the badge and the List view's flipboard so both read as the same state. */
export const STATE_SURFACE: Record<LiveState, string> = {
  working: 'border-working-border bg-working text-working-foreground',
  'needs-check': 'border-review-border bg-review text-review-foreground',
  'your-move': 'border-attention-border bg-attention font-medium text-attention-foreground',
  idle: 'border-idle-border bg-idle text-idle-foreground',
  shipped: 'border-shipped-border bg-shipped text-shipped-foreground',
}

/** One glance tells working, done-but-unchecked, waiting on you and shipped apart (§6). State is the only thing colored. */
export function StateBadge({ state }: { state: LiveState }) {
  return (
    <Req ids={['R6.2']}>
      <Badge variant="outline" className={cn('shrink-0 gap-1.5 font-normal', STATE_SURFACE[state])}>
        <span className={cn('size-1.5 rounded-full', {
          'bg-working-foreground motion-safe:animate-pulse': state === 'working',
          'bg-review-foreground': state === 'needs-check',
          'bg-attention-foreground': state === 'your-move',
          'bg-idle-foreground': state === 'idle',
          'bg-shipped-foreground': state === 'shipped',
        })} />
        {t(STATE_LABEL[state])}
      </Badge>
    </Req>
  )
}

/**
 * The focus area a request sits in: the area's name, "Other", or "Sorting…" before the next refresh places it.
 * A quiet link, not a colored pill: color is reserved for state. Opens My Work on that area.
 */
export function FocusAreaChip({ focusAreaId, onOpen }: { focusAreaId?: string; onOpen?: (focusAreaId: string) => void }) {
  const { focusAreas } = useWorkModel()
  const placed = resolveFocusAreaId(focusAreaId, focusAreas)
  const label = focusAreaLabel(focusAreaId, focusAreas)
  return (
    <Req ids={['R16.5']}>
      {placed ? (
        <button type="button" onClick={(event) => { event.stopPropagation(); onOpen?.(placed) }} className="inline-flex min-h-11 max-w-full items-center gap-1.5 self-start text-left text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline md:min-h-6">
          <CornerLeftUpIcon className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      ) : (
        // Not placed yet is not the same claim as Other: the next refresh places it.
        <span className="inline-flex min-h-6 items-center gap-1.5 self-start text-xs text-muted-foreground/80 italic">{label}</span>
      )}
    </Req>
  )
}

/** Whose move is next: the agent's or yours (§5). A person's move is the one thing that gets weight. */
export function NextMove({ next, className }: { next: Request['next']; className?: string }) {
  if (!next.text) return null
  const human = next.who === 'human'
  return (
    <Req ids={['R5.8', 'R6.3']}>
      <div className={cn('flex items-start gap-2 text-[0.84rem] leading-snug', human ? 'font-medium text-attention-foreground' : 'text-foreground/80', className)}>
        <span className={cn('mt-px flex size-5 shrink-0 items-center justify-center rounded-full', human ? 'bg-attention' : 'bg-muted')}>
          {human ? <UserIcon className="size-3" /> : <BotIcon className="size-3" />}
        </span>
        <span><span className="sr-only">{human ? t('Your move: ') : t('Agent’s move: ')}</span>{t(next.text)}</span>
      </div>
    </Req>
  )
}

/** What the last memory review covered: "2 of 3 workstreams reviewed". */
export function reviewCoverage(request: Request) {
  const { coverage, readings, reviewedAt } = request.progress
  if (!readings) return t('Not reviewed yet')
  if (!coverage) return t('reviewed {at}', { at: t(reviewedAt) })
  return t(coverage.total === 1 ? '{reviewed} of {total} workstream reviewed {at}' : '{reviewed} of {total} workstreams reviewed {at}', { reviewed: coverage.reviewed, total: coverage.total, at: t(reviewedAt) })
}

/** Progress from the last memory review (§5), with the measured-pace estimate only when it exists (decision 3). */
export function ProgressMeter({ request, compact = false }: { request: Request; compact?: boolean }) {
  const { progress } = request
  const estimate = measuredEstimate(request)
  return (
    <Req ids={['R5.9', 'R5.6', 'R5.11']}>
      <div className="space-y-1.5">
        <Progress value={progress.percent ?? 0} aria-label={progress.percent === null ? t('Not reviewed yet') : t('{percent}% complete', { percent: progress.percent })} className={cn('h-1.5 bg-muted', {
          '[&_[data-slot=progress-indicator]]:bg-working-foreground/75': request.state === 'working',
          '[&_[data-slot=progress-indicator]]:bg-review-foreground/75': request.state === 'needs-check',
          '[&_[data-slot=progress-indicator]]:bg-attention-foreground/75': request.state === 'your-move',
          '[&_[data-slot=progress-indicator]]:bg-idle-foreground/75': request.state === 'idle',
          '[&_[data-slot=progress-indicator]]:bg-shipped-foreground/75': request.state === 'shipped',
        })} />
        <div className="flex flex-wrap justify-between gap-x-2 text-xs text-muted-foreground">
          <span>{progress.completedAt ? t('Completed {at}', { at: progress.completedAt }) : progress.readings ? <><span className="font-medium text-foreground/80 tabular-nums">{progress.percent}%</span>{compact ? '' : ` · ${reviewCoverage(request)}`}</> : t('Not reviewed yet')}</span>
          {!compact && estimate && <span>{estimate}</span>}
        </div>
      </div>
    </Req>
  )
}

/** A work-product link. Fixture links have nothing behind them, so they say so instead of looking real (§12). */
/** No href: a recorded item with nothing to open (a commit whose remote is not GitHub). */
export function ProductLink({ href, children, className }: { href?: string; children: ReactNode; className?: string }) {
  if (href === undefined) return <span className={className}>{children}</span>
  if (!isSampleHref(href)) return <a href={href} target="_blank" rel="noreferrer" className={className}>{children}</a>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn('cursor-help', className)}>
          {children}
          <span className="ml-2 shrink-0 rounded border border-dashed px-1.5 text-[10px] text-muted-foreground">{t('sample')}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{t('Sample link. The real page attaches when the agent records it.')}</TooltipContent>
    </Tooltip>
  )
}

/** getConnectionStatus's tooltip, rebuilt from its fields so it follows the chosen language. */
function connectionTooltip({ lastSuccessfulCheckAt, clockSkew }: ConnectionStatus) {
  return t('Last successful local check: {at}. ', { at: lastSuccessfulCheckAt ?? t('not yet confirmed') })
    + (clockSkew ? t('Source and browser clocks differ; freshness uses received heartbeats. ') : '')
    + t('Connection status does not indicate an agent is running.')
}

/**
 * Live connection indicator (§6). Sample mode demonstrates the placement. A live source shows the feed's measured
 * health (getConnectionStatus): it reads "Live updates" only while SSE messages keep arriving, never from an HTTP read.
 */
export function LiveIndicator() {
  const { mode } = useWorkspace()
  const { sourceKind } = useWorkModel()
  const connection = useConnection()
  const demonstration = sourceKind === 'sample'
  const live = demonstration || connection.isLive
  return (
    <Req ids={['R6.1', 'R6.4', 'R8.1']}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} data-connection-state={demonstration ? 'demonstration' : connection.state} className="inline-flex h-8 items-center gap-1.5 px-1 text-xs text-muted-foreground">
            <span className="relative flex size-2">
              {live && <span className="absolute inline-flex size-full rounded-full bg-shipped-foreground/40 motion-safe:animate-ping" />}
              <span className={cn('relative inline-flex size-2 rounded-full', live ? 'bg-shipped-foreground' : connection.tone === 'warning' ? 'bg-attention-foreground' : 'bg-idle-foreground')} />
            </span>
            {/* Phone: the dot alone (its colour carries the state, the tooltip the words) so the page title keeps whole words. */}
            <span className="sr-only sm:not-sr-only">{demonstration ? t('Live') : t(connection.label)}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">
          {demonstration
            ? mode === 'home' ? t('Streams from the local worker, localhost:37777 (demonstration)') : t('Checks cmem.ai for new sync changes every few seconds (demonstration)')
            : <>{t(connection.detail)} {connectionTooltip(connection)}</>}
        </TooltipContent>
      </Tooltip>
    </Req>
  )
}

/** Which machines are reporting and how fresh each one is (§13.6). This computer's freshness is the live feed's. */
export function DeviceFreshness() {
  const { sourceKind, devices } = useWorkModel()
  const connection = useConnection()
  const reportingNow = (device: Device) => sourceKind === 'sample' || device.syncedMinutesAgo !== 0 ? device.online : connection.isLive
  return (
    <Req ids={['R13.8', 'R13.2']}>
      <HoverCard openDelay={100}>
        <HoverCardTrigger asChild>
          <Button variant="ghost" size="sm" className="px-2 text-xs text-muted-foreground">{devices.length}<span className="hidden sm:inline">{t(devices.length === 1 ? 'machine' : 'machines')}</span><span className="sr-only sm:hidden">{t(devices.length === 1 ? 'machine' : 'machines')}</span></Button>
        </HoverCardTrigger>
        <HoverCardContent className="w-64 space-y-2">
          <p className="text-xs font-medium">{t('Machines reporting into this view')}</p>
          {devices.map((device) => (
            <div key={device.id} className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2">
                <span className={cn('size-1.5 rounded-full', reportingNow(device) ? 'bg-shipped-foreground' : 'bg-idle-foreground')} />
                {t(device.name)}
              </span>
              <span className="text-muted-foreground">{device.syncedMinutesAgo !== 0 ? t('synced {minutes} min ago', { minutes: device.syncedMinutesAgo }) : sourceKind === 'sample' ? t('this machine') : t(connection.label)}</span>
            </div>
          ))}
          {sourceKind !== 'sample' && <p className="text-xs text-muted-foreground">{connectionTooltip(connection)}</p>}
        </HoverCardContent>
      </HoverCard>
    </Req>
  )
}

const CLAUDE_MEM_REPO_URL = 'https://github.com/thedotmack/claude-mem'
const CLAUDE_MEM_REPO_API_URL = 'https://api.github.com/repos/thedotmack/claude-mem'

/** The repo's GitHub star count, read once from the public API. Shows no number until a real one arrives. */
export function GitHubStars() {
  const [stargazerCount, setStargazerCount] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(CLAUDE_MEM_REPO_API_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`GitHub repo read failed: HTTP ${response.status}`)
        return response.json() as Promise<{ stargazers_count: number }>
      })
      .then((repo) => { if (!cancelled) setStargazerCount(repo.stargazers_count) })
      .catch((error: unknown) => console.warn('[my-work] GitHub star count unavailable:', error))
    return () => { cancelled = true }
  }, [])
  return (
    <Button asChild variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs">
      <a href={CLAUDE_MEM_REPO_URL} target="_blank" rel="noreferrer" aria-label={t('Star claude-mem on GitHub')}>
        <StarIcon className="size-3.5" />
        <span className="hidden sm:inline">{t('Star')}</span>
        {stargazerCount !== null && <span className="tabular-nums">{new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(stargazerCount)}</span>}
      </a>
    </Button>
  )
}

/** Opens the My Work feedback form on GitHub (.github/ISSUE_TEMPLATE/my-work-feedback.yml). */
const MY_WORK_FEEDBACK_URL = `${CLAUDE_MEM_REPO_URL}/issues/new?template=my-work-feedback.yml`

export function FeedbackLink() {
  return (
    <Button asChild variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs">
      <a href={MY_WORK_FEEDBACK_URL} target="_blank" rel="noreferrer" aria-label={t('Send feedback about My Work on GitHub')}>
        <MessageSquareIcon className="size-3.5" />
        <span className="hidden sm:inline">{t('Feedback')}</span>
      </a>
    </Button>
  )
}

/** The previous memory viewer, still served by the worker at /viewer. */
export function ClassicViewerLink() {
  return (
    <a href="/viewer" className="hidden text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline md:inline" title={t('Open the previous memory viewer')}>
      {t('Classic viewer')}
    </a>
  )
}

/** Sample runs only (their machines are fixtures). Runs a skill from the GUI (§14): last run time, machine and progress (cost display dropped by the owner, Oct 20, 2026). On the web it queues for an online machine. */
export function RefreshButton({ run, ids }: { run: Run; ids: string[] }) {
  const { mode } = useWorkspace()
  const [state, setState] = useState(run.state)
  const nextMachine = SAMPLE_DEVICES.find((device) => device.online)!
  const runMachine = SAMPLE_DEVICES.find((device) => device.id === run.deviceId)
  if (!runMachine) throw new Error(`Sample run ${run.label} names no sample device ${run.deviceId}`)
  const start = () => {
    setState(mode === 'web' ? 'queued' : 'running')
    setTimeout(() => setState('idle'), 2400)
  }
  return (
    <Req ids={[...ids, 'R14.10', 'R14.11']}>
      <div className="flex w-full items-center gap-3 sm:w-auto">
        <span className="min-w-0 flex-1 text-xs leading-tight text-muted-foreground sm:text-right" aria-live="polite">
          {state === 'queued' && t('Queued for {machine}', { machine: nextMachine.name })}
          {state === 'running' && t('Running {skill} on {machine}…', { skill: run.label, machine: runMachine.name })}
          {state === 'idle' && <>{t('Last run')} {run.lastRunAt}<br />{t('on {machine}', { machine: runMachine.name })}</>}
        </span>
        <Button variant="outline" size="sm" className="h-11 min-w-11 md:h-8 md:min-w-0" onClick={start} disabled={state !== 'idle'} aria-label={t('Refresh {skill}', { skill: run.label })}>
          {state === 'idle' ? <RefreshCwIcon /> : <Spinner />}
          {t('Refresh')}
        </Button>
      </div>
    </Req>
  )
}

/**
 * The worker's automatic refresh: it runs owner-goals and request-progress on
 * the user's own logged-in agent whenever something is due, so there is no
 * command to copy. Before its first run, the last saved run shows instead.
 */
export function RefreshStatus({ refresh, run, ids, label = 'Last run' }: { refresh: AutoRefresh | null; run: SkillRun | null; ids: string[]; label?: string }) {
  let text: ReactNode = null
  if (refresh?.state === 'running') text = <span className="inline-flex items-center gap-1.5"><Spinner />{t('Updating your goals and progress…')}</span>
  else if (refresh?.error) text = refresh.state === 'waiting-for-agent' ? t('Waiting to refresh: {error}', { error: refresh.error }) : t('Refresh failed: {error}', { error: refresh.error })
  else if (refresh?.finishedAt) text = t('Last refreshed {at}', { at: refresh.finishedAt })
  else if (run) text = <>{t(label)} {run.lastRunAt}<br />{t('on {machine}', { machine: t(run.deviceName) })}</>
  if (!text) return null
  return (
    <Req ids={[...ids, 'R14.10']}>
      <span className="block w-full text-xs leading-tight text-muted-foreground sm:w-auto sm:text-right" aria-live="polite">{text}</span>
    </Req>
  )
}

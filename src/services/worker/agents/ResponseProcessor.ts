/**
 * ResponseProcessor: Shared response processing for all agent implementations
 *
 * Responsibility:
 * - Parse observations and summaries from agent responses
 * - Execute atomic database transactions
 * - Orchestrate Chroma sync (fire-and-forget)
 * - Broadcast to SSE clients
 * - Clean up processed messages
 *
 * This module extracts 150+ lines of duplicate code from SDKAgent, GeminiAgent, and OpenRouterAgent.
 */

import { logger } from '../../../utils/logger.js';
import { parseObservations, parseObservationsJson, parseSummary, parseSummaryJson, type ParsedObservation, type ParsedSummary } from '../../../sdk/parser.js';
import { SUMMARY_MODE_MARKER, MAX_CONSECUTIVE_SUMMARY_FAILURES } from '../../../sdk/prompts.js';
import { updateCursorContextForProject } from '../../integrations/CursorHooksInstaller.js';
import { notifyTelegram } from '../../integrations/TelegramNotifier.js';
import { updateFolderClaudeMdFiles } from '../../../utils/claude-md-utils.js';
import { getWorkerPort } from '../../../shared/worker-utils.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import type { ActiveSession } from '../../worker-types.js';
import type { DatabaseManager } from '../DatabaseManager.js';
import type { SessionManager } from '../SessionManager.js';
import type { WorkerRef, StorageResult } from './types.js';
import { broadcastObservation, broadcastSummary } from './ObservationBroadcaster.js';
import { cleanupProcessedMessages } from './SessionCleanupHelper.js';

/**
 * Options for processAgentResponse
 */
export interface ProcessAgentResponseOptions {
  /** If true, parse summary as JSON instead of XML (for Gemini with responseMimeType) */
  parseJsonSummary?: boolean;
  /** Separate summary text to parse (when using JSON format, summary comes from different API call) */
  summaryText?: string;
  /** If true, parse observations as JSON instead of XML (for CustomAgent with responseMimeType) */
  parseJsonObservation?: boolean;
  /** Separate observation text to parse (when using JSON format) */
  observationText?: string;
}

/**
 * Process agent response text (parse XML, save to database, sync to Chroma, broadcast SSE)
 *
 * This is the unified response processor that handles:
 * 1. Adding response to conversation history (for provider interop)
 * 2. Parsing observations and summaries from XML
 * 3. Atomic database transaction to store observations + summary
 * 4. Async Chroma sync (fire-and-forget, failures are non-critical)
 * 5. SSE broadcast to web UI clients
 * 6. Session cleanup
 *
 * @param text - Response text from the agent
 * @param session - Active session being processed
 * @param dbManager - Database manager for storage operations
 * @param sessionManager - Session manager for message tracking
 * @param worker - Worker reference for SSE broadcasting (optional)
 * @param discoveryTokens - Token cost delta for this response
 * @param originalTimestamp - Original epoch when message was queued (for accurate timestamps)
 * @param agentName - Name of the agent for logging (e.g., 'SDK', 'Gemini', 'OpenRouter')
 * @param projectRoot - Project root path for folder CLAUDE.md updates
 * @param options - Additional options for parsing behavior
 */
export async function processAgentResponse(
  text: string,
  session: ActiveSession,
  dbManager: DatabaseManager,
  sessionManager: SessionManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  originalTimestamp: number | null,
  agentName: string,
  projectRoot?: string,
  options?: ProcessAgentResponseOptions,
  modelId?: string
): Promise<void> {
  // Track generator activity for stale detection (Issue #1099)
  session.lastGeneratorActivity = Date.now();

  // Add assistant response to shared conversation history for provider interop.
  // Dedup guard: upstream agents (GeminiAgent/OpenRouterAgent) may pre-append the
  // assistant response before calling processAgentResponse. Since those are upstream
  // implementations we don't control, guard against duplicates here.
  if (text) {
    const lastMessage = session.conversationHistory[session.conversationHistory.length - 1];
    const alreadyAppended = lastMessage?.role === 'assistant' && lastMessage.content === text;
    if (!alreadyAppended) {
      session.conversationHistory.push({ role: 'assistant', content: text });
    }
  }

  // Parse observations - JSON or XML based on options
  let observations: ParsedObservation[];
  if (options?.parseJsonObservation && options?.observationText) {
    // JSON observations: explicitly provided (CustomAgent)
    observations = parseObservationsJson(options.observationText, session.contentSessionId);
  } else {
    // XML observations: parse from main response text
    observations = parseObservations(text, session.contentSessionId);
  }

  // Filter vacuous observations (AI generated "nothing to report" instead of skipping)
  const preFilterCount = observations.length;
  observations = observations.filter(obs => !isVacuousObservation(obs));
  if (observations.length < preFilterCount) {
    logger.info('PARSER', `Discarded ${preFilterCount - observations.length} vacuous observation(s)`, {
      sessionId: session.sessionDbId
    });
  }

  // Detect whether the most recent prompt was a summary request (#1633 fix).
  // Enables observation-to-summary coercion when XML parsing is used.
  const lastHistoryEntry = session.conversationHistory.at(-1);
  const lastUserMessage = lastHistoryEntry?.role === 'user'
    ? lastHistoryEntry
    : session.conversationHistory.findLast(m => m.role === 'user') ?? null;
  const summaryExpected = lastUserMessage?.content?.includes(SUMMARY_MODE_MARKER) ?? false;

  // Parse summary - only if explicitly requested or text contains summary markers
  let summary: ParsedSummary | null = null;
  if (options?.parseJsonSummary && options?.summaryText) {
    // JSON summary: explicitly provided
    summary = parseSummaryJson(options.summaryText, session.sessionDbId);
  } else if (text.includes('<summary>') || text.includes('<skip_summary') || summaryExpected) {
    // XML summary: parse if markers present, or when summary was requested (for coercion)
    summary = parseSummary(text, session.sessionDbId, summaryExpected);
  }

  // Detect non-XML responses (auth errors, rate limits, garbled output).
  // When the response contains no parseable XML and produced no observations,
  // mark the pending messages as failed instead of confirming them — this prevents
  // silent data loss when the LLM returns garbage (#1874).
  const isNonXmlResponse = (
    text.trim() &&
    observations.length === 0 &&
    !summary &&
    !/<observation>|<summary>|<skip_summary\b/.test(text)
  );

  if (isNonXmlResponse) {
    const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
    logger.warn('PARSER', `${agentName} returned non-XML response; marking messages as failed for retry (#1874)`, {
      sessionId: session.sessionDbId,
      preview
    });

    // Mark messages as failed (retry logic in PendingMessageStore handles retries)
    const pendingStore = sessionManager.getPendingMessageStore();
    for (const messageId of session.processingMessageIds) {
      pendingStore.markFailed(messageId);
    }
    session.processingMessageIds = [];
    return;
  }

  // Convert nullable fields to empty strings for storeSummary (if summary exists)
  const summaryForStore = normalizeSummaryForStorage(summary);

  // Get session store for atomic transaction
  const sessionStore = dbManager.getSessionStore();

  // CRITICAL: Must use memorySessionId (not contentSessionId) for FK constraint
  if (!session.memorySessionId) {
    throw new Error('Cannot store observations: memorySessionId not yet captured');
  }

  // SAFETY NET (Issue #846 / Multi-terminal FK fix):
  // The PRIMARY fix is in SDKAgent.ts where ensureMemorySessionIdRegistered() is called
  // immediately when the SDK returns a memory_session_id. This call is a defensive safety net
  // in case the DB was somehow not updated (race condition, crash, etc.).
  // In multi-terminal scenarios, createSDKSession() now resets memory_session_id to NULL
  // for each new generator, ensuring clean isolation.
  sessionStore.ensureMemorySessionIdRegistered(session.sessionDbId, session.memorySessionId);

  // Log pre-storage with session ID chain for verification
  logger.info('DB', `STORING | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${observations.length} | hasSummary=${!!summaryForStore}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  // Label observations with the subagent identity captured from the claimed messages.
  // Main-session messages leave these null, so main-session rows stay NULL in the DB.
  const labeledObservations = observations.map(obs => ({
    ...obs,
    agent_type: session.pendingAgentType ?? null,
    agent_id: session.pendingAgentId ?? null
  }));

  // ATOMIC TRANSACTION: Store observations + summary ONCE
  // Messages are already deleted from queue on claim, so no completion tracking needed.
  // Wrap in try/finally so the subagent tracker clears even if storage throws —
  // otherwise stale identity could leak into the next batch and mislabel rows.
  // Expected invariant: all observations in a batch share the same agent context,
  // because ResponseProcessor runs after a single agent-response cycle.
  let result: ReturnType<typeof sessionStore.storeObservations>;
  try {
    result = sessionStore.storeObservations(
      session.memorySessionId,
      session.project,
      labeledObservations,
      summaryForStore,
      session.lastPromptNumber,
      discoveryTokens,
      originalTimestamp ?? undefined,
      modelId
    );
  } finally {
    session.pendingAgentId = null;
    session.pendingAgentType = null;
  }

  // Log storage result with IDs for end-to-end traceability
  logger.info('DB', `STORED | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${result.observationIds.length} | obsIds=[${result.observationIds.join(',')}] | summaryId=${result.summaryId || 'none'}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  // Track whether a summary record was stored so the status endpoint can expose this
  // to the Stop hook for silent-summary-loss detection (#1633)
  session.lastSummaryStored = result.summaryId !== null;

  // Circuit breaker: track consecutive summary failures (#1633).
  // Only evaluate when a summary was actually expected (summarize message was sent).
  // Without this guard, the counter would increment on every normal observation
  // response, tripping the breaker after 3 observations and permanently blocking
  // summarization — reproducing the data-loss scenario this fix is meant to prevent.
  if (summaryExpected) {
    const skippedIntentionally = /<skip_summary\b/.test(text);
    if (summaryForStore !== null) {
      // Summary was present in the response — reset the failure counter
      session.consecutiveSummaryFailures = 0;
    } else if (skippedIntentionally) {
      // Explicit <skip_summary/> is a valid protocol response — neither success
      // nor failure. Leave the counter unchanged so we don't mask a bad run that
      // happens to end on a skip, but also don't punish intentional skips.
    } else {
      // Summary was expected but none was stored — count as failure
      session.consecutiveSummaryFailures += 1;
      if (session.consecutiveSummaryFailures >= MAX_CONSECUTIVE_SUMMARY_FAILURES) {
        logger.error('SESSION', `Circuit breaker: ${session.consecutiveSummaryFailures} consecutive summary failures — further summarize requests will be skipped (#1633)`, {
          sessionId: session.sessionDbId,
          contentSessionId: session.contentSessionId
        });
      }
    }
  }

  // CLAIM-CONFIRM: Now that storage succeeded, confirm all processing messages (delete from queue)
  // This is the critical step that prevents message loss on generator crash
  const pendingStore = sessionManager.getPendingMessageStore();
  for (const messageId of session.processingMessageIds) {
    pendingStore.confirmProcessed(messageId);
  }
  if (session.processingMessageIds.length > 0) {
    logger.debug('QUEUE', `CONFIRMED_BATCH | sessionDbId=${session.sessionDbId} | count=${session.processingMessageIds.length} | ids=[${session.processingMessageIds.join(',')}]`);
    // Record successful processing so restart guard decay is anchored to real successes
    session.restartGuard?.recordSuccess();
  }
  // Clear the tracking array after confirmation
  session.processingMessageIds = [];

  void notifyTelegram({
    observations: labeledObservations,
    observationIds: result.observationIds,
    project: session.project,
    memorySessionId: session.memorySessionId,
  });

  // AFTER transaction commits - async operations (can fail safely without data loss)
  await syncAndBroadcastObservations(
    observations,
    result,
    session,
    dbManager,
    worker,
    discoveryTokens,
    agentName,
    projectRoot
  );

  // Sync and broadcast summary if present
  await syncAndBroadcastSummary(
    summary,
    summaryForStore,
    result,
    session,
    dbManager,
    worker,
    discoveryTokens,
    agentName
  );

  // Clean up session state
  cleanupProcessedMessages(session, worker);
}

/**
 * Normalize summary for storage (convert null fields to empty strings)
 */
function normalizeSummaryForStorage(summary: ParsedSummary | null): {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
} | null {
  if (!summary) return null;

  return {
    request: summary.request || '',
    investigated: summary.investigated || '',
    learned: summary.learned || '',
    completed: summary.completed || '',
    next_steps: summary.next_steps || '',
    notes: summary.notes
  };
}

/**
 * Sync observations to Chroma and broadcast to SSE clients
 */
async function syncAndBroadcastObservations(
  observations: ParsedObservation[],
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string,
  projectRoot?: string
): Promise<void> {
  for (let i = 0; i < observations.length; i++) {
    const obsId = result.observationIds[i];
    const obs = observations[i];
    const chromaStart = Date.now();

    // Sync to Chroma (fire-and-forget, skipped if Chroma is disabled)
    dbManager.getChromaSync()?.syncObservation(
      obsId,
      session.contentSessionId,
      session.project,
      obs,
      session.lastPromptNumber,
      result.createdAtEpoch,
      discoveryTokens
    ).then(() => {
      const chromaDuration = Date.now() - chromaStart;
      logger.debug('CHROMA', 'Observation synced', {
        obsId,
        duration: `${chromaDuration}ms`,
        type: obs.type,
        title: obs.title || '(untitled)'
      });
    }).catch((error) => {
      logger.error('CHROMA', `${agentName} chroma sync failed, continuing without vector search`, {
        obsId,
        type: obs.type,
        title: obs.title || '(untitled)'
      }, error);
    });

    // Broadcast to SSE clients (for web UI)
    // BUGFIX: Use obs.files_read and obs.files_modified (not obs.files)
    broadcastObservation(worker, {
      id: obsId,
      memory_session_id: session.memorySessionId,
      session_id: session.contentSessionId,
      platform_source: session.platformSource,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      text: null,  // text field is not in ParsedObservation
      narrative: obs.narrative || null,
      facts: JSON.stringify(obs.facts || []),
      concepts: JSON.stringify(obs.concepts || []),
      files_read: JSON.stringify(obs.files_read || []),
      files_modified: JSON.stringify(obs.files_modified || []),
      project: session.project,
      prompt_number: session.lastPromptNumber,
      created_at_epoch: result.createdAtEpoch
    });
  }

  // Update folder CLAUDE.md files for touched folders (fire-and-forget)
  // This runs per-observation batch to ensure folders are updated as work happens
  // Only runs if CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED is true (default: false)
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  // Handle both string 'true' and boolean true from JSON settings
  const settingValue = settings.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED;
  const folderClaudeMdEnabled = settingValue === 'true' || settingValue === true;

  if (folderClaudeMdEnabled) {
    const allFilePaths: string[] = [];
    for (const obs of observations) {
      allFilePaths.push(...(obs.files_modified || []));
      allFilePaths.push(...(obs.files_read || []));
    }

    if (allFilePaths.length > 0) {
      updateFolderClaudeMdFiles(
        allFilePaths,
        session.project,
        getWorkerPort(),
        projectRoot
      ).catch(error => {
        logger.warn('FOLDER_INDEX', 'CLAUDE.md update failed (non-critical)', { project: session.project }, error as Error);
      });
    }
  }
}

/**
 * Sync summary to Chroma and broadcast to SSE clients
 */
async function syncAndBroadcastSummary(
  summary: ParsedSummary | null,
  summaryForStore: { request: string; investigated: string; learned: string; completed: string; next_steps: string; notes: string | null } | null,
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string
): Promise<void> {
  if (!summaryForStore || !result.summaryId) {
    return;
  }

  const chromaStart = Date.now();

  // Sync to Chroma (fire-and-forget, skipped if Chroma is disabled)
  dbManager.getChromaSync()?.syncSummary(
    result.summaryId,
    session.contentSessionId,
    session.project,
    summaryForStore,
    session.lastPromptNumber,
    result.summaryCreatedAtEpoch ?? result.createdAtEpoch,
    discoveryTokens
  ).then(() => {
    const chromaDuration = Date.now() - chromaStart;
    logger.debug('CHROMA', 'Summary synced', {
      summaryId: result.summaryId,
      duration: `${chromaDuration}ms`,
      request: summaryForStore.request || '(no request)'
    });
  }).catch((error) => {
    logger.error('CHROMA', `${agentName} chroma sync failed, continuing without vector search`, {
      summaryId: result.summaryId,
      request: summaryForStore.request || '(no request)'
    }, error);
  });

  // Broadcast to SSE clients (for web UI)
  broadcastSummary(worker, {
    id: result.summaryId,
    session_id: session.contentSessionId,
    memory_session_id: session.memorySessionId!,
    platform_source: session.platformSource,
    request: summaryForStore!.request,
    investigated: summaryForStore!.investigated,
    learned: summaryForStore!.learned,
    completed: summaryForStore!.completed,
    next_steps: summaryForStore!.next_steps,
    notes: summaryForStore!.notes,
    project: session.project,
    prompt_number: session.lastPromptNumber,
    created_at_epoch: result.summaryCreatedAtEpoch ?? result.createdAtEpoch
  });

  // Update Cursor context file for registered projects (fire-and-forget)
  updateCursorContextForProject(session.project, getWorkerPort()).catch(error => {
    logger.warn('CURSOR', 'Context update failed (non-critical)', { project: session.project }, error as Error);
  });
}

/**
 * Detect vacuous observations that should have been skipped by the AI.
 *
 * An observation is vacuous when it carries zero concrete data AND its
 * title/narrative explicitly says "nothing happened".  This catches the
 * case where the AI ignores skip_guidance and emits a placeholder
 * observation instead of producing no output.
 *
 * Conservative: requires BOTH empty data and matching text patterns,
 * so legitimate discoveries with real facts/files are never discarded.
 */
const VACUOUS_PATTERNS = [
  /无新增/,
  /无新观察/,
  /无新的/,
  /无观察/,
  /尚未记录/,
  /尚未收到/,
  /尚未执行/,
  /尚无可记录/,
  /没有新的/,
  /没有变更/,
  /暂无/,
  /暂未观察/,
  /等待更多/,
  /等待进一步/,
  /无后续/,
  /未捕获/,
  /未捕捉/,
  /未观测/,
  /未观察到/,
  /未产生/,
  /无法生成/,
  /未收到/,
  /未提供/,
  /no new observation/i,
  /no observation/i,
  /nothing to report/i,
  /no updates/i,
  /no changes/i,
  /waiting for/i,
  /no activity/i,
];

/**
 * Heuristic: facts contain concrete artifacts (file paths, code identifiers,
 * URLs, version numbers, error codes) that indicate real work product.
 * Pure natural-language commentary without artifacts is not concrete.
 */
const CONCRETE_FACT_PATTERNS = [
  /[/\\][\w.-]+\.\w{1,5}/,    // file paths  (foo/bar.ts, src\utils.js)
  /\b\w+\.\w+\(/,             // function calls (foo.bar()
  /\b(?:v?\d+\.\d+)/,         // version numbers (v1.2, 3.0)
  /\bhttps?:\/\//,             // URLs
  /\b(?:0x[\da-f]+|err(?:or)?[- ]?\d+)/i, // hex/error codes
  /`[^`]+`/,                   // inline code references
  /\b[A-Z_]{2,}\b/,           // CONSTANT_CASE identifiers
];

function isVacuousObservation(obs: ParsedObservation): boolean {
  // Files always indicate real work
  if (obs.files_read.length > 0 || obs.files_modified.length > 0) {
    return false;
  }
  const text = `${obs.title || ''} ${obs.subtitle || ''} ${obs.narrative || ''}`;
  if (!VACUOUS_PATTERNS.some(p => p.test(text))) {
    return false;
  }
  // Title/narrative matched vacuous pattern.
  // If no facts, clearly vacuous.
  if (obs.facts.length === 0) {
    return true;
  }
  // Facts exist: only keep the observation if facts contain concrete
  // artifacts (paths, identifiers, URLs, etc.).  Pure prose restating
  // "nothing happened" in different words is still vacuous.
  const factsText = obs.facts.join(' ');
  return !CONCRETE_FACT_PATTERNS.some(p => p.test(factsText));
}

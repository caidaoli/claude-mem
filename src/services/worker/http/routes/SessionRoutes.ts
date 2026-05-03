
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { ingestObservation } from '../shared.js';
import { validateBody } from '../middleware/validateBody.js';
import { logger } from '../../../../utils/logger.js';
import { stripMemoryTagsFromPrompt, isInternalProtocolPayload } from '../../../../utils/tag-stripping.js';
import { SessionManager } from '../../SessionManager.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { ClaudeProvider } from '../../ClaudeProvider.js';
import { GeminiProvider, isGeminiSelected, isGeminiAvailable } from '../../GeminiProvider.js';
import { OpenRouterProvider, isOpenRouterSelected, isOpenRouterAvailable } from '../../OpenRouterProvider.js';
import { CustomAgent, isCustomSelected, isCustomAvailable } from '../../CustomAgent.js';
import type { WorkerService } from '../../../worker-service.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { SessionEventBroadcaster } from '../../events/SessionEventBroadcaster.js';
import { PrivacyCheckValidator } from '../../validation/PrivacyCheckValidator.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { getProjectContext } from '../../../../utils/project-name.js';
import { normalizePlatformSource } from '../../../../shared/platform-source.js';
import { handleGeneratorExit } from '../../session/GeneratorExitHandler.js';
import { SessionCompletionHandler } from '../../session/SessionCompletionHandler.js';

const MAX_USER_PROMPT_BYTES = 256 * 1024;

export class SessionRoutes extends BaseRouteHandler {
  constructor(
    private sessionManager: SessionManager,
    private dbManager: DatabaseManager,
    private sdkAgent: ClaudeProvider,
    private geminiAgent: GeminiProvider,
    private openRouterAgent: OpenRouterProvider,
    private customAgent: CustomAgent,
    private eventBroadcaster: SessionEventBroadcaster,
    private workerService: WorkerService,
    private completionHandler: SessionCompletionHandler,
  ) {
    super();
  }

  /**
   * Get the appropriate agent based on settings
   * Throws error if provider is selected but not configured (no silent fallback)
   *
   * Note: Session linking via contentSessionId allows provider switching mid-session.
   * The conversationHistory on ActiveSession maintains context across providers.
   */
  private getActiveAgent(): ClaudeProvider | GeminiProvider | OpenRouterProvider | CustomAgent {
    if (isCustomSelected()) {
      if (isCustomAvailable()) {
        logger.debug('SESSION', 'Using Custom agent');
        return this.customAgent;
      } else {
        throw new Error('Custom provider selected but not configured. Set CLAUDE_MEM_CUSTOM_API_URL and CLAUDE_MEM_CUSTOM_API_KEY in settings.');
      }
    }
    if (isOpenRouterSelected()) {
      if (isOpenRouterAvailable()) {
        logger.debug('SESSION', 'Using OpenRouter agent');
        return this.openRouterAgent;
      } else {
        throw new Error('OpenRouter provider selected but no API key configured. Set CLAUDE_MEM_OPENROUTER_API_KEY in settings or OPENROUTER_API_KEY environment variable.');
      }
    }
    if (isGeminiSelected()) {
      if (isGeminiAvailable()) {
        logger.debug('SESSION', 'Using Gemini agent');
        return this.geminiAgent;
      } else {
        throw new Error('Gemini provider selected but no API key configured. Set CLAUDE_MEM_GEMINI_API_KEY in settings or GEMINI_API_KEY environment variable.');
      }
    }
    return this.sdkAgent;
  }

  /**
   * Get the currently selected provider name
   */
  private getSelectedProvider(): 'claude' | 'gemini' | 'openrouter' | 'custom' {
    if (isCustomSelected() && isCustomAvailable()) return 'custom';
    if (isOpenRouterSelected() && isOpenRouterAvailable()) return 'openrouter';
    return (isGeminiSelected() && isGeminiAvailable()) ? 'gemini' : 'claude';
  }

  public ensureGeneratorRunning(sessionDbId: number, source: string): void {
    const session = this.sessionManager.getSession(sessionDbId);
    if (!session) return;

    // Wall-clock age guard: refuse to start new generators for sessions that have
    // been alive too long to prevent runaway API costs (Issue #1590).
    // Use the persisted started_at_epoch from the DB so the guard survives worker
    // restarts (session.startTime is reset to Date.now() on every re-activation).
    const dbSessionRecord = this.dbManager.getSessionStore().db
      .prepare('SELECT started_at_epoch FROM sdk_sessions WHERE id = ? LIMIT 1')
      .get(sessionDbId) as { started_at_epoch: number } | undefined;
    const sessionOriginMs = dbSessionRecord?.started_at_epoch ?? session.startTime;
    const sessionAgeMs = Date.now() - sessionOriginMs;
    if (sessionAgeMs > SessionRoutes.MAX_SESSION_WALL_CLOCK_MS) {
      logger.warn('SESSION', 'Session exceeded wall-clock age limit — aborting to prevent runaway spend', {
        sessionId: sessionDbId,
        ageHours: Math.round(sessionAgeMs / 3_600_000 * 10) / 10,
        limitHours: SessionRoutes.MAX_SESSION_WALL_CLOCK_MS / 3_600_000,
        source
      });
      if (!session.abortController.signal.aborted) {
        session.abortController.abort();
      }
      const pendingStore = this.sessionManager.getPendingMessageStore();
      pendingStore.transitionMessagesTo('abandoned', { sessionDbId });
      this.sessionManager.removeSessionImmediate(sessionDbId);
      return;
    }

    // Circuit breaker: if restart limit was exceeded, don't start generator.
    // Observations are already persisted to DB by queueObservation() before this call,
    // so skipping here only prevents starting the generator — no data loss.
    const MAX_CONSECUTIVE_RESTARTS = 3;
    if (session.consecutiveRestarts > MAX_CONSECUTIVE_RESTARTS) {
      logger.warn('SESSION', 'Circuit breaker active - generator not started (restart limit exceeded)', {
        sessionDbId,
        source,
        consecutiveRestarts: session.consecutiveRestarts,
        maxRestarts: MAX_CONSECUTIVE_RESTARTS
      });
      return;
    }

    // GUARD: Prevent duplicate spawns
    if (this.spawnInProgress.get(sessionDbId)) {
      logger.debug('SESSION', 'Spawn already in progress, skipping', { sessionDbId, source });
      return;
    }

    const selectedProvider = this.getSelectedProvider();

    if (!session.generatorPromise) {
      this.applyTierRouting(session);
      this.startGeneratorWithProvider(session, selectedProvider, source);
      return;
    }

    if (session.currentProvider && session.currentProvider !== selectedProvider) {
      logger.info('SESSION', `Provider changed, will switch after current generator finishes`, {
        sessionId: sessionDbId,
        currentProvider: session.currentProvider,
        selectedProvider,
        historyLength: session.conversationHistory.length
      });
      // Let current generator finish naturally, next one will use new provider
      // The shared conversationHistory ensures context is preserved
    }
  }

  private startGeneratorWithProvider(
    session: ReturnType<typeof this.sessionManager.getSession>,
    provider: 'claude' | 'gemini' | 'openrouter' | 'custom',
    source: string
  ): void {
    if (!session) return;

    if (session.abortController.signal.aborted) {
      logger.debug('SESSION', 'Resetting aborted AbortController before starting generator', {
        sessionId: session.sessionDbId
      });
      session.abortController = new AbortController();
    }

    // Reset empty response counter so the new generator gets a fair chance.
    // Without this, the counter survives across generator restarts and causes
    // a death spiral where every new generator is immediately killed.
    session.consecutiveEmptyResponses = 0;

    // Agent registry: maps provider names to their agents and display names
    const agentRegistry: Record<string, { agent: SDKAgent | GeminiAgent | OpenRouterAgent | CustomAgent; name: string }> = {
      custom: { agent: this.customAgent, name: 'Custom' },
      openrouter: { agent: this.openRouterAgent, name: 'OpenRouter' },
      gemini: { agent: this.geminiAgent, name: 'Gemini' },
      claude: { agent: this.sdkAgent, name: 'Claude SDK' },
    };

    const { agent, name: agentName } = agentRegistry[provider] || agentRegistry.claude;

    const pendingStore = this.sessionManager.getPendingMessageStore();
    const actualQueueDepth = pendingStore.getPendingCount(session.sessionDbId);

    logger.info('SESSION', `Generator auto-starting (${source}) using ${agentName}`, {
      sessionId: session.sessionDbId,
      queueDepth: actualQueueDepth,
      historyLength: session.conversationHistory.length
    });

    session.currentProvider = provider;
    session.lastGeneratorActivity = Date.now();

    const myController = session.abortController;

    session.generatorPromise = agent.startSession(session, this.workerService)
      .catch(error => {
        if (myController.signal.aborted) {
          logger.debug('HTTP', 'Generator catch: ignoring error after abort', { sessionId: session.sessionDbId });
          return;
        }

        const errorMsg = error instanceof Error ? error.message : String(error);

        if (errorMsg.includes('code 143') || errorMsg.includes('signal SIGTERM')) {
          logger.warn('SESSION', 'Generator killed by external signal — aborting session to prevent respawn', {
            sessionId: session.sessionDbId,
            provider,
            error: errorMsg
          });
          myController.abort();
          return;
        }

        logger.error('SESSION', `Generator failed`, {
          sessionId: session.sessionDbId,
          provider: provider,
          error: errorMsg
        }, error);

        const pendingStore = this.sessionManager.getPendingMessageStore();
        try {
          const cleared = pendingStore.clearPendingForSession(session.sessionDbId);
          if (cleared > 0) {
            logger.error('SESSION', `Cleared pending messages after generator error`, {
              sessionId: session.sessionDbId,
              cleared
            });
          }
        } catch (dbError) {
          const normalizedDbError = dbError instanceof Error ? dbError : new Error(String(dbError));
          logger.error('HTTP', 'Failed to clear pending messages', {
            sessionId: session.sessionDbId
          }, normalizedDbError);
        }
      })
      .finally(async () => {
        // Primary-path subprocess teardown — process-group kill ensures any
        // SDK descendants are reaped too (Principle 5).
        const tracked = getSdkProcessForSession(session.sessionDbId);
        if (tracked && !tracked.process.killed && tracked.process.exitCode === null) {
          await ensureSdkProcessExit(tracked, 5000);
        }

        const sessionDbId = session.sessionDbId;
        this.spawnInProgress.delete(sessionDbId);
        const wasAborted = session.abortController.signal.aborted;
        const wasCompletionRequested = session.completionRequested === true;

        if (wasCompletionRequested) {
          logger.info('SESSION', 'Generator exited after graceful completion', { sessionId: sessionDbId });
        } else if (wasAborted) {
          logger.info('SESSION', `Generator aborted`, { sessionId: sessionDbId });

          // #2192: when the generator aborts (idle timeout, user cancel,
          // shutdown) with rows already claimed and yielded but not yet
          // confirmed by ResponseProcessor, those rows sit in 'processing'
          // under THIS worker's PID. The self-healing claim predicate skips
          // them because the worker is still alive — the queue deadlocks
          // until the worker restarts. Walk the in-flight ids and run them
          // through markFailed so the retry ladder requeues them or marks
          // them terminally failed.
          const inflightStore = this.sessionManager.getPendingMessageStore();
          const inflightIds = session.processingMessageIds.slice();
          session.processingMessageIds = [];
          for (const messageId of inflightIds) {
            try {
              inflightStore.markFailed(messageId);
            } catch (markErr) {
              const normalized = markErr instanceof Error ? markErr : new Error(String(markErr));
              logger.error('SESSION', 'Failed to requeue in-flight message after abort', {
                sessionId: sessionDbId,
                messageId,
              }, normalized);
            }
          }
        }
        // Don't log "exited unexpectedly" here — a non-abort exit is normal when
        // the SDK subprocess completes its work. The crash-recovery block below
        // checks pendingCount to distinguish real crashes from clean exits (#1876).

        session.generatorPromise = null;
        session.currentProvider = null;
        this.workerService.broadcastProcessingStatus();

        // Crash recovery: If not aborted and still has work, restart (with limit)
        if (!wasAborted) {
          const pendingStore = this.sessionManager.getPendingMessageStore();

          let pendingCount: number;
          try {
            pendingCount = pendingStore.getPendingCount(sessionDbId);
          } catch (e) {
            const normalizedRecoveryError = e instanceof Error ? e : new Error(String(e));
            logger.error('HTTP', 'Error during recovery check, aborting to prevent leaks', { sessionId: sessionDbId }, normalizedRecoveryError);
            session.abortController.abort();
            return;
          }

          if (pendingCount > 0) {
            // GUARD: Prevent duplicate crash recovery spawns
            if (this.crashRecoveryScheduled.has(sessionDbId)) {
              logger.debug('SESSION', 'Crash recovery already scheduled', { sessionDbId });
              return;
            }

            // Windowed restart guard: only blocks tight-loop restarts, not spread-out ones (#2053)
            if (!session.restartGuard) session.restartGuard = new RestartGuard();
            const restartAllowed = session.restartGuard.recordRestart();
            session.consecutiveRestarts = (session.consecutiveRestarts || 0) + 1; // Keep for logging

            if (!restartAllowed) {
              logger.error('SESSION', `CRITICAL: Restart guard tripped — session is dead, draining pending messages and terminating`, {
                sessionId: sessionDbId,
                pendingCount,
                restartsInWindow: session.restartGuard.restartsInWindow,
                windowMs: session.restartGuard.windowMs,
                maxRestarts: session.restartGuard.maxRestarts,
                consecutiveFailures: session.restartGuard.consecutiveFailuresSinceSuccess,
                maxConsecutiveFailures: session.restartGuard.maxConsecutiveFailures,
                action: 'Generator will NOT restart. Pending messages drained to abandoned. Check logs for root cause.'
              });
              // Don't restart - abort to prevent further API calls AND drain pending
              // messages so the session doesn't reappear in getSessionsWithPendingMessages
              // and trigger another auto-start cycle.
              session.abortController.abort();
              try {
                const drained = pendingStore.transitionMessagesTo('abandoned', { sessionDbId });
                if (drained > 0) {
                  logger.error('SESSION', 'Drained pending messages to abandoned after restart guard trip', {
                    sessionId: sessionDbId,
                    drained,
                  });
                }
              } catch (drainErr) {
                const normalized = drainErr instanceof Error ? drainErr : new Error(String(drainErr));
                logger.error('SESSION', 'Failed to drain pending messages after restart guard trip', {
                  sessionId: sessionDbId,
                }, normalized);
              }
              return;
            }

            logger.info('SESSION', `Restarting generator after crash/exit with pending work`, {
              sessionId: sessionDbId,
              pendingCount,
              consecutiveRestarts: session.consecutiveRestarts,
              restartsInWindow: session.restartGuard!.restartsInWindow,
              maxRestarts: session.restartGuard!.maxRestarts,
              consecutiveFailures: session.restartGuard!.consecutiveFailuresSinceSuccess,
              maxConsecutiveFailures: session.restartGuard!.maxConsecutiveFailures
            });

            // Abort OLD controller before replacing to prevent child process leaks
            const oldController = session.abortController;
            session.abortController = new AbortController();
            oldController.abort();

            this.crashRecoveryScheduled.add(sessionDbId);

            // Exponential backoff: 1s, 2s, 4s for subsequent restarts
            const backoffMs = Math.min(1000 * Math.pow(2, session.consecutiveRestarts - 1), 8000);

            // Delay before restart with exponential backoff
            setTimeout(() => {
              this.crashRecoveryScheduled.delete(sessionDbId);
              const stillExists = this.sessionManager.getSession(sessionDbId);
              if (stillExists && !stillExists.generatorPromise) {
                this.applyTierRouting(stillExists);
                this.startGeneratorWithProvider(stillExists, this.getSelectedProvider(), 'crash-recovery');
              }
            }, backoffMs);
          } else {
            // No pending work - abort to kill the child process
            session.abortController.abort();
            // Reset restart counter on successful completion
            session.consecutiveRestarts = 0;
            logger.debug('SESSION', 'Aborted controller after natural completion', {
              sessionId: sessionDbId
            });
          }
        }
        // NOTE: We do NOT delete the session here anymore.
        // The generator waits for events, so if it exited, it's either aborted or crashed.
        // Idle sessions stay in memory (ActiveSession is small) to listen for future events.
      });
  }

  setupRoutes(app: express.Application): void {
    app.post(
      '/api/sessions/init',
      validateBody(SessionRoutes.sessionInitByClaudeIdSchema),
      this.handleSessionInitByClaudeId.bind(this)
    );
    app.post(
      '/api/sessions/observations',
      validateBody(SessionRoutes.observationsByClaudeIdSchema),
      this.handleObservationsByClaudeId.bind(this)
    );
    app.post(
      '/api/sessions/summarize',
      validateBody(SessionRoutes.summarizeByClaudeIdSchema),
      this.handleSummarizeByClaudeId.bind(this)
    );
    app.get('/api/sessions/status', this.handleStatusByClaudeId.bind(this));
  }

  private static readonly sessionInitByClaudeIdSchema = z.object({
    contentSessionId: z.string().min(1),
    project: z.string().optional(),
    prompt: z.string().optional(),
    platformSource: z.string().optional(),
    customTitle: z.string().optional(),
  }).passthrough();

  private static readonly observationsByClaudeIdSchema = z.object({
    contentSessionId: z.string().min(1),
    tool_name: z.string().min(1),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    cwd: z.string().optional(),
    agentId: z.string().optional(),
    agentType: z.string().optional(),
    platformSource: z.string().optional(),
    tool_use_id: z.string().optional(),
    toolUseId: z.string().optional(),
  }).passthrough();

  private static readonly summarizeByClaudeIdSchema = z.object({
    contentSessionId: z.string().min(1),
    last_assistant_message: z.string().optional(),
    agentId: z.string().optional(),
    platformSource: z.string().optional(),
  }).passthrough();

  private handleObservationsByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const {
      contentSessionId,
      tool_name,
      tool_input,
      tool_response,
      cwd,
      platformSource,
      agentId,
      agentType,
      tool_use_id,
      toolUseId,
    } = req.body;

    const result = ingestObservation({
      contentSessionId,
      toolName: tool_name,
      toolInput: tool_input,
      toolResponse: tool_response,
      cwd,
      platformSource,
      agentId,
      agentType,
      toolUseId: typeof tool_use_id === 'string' ? tool_use_id : (typeof toolUseId === 'string' ? toolUseId : undefined),
    });

    if (!result.ok) {
      res.status(result.status ?? 500).json({ stored: false, reason: result.reason });
      return;
    }

    if ('status' in result && result.status === 'skipped') {
      res.json({ status: 'skipped', reason: result.reason });
      return;
    }

    res.json({ status: 'queued' });
  });

  private handleSummarizeByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const { contentSessionId, last_assistant_message, agentId } = req.body;
    const platformSource = normalizePlatformSource(req.body.platformSource);

    if (agentId) {
      res.json({ status: 'skipped', reason: 'subagent_context' });
      return;
    }

    const store = this.dbManager.getSessionStore();

    const sessionDbId = store.createSDKSession(contentSessionId, '', '', undefined, platformSource);
    const promptCount = store.getPromptNumberFromUserPrompts(contentSessionId);

    const userPrompt = PrivacyCheckValidator.checkUserPromptPrivacy(
      store,
      contentSessionId,
      promptCount,
      'summarize',
      sessionDbId
    );
    if (!userPrompt) {
      res.json({ status: 'skipped', reason: 'private' });
      return;
    }

    const wasCompleted = store.isSessionCompleted(sessionDbId);

    const cleanedLastAssistantMessage = last_assistant_message
      ? stripMemoryTagsFromPrompt(String(last_assistant_message))
      : last_assistant_message;

    // Summarize is allowed even for completed sessions: stop-hook can race complete→summarize.
    // If we're already completed, re-queue summarize + a completion control message so the
    // session can finalize deterministically without resurrecting observations.
    // NOT calling markSessionActive(): late-summarize must not re-open the gate for new observations.
    if (wasCompleted) {
      logger.info('SESSION', 'Late summarize for completed session (re-queueing completion)', {
        contentSessionId,
        sessionDbId
      });

      const pendingStore = this.sessionManager.getPendingMessageStore();
      pendingStore.clearPendingComplete(sessionDbId);

      this.sessionManager.queueSummarize(sessionDbId, cleanedLastAssistantMessage);
      this.sessionManager.queueComplete(sessionDbId);

      this.ensureGeneratorRunning(sessionDbId, 'summarize-late');

      // Broadcast summarize queued event
      this.eventBroadcaster.broadcastSummarizeQueued();

      res.json({ status: 'queued' });
      return;
    }

    // Queue summarize (normal path)
    this.sessionManager.queueSummarize(sessionDbId, cleanedLastAssistantMessage);

    this.ensureGeneratorRunning(sessionDbId, 'summarize');

    this.eventBroadcaster.broadcastSummarizeQueued();

    res.json({ status: 'queued' });
  });

  private handleStatusByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const contentSessionId = req.query.contentSessionId as string;

    if (!contentSessionId) {
      return this.badRequest(res, 'Missing contentSessionId query parameter');
    }

    const store = this.dbManager.getSessionStore();
    const sessionDbId = store.createSDKSession(contentSessionId, '', '');
    const session = this.sessionManager.getSession(sessionDbId);

    if (!session) {
      res.json({ status: 'not_found', queueLength: 0 });
      return;
    }

    const pendingStore = this.sessionManager.getPendingMessageStore();
    const queueLength = pendingStore.getPendingCount(sessionDbId);

    res.json({
      status: 'active',
      sessionDbId,
      queueLength,
      summaryStored: session.lastSummaryStored ?? null,
      uptime: Date.now() - session.startTime
    });
  });

  private handleSessionInitByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const { contentSessionId } = req.body;

    const project = req.body.project || 'unknown';
    const rawPrompt = typeof req.body.prompt === 'string' ? req.body.prompt : undefined;
    const platformSource = normalizePlatformSource(req.body.platformSource);
    const customTitle = req.body.customTitle || undefined;

    if (rawPrompt && isInternalProtocolPayload(rawPrompt)) {
      logger.debug('HTTP', 'session-init: skipping internal protocol payload before session creation', { contentSessionId });
      res.json({ skipped: true, reason: 'internal_protocol' });
      return;
    }

    let prompt = rawPrompt || '[media prompt]';

    const promptByteLength = Buffer.byteLength(prompt, 'utf8');
    if (promptByteLength > MAX_USER_PROMPT_BYTES) {
      logger.warn('HTTP', 'SessionRoutes: oversized prompt truncated at session-init boundary', {
        project,
        contentSessionId,
        promptByteLength,
        maxBytes: MAX_USER_PROMPT_BYTES,
        preview: prompt.slice(0, 200)
      });
      const buf = Buffer.from(prompt, 'utf8');
      let end = MAX_USER_PROMPT_BYTES;
      while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
      prompt = buf.subarray(0, end).toString('utf8');
    }

    logger.info('HTTP', 'SessionRoutes: handleSessionInitByClaudeId called', {
      contentSessionId,
      project,
      platformSource,
      prompt_length: prompt?.length,
      customTitle
    });

    const store = this.dbManager.getSessionStore();

    const sessionDbId = store.createSDKSession(contentSessionId, project, prompt, customTitle, platformSource);

    // Session lifecycle: init always re-activates the session and cancels any stale completion request.
    store.markSessionActive(sessionDbId);
    const clearedComplete = this.sessionManager.getPendingMessageStore().clearPendingComplete(sessionDbId);
    if (clearedComplete > 0) {
      logger.info('SESSION', 'Cleared stale completion control message(s) on init', {
        sessionId: sessionDbId,
        cleared: clearedComplete
      });
    }

    // Verify session creation with DB lookup
    const dbSession = store.getSessionById(sessionDbId);
    const isNewSession = !dbSession?.memory_session_id;
    logger.info('SESSION', `CREATED | contentSessionId=${contentSessionId} → sessionDbId=${sessionDbId} | isNew=${isNewSession} | project=${project}`, {
      sessionId: sessionDbId
    });

    const currentCount = store.getPromptNumberFromUserPrompts(contentSessionId);
    const promptNumber = currentCount + 1;

    const memorySessionId = dbSession?.memory_session_id || null;
    if (promptNumber > 1) {
      logger.debug('HTTP', `[ALIGNMENT] DB Lookup Proof | contentSessionId=${contentSessionId} → memorySessionId=${memorySessionId || '(not yet captured)'} | prompt#=${promptNumber}`);
    } else {
      logger.debug('HTTP', `[ALIGNMENT] New Session | contentSessionId=${contentSessionId} | prompt#=${promptNumber} | memorySessionId will be captured on first SDK response`);
    }

    const cleanedPrompt = stripMemoryTagsFromPrompt(prompt);

    if (!cleanedPrompt || cleanedPrompt.trim() === '') {
      logger.debug('HOOK', 'Session init - prompt entirely private', {
        sessionId: sessionDbId,
        promptNumber,
        originalLength: prompt.length
      });

      res.json({
        sessionDbId,
        promptNumber,
        skipped: true,
        reason: 'private'
      });
      return;
    }

    store.saveUserPrompt(contentSessionId, promptNumber, cleanedPrompt);

    const contextInjected = this.sessionManager.getSession(sessionDbId) !== undefined;

    logger.debug('SESSION', 'User prompt saved', {
      sessionId: sessionDbId,
      promptNumber,
      contextInjected
    });

    if (platformSource !== 'cursor') {
      const sdkPrompt = cleanedPrompt.startsWith('/') ? cleanedPrompt.substring(1) : cleanedPrompt;
      const session = this.sessionManager.initializeSession(sessionDbId, sdkPrompt, promptNumber);

      const latestPrompt = store.getLatestUserPrompt(session.contentSessionId);

      if (latestPrompt) {
        this.eventBroadcaster.broadcastNewPrompt({
          id: latestPrompt.id,
          content_session_id: latestPrompt.content_session_id,
          project: latestPrompt.project,
          platform_source: latestPrompt.platform_source,
          prompt_number: latestPrompt.prompt_number,
          prompt_text: latestPrompt.prompt_text,
          created_at_epoch: latestPrompt.created_at_epoch
        });

        const chromaStart = Date.now();
        const promptText = latestPrompt.prompt_text;
        this.dbManager.getChromaSync()?.syncUserPrompt(
          latestPrompt.id,
          latestPrompt.memory_session_id,
          latestPrompt.project,
          promptText,
          latestPrompt.prompt_number,
          latestPrompt.created_at_epoch
        ).then(() => {
          const chromaDuration = Date.now() - chromaStart;
          const truncatedPrompt = promptText.length > 60
            ? promptText.substring(0, 60) + '...'
            : promptText;
          logger.debug('CHROMA', 'User prompt synced', {
            promptId: latestPrompt.id,
            duration: `${chromaDuration}ms`,
            prompt: truncatedPrompt
          });
        }).catch((error) => {
          logger.error('CHROMA', 'User prompt sync failed, continuing without vector search', {
            promptId: latestPrompt.id,
            prompt: promptText.length > 60 ? promptText.substring(0, 60) + '...' : promptText
          }, error);
        });
      }

      this.ensureGeneratorRunning(sessionDbId, 'init');

      this.eventBroadcaster.broadcastSessionStarted(sessionDbId, session.project);
    } else {
      logger.debug('HTTP', 'session-init: Skipping SDK agent init for Cursor platform', { sessionDbId, promptNumber });
    }

    res.json({
      sessionDbId,
      promptNumber,
      skipped: false,
      contextInjected,
      status: 'initialized'
    });
  });

  private static readonly SIMPLE_TOOLS = new Set([
    'Read', 'Glob', 'Grep', 'LS', 'ListMcpResourcesTool'
  ]);

  private applyTierRouting(session: NonNullable<ReturnType<typeof this.sessionManager.getSession>>): void {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (settings.CLAUDE_MEM_TIER_ROUTING_ENABLED === 'false') {
      session.modelOverride = undefined;
      return;
    }

    session.modelOverride = undefined;

    const pendingStore = this.sessionManager.getPendingMessageStore();
    const pending = pendingStore.peekPendingTypes(session.sessionDbId);

    if (pending.length === 0) {
      session.modelOverride = undefined;
      return;
    }

    const hasSummarize = pending.some(m => m.message_type === 'summarize');
    const allSimple = pending.every(m =>
      m.message_type === 'observation' && m.tool_name && SessionRoutes.SIMPLE_TOOLS.has(m.tool_name)
    );

    if (hasSummarize) {
      const summaryModel = settings.CLAUDE_MEM_TIER_SUMMARY_MODEL;
      if (summaryModel) {
        session.modelOverride = summaryModel;
        logger.debug('SESSION', `Tier routing: summary model`, {
          sessionId: session.sessionDbId, model: summaryModel
        });
      }
    } else if (allSimple) {
      const simpleModel = settings.CLAUDE_MEM_TIER_SIMPLE_MODEL;
      if (simpleModel) {
        session.modelOverride = simpleModel;
        logger.debug('SESSION', `Tier routing: simple model`, {
          sessionId: session.sessionDbId, model: simpleModel
        });
      }
    } else {
      session.modelOverride = undefined;
    }
  }
}

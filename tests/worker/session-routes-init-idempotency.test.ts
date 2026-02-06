import { describe, it, expect, mock } from 'bun:test';
import express from 'express';

import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';

function createMinimalWorkerService() {
  return {
    broadcastProcessingStatus: () => {},
  } as any;
}

function createMinimalEventBroadcaster() {
  return {
    broadcastNewPrompt: () => {},
    broadcastSessionStarted: () => {},
    broadcastObservationQueued: () => {},
    broadcastSummarizeQueued: () => {},
  } as any;
}

describe('SessionRoutes init idempotency', () => {
  it('does not start generator when /sessions/:id/init is called while running', async () => {
    const session = {
      sessionDbId: 1,
      contentSessionId: 'cid-1',
      memorySessionId: null,
      project: 'p',
      userPrompt: 'u',
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: Promise.resolve(),
      lastPromptNumber: 1,
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      earliestPendingTimestamp: null,
      conversationHistory: [],
      currentProvider: 'custom'
    } as any;

    const sessionManager = {
      initializeSession: mock(() => session),
      getSession: mock(() => session),
      queueObservation: mock(() => {}),
      queueSummarize: mock(() => {}),
      getPendingMessageStore: mock(() => ({
        markSessionMessagesFailed: () => 0,
        getPendingCount: () => 0,
      })),
      deleteSession: mock(async () => {})
    } as any;

    const sessionStore = {
      getLatestUserPrompt: mock(() => null),
    } as any;

    const dbManager = {
      getSessionStore: () => sessionStore,
      getSessionById: () => ({ project: 'p' }),
      getChromaSync: () => ({ syncUserPrompt: async () => {} }),
    } as any;

    const startSessionSpy = mock(async () => {});

    const sdkAgent = { startSession: startSessionSpy } as any;
    const geminiAgent = { startSession: startSessionSpy } as any;
    const openRouterAgent = { startSession: startSessionSpy } as any;
    const customAgent = { startSession: startSessionSpy } as any;

    const routes = new SessionRoutes(
      sessionManager,
      dbManager,
      sdkAgent,
      geminiAgent,
      openRouterAgent,
      customAgent,
      createMinimalEventBroadcaster(),
      createMinimalWorkerService()
    );

    const app = express();
    app.use(express.json());
    routes.setupRoutes(app);

    // Same session init twice while generator is already running.
    const body = {
      userPrompt: 'hello',
      promptNumber: 2,
    };

    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind test server');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const r1 = await fetch(`${base}/sessions/1/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(r1.status).toBe(200);

      const r2 = await fetch(`${base}/sessions/1/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(r2.status).toBe(200);

      // Generator is already running, duplicate init must not restart it.
      expect(startSessionSpy.mock.calls.length).toBe(0);
      expect(sessionManager.initializeSession.mock.calls.length).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });
});

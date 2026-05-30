import { describe, it, expect, mock } from 'bun:test';

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

// ensureGeneratorRunning is the single guard that owns generator-restart
// idempotency (upstream v13.4.0 moved lifecycle here): when a session already
// has a live generatorPromise, a second call must NOT spin up another generator.
// Exercising the guard directly is more faithful than the old path-based
// /sessions/:id/init HTTP route, which no longer exists.
function buildRoutes() {
  // One spy shared across every provider so the assertion holds regardless of
  // which provider the ambient env selects in getSelectedProvider().
  const startSessionSpy = mock(() => new Promise<void>(() => {})); // stays pending: .finally never fires mid-test

  let session: any;
  const sessionManager = {
    getSession: mock(() => session),
    getMessageBuffer: () => ({
      peekTypes: () => [],
      getPendingCount: () => 0,
    }),
  } as any;

  const dbManager = {
    getSessionStore: () => ({}),
    getSessionById: () => ({ project: 'p' }),
  } as any;

  const agent = { startSession: startSessionSpy } as any;
  const completionHandler = { finalizeSession: mock(async () => {}) } as any;

  const routes = new SessionRoutes(
    sessionManager,
    dbManager,
    agent, // sdk
    agent, // gemini
    agent, // openrouter
    agent, // custom
    createMinimalEventBroadcaster(),
    createMinimalWorkerService(),
    completionHandler
  );

  const makeSession = (overrides: Record<string, unknown> = {}) => ({
    sessionDbId: 1,
    contentSessionId: 'cid-1',
    memorySessionId: null,
    project: 'p',
    userPrompt: 'u',
    lastPromptNumber: 1,
    startTime: Date.now(),
    conversationHistory: [],
    abortController: new AbortController(),
    generatorPromise: null,
    currentProvider: undefined,
    ...overrides,
  });

  return { routes, startSessionSpy, setSession: (s: any) => { session = s; }, makeSession };
}

describe('SessionRoutes generator idempotency', () => {
  it('does not start a second generator when one is already running', async () => {
    const { routes, startSessionSpy, setSession, makeSession } = buildRoutes();
    // generatorPromise already live → guard must short-circuit.
    setSession(makeSession({ generatorPromise: Promise.resolve(), currentProvider: 'custom' }));

    await routes.ensureGeneratorRunning(1, 'init');
    await routes.ensureGeneratorRunning(1, 'init');

    expect(startSessionSpy.mock.calls.length).toBe(0);
  });

  it('starts exactly one generator when the session is idle', async () => {
    const { routes, startSessionSpy, setSession, makeSession } = buildRoutes();
    const session = makeSession({ generatorPromise: null });
    setSession(session);

    await routes.ensureGeneratorRunning(1, 'init');

    expect(startSessionSpy.mock.calls.length).toBe(1);
    expect(session.generatorPromise).not.toBeNull();

    // Second call now sees a live generatorPromise → no restart.
    await routes.ensureGeneratorRunning(1, 'init');
    expect(startSessionSpy.mock.calls.length).toBe(1);
  });
});

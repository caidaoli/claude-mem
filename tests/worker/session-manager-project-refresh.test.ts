import { beforeEach, afterEach, describe, expect, it } from 'bun:test';

import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';

describe('SessionManager project refresh', () => {
  let store: SessionStore;
  let sessionManager: SessionManager;

  const contentSessionId = 'project-refresh-content-session';
  const refreshedProject = 'createDb';

  function seedStaleSessionWithBackfilledProject(): number {
    // stop-hook path can create session with empty project first
    const sessionDbId = store.createSDKSession(contentSessionId, '', '');
    sessionManager.initializeSession(sessionDbId);
    expect(sessionManager.getSession(sessionDbId)?.project).toBe('');

    // later session-init backfills project in DB for same contentSessionId
    store.createSDKSession(contentSessionId, refreshedProject, 'user prompt');
    expect(store.getSessionById(sessionDbId)?.project).toBe(refreshedProject);

    return sessionDbId;
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');

    const dbManager = {
      getSessionStore: () => store,
      getSessionById: (sessionDbId: number) => {
        const session = store.getSessionById(sessionDbId);
        if (!session) throw new Error(`Session ${sessionDbId} not found`);
        return session;
      }
    } as any;

    sessionManager = new SessionManager(dbManager);
  });

  afterEach(() => {
    store.close();
  });

  it('refreshes stale empty project before queueing observation', () => {
    const sessionDbId = seedStaleSessionWithBackfilledProject();

    sessionManager.queueObservation(sessionDbId, {
      tool_name: 'Edit',
      tool_input: '{"file":"main.go"}',
      tool_response: '{"ok":true}',
      prompt_number: 1,
      cwd: '/tmp/createDb'
    });

    expect(sessionManager.getSession(sessionDbId)?.project).toBe(refreshedProject);
  });

  it('refreshes stale empty project before queueing summarize', () => {
    const sessionDbId = seedStaleSessionWithBackfilledProject();

    sessionManager.queueSummarize(sessionDbId, 'summary');
    expect(sessionManager.getSession(sessionDbId)?.project).toBe(refreshedProject);
  });
});

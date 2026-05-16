import { describe, expect, it, mock } from 'bun:test';
import { startPendingSessionGenerators } from '../../../src/services/worker/pending-session-recovery.js';

describe('startPendingSessionGenerators', () => {
  it('initializes pending sessions left by a previous worker and starts their generators', async () => {
    const initializeSession = mock((sessionDbId: number) => ({
      sessionDbId,
      generatorPromise: null,
    }));
    const ensureGeneratorRunning = mock(async () => {});
    const sessionManager = {
      getPendingMessageStore: () => ({
        getSessionsWithPendingMessages: async () => [237],
      }),
      getSession: () => undefined,
      initializeSession,
    };

    const started = await startPendingSessionGenerators(
      sessionManager as any,
      ensureGeneratorRunning,
      'startup-pending-recovery',
    );

    expect(started).toBe(1);
    expect(initializeSession).toHaveBeenCalledWith(237);
    expect(ensureGeneratorRunning).toHaveBeenCalledWith(237, 'startup-pending-recovery');
  });

  it('does not start a second generator for a session already running', async () => {
    const ensureGeneratorRunning = mock(async () => {});
    const running = Promise.resolve();
    const sessionManager = {
      getPendingMessageStore: () => ({
        getSessionsWithPendingMessages: async () => [237],
      }),
      getSession: () => ({
        sessionDbId: 237,
        generatorPromise: running,
      }),
      initializeSession: mock(() => {
        throw new Error('should not initialize a running session');
      }),
    };

    const started = await startPendingSessionGenerators(
      sessionManager as any,
      ensureGeneratorRunning,
      'startup-pending-recovery',
    );

    expect(started).toBe(0);
    expect(ensureGeneratorRunning).not.toHaveBeenCalled();
  });
});

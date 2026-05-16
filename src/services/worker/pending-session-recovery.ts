import type { SessionManager } from './SessionManager.js';

export type EnsureGeneratorRunning = (sessionDbId: number, source: string) => void | Promise<void>;

export async function startPendingSessionGenerators(
  sessionManager: SessionManager,
  ensureGeneratorRunning: EnsureGeneratorRunning,
  source: string,
): Promise<number> {
  const pendingSessionIds = await sessionManager.getPendingMessageStore().getSessionsWithPendingMessages();
  let sessionsStarted = 0;

  for (const sessionDbId of pendingSessionIds) {
    const session = sessionManager.getSession(sessionDbId)
      ?? sessionManager.initializeSession(sessionDbId);

    if (session.generatorPromise) {
      continue;
    }

    await ensureGeneratorRunning(sessionDbId, source);
    sessionsStarted++;
  }

  return sessionsStarted;
}

/** Live observer inputs are disposable, not a durable job queue. */
export const LIVE_OBSERVER_CAPTURE_MAX_AGE_MS = 5 * 60_000;
export const LIVE_OBSERVER_BUFFER_MAX_AGE_MS = 30 * 60_000;
export const LIVE_OBSERVER_MAX_SESSION_MESSAGES = 512;
export const LIVE_OBSERVER_MAX_TOTAL_MESSAGES = 4_096;

export function isLiveObserverEvent(kind: string): kind is 'observation' | 'file_edit' | 'summarize' {
  return kind === 'observation' || kind === 'file_edit' || kind === 'summarize';
}

export function isExpiredObserverEvent(capturedAt: number, now = Date.now()): boolean {
  return !Number.isFinite(capturedAt) || now - capturedAt >= LIVE_OBSERVER_CAPTURE_MAX_AGE_MS;
}

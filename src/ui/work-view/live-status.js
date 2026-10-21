import { t } from './i18n.js';

// Connection freshness is measured on the browser's monotonic clock. Server
// wall time is displayed as evidence, never used as an agent-presence signal.
export const LOCAL_FEED_STALE_AFTER_MS = 35_000; // Two 15-second heartbeats + margin.

function age(now, at) {
  if (!Number.isFinite(now) || !Number.isFinite(at) || now < 0 || at < 0 || at > now + 1000) return null;
  return Math.max(0, now - at);
}

function checkTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * now, lastEventAt and lastSuccessfulCheckReceivedAt use performance.now().
 * Update lastEventAt only for a valid work-view/heartbeat SSE message.
 * Save lastSuccessfulCheckAt (source.lastCheckedAt) and its receipt time only
 * when that payload's source.connected === true: lastCheckedAt also advances
 * on failed backend reads. HTTP snapshots may seed the successful check, but
 * cannot establish that the event feed is live.
 */
export function getConnectionStatus({
  transportConnected = false,
  reconnecting = false,
  now,
  lastEventAt = null,
  sourceConnected = null,
  lastSuccessfulCheckAt = null,
  lastSuccessfulCheckReceivedAt = null,
  wallNow = null,
  staleAfterMs = LOCAL_FEED_STALE_AFTER_MS,
} = {}) {
  const threshold = Number.isFinite(staleAfterMs) && staleAfterMs > 0 ? staleAfterMs : LOCAL_FEED_STALE_AFTER_MS;
  const eventAgeMs = age(now, lastEventAt);
  const sourceAgeMs = age(now, lastSuccessfulCheckReceivedAt);
  const successfulCheckAt = checkTime(lastSuccessfulCheckAt);
  const clockSkew = successfulCheckAt !== null && Number.isFinite(wallNow) && sourceAgeMs !== null
    && Math.abs(wallNow - Date.parse(successfulCheckAt) - sourceAgeMs) > 60_000;
  let state = 'connecting';
  let label = t('feedConnecting');
  let detail = t('feedConnectingDetail');
  let tone = 'neutral';

  if (!transportConnected) {
    if (reconnecting && eventAgeMs !== null && eventAgeMs > threshold) {
      state = 'stale'; label = t('feedStale'); tone = 'warning';
      detail = t('feedStaleReconnecting');
    } else if (reconnecting) {
      state = 'reconnecting'; label = t('feedReconnecting'); tone = 'warning';
      detail = t('feedReconnectingDetail');
    }
  } else if (eventAgeMs === null || eventAgeMs > threshold) {
    if (lastEventAt !== null) {
      state = 'stale'; label = t('feedStale'); tone = 'warning';
      detail = t('feedStaleDetail');
    }
  } else if (sourceConnected === false) {
    state = 'unavailable'; label = t('feedUnavailable'); tone = 'warning';
    detail = t('feedUnavailableDetail');
  } else if (sourceConnected === true && successfulCheckAt !== null && sourceAgeMs !== null) {
    if (sourceAgeMs > threshold) {
      state = 'stale'; label = t('feedStale'); tone = 'warning';
      detail = t('feedSourceStaleDetail');
    } else {
      state = 'live'; label = t('feedLive'); tone = 'positive';
      detail = t('feedLiveDetail');
    }
  }

  const tooltip = t('lastCheck', { at: successfulCheckAt ?? t('notConfirmed') })
    + (clockSkew ? t('clockSkew') : '')
    + t('notAgentSignal');
  return { state, label, detail, tone, isLive: state === 'live', eventAgeMs, sourceAgeMs,
    lastSuccessfulCheckAt: successfulCheckAt, clockSkew, staleAfterMs: threshold, tooltip };
}

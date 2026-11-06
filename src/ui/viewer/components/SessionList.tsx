import React, { useEffect, useRef } from 'react';
import { SessionCatalogEntry } from '../types';
import { SessionCard } from './SessionCard';
import { catalogEntryRef, sessionKey, type SessionRef } from '../utils/sessions';
import { UI } from '../constants/ui';
import { useI18n } from '../i18n';

interface SessionListProps {
  header: React.ReactNode;
  sessions: SessionCatalogEntry[];
  isLoading: boolean;
  hasMore: boolean;
  loadError: string | null;
  onOpen: (session: SessionRef) => void;
  onDelete: (session: SessionRef) => Promise<void>;
  /** Loads the next (older) page of sessions; the list asks when its end scrolls into view. */
  onLoadMore: () => void;
  onRefreshLatest?: () => void;
}

export function SessionList({ header, sessions, isLoading, hasMore, loadError, onOpen, onDelete, onLoadMore, onRefreshLatest }: SessionListProps) {
  const { t } = useI18n();
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && entries[0].target.isConnected && hasMore && !isLoading && !loadError) {
          onLoadMoreRef.current?.();
        }
      },
      { threshold: UI.LOAD_MORE_THRESHOLD }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, isLoading, loadError]);

  return (
    <main className="session-list" aria-label={t.sessions.listLabel}>
      <div className="session-list-content">
        {header}
        {loadError && <div className="card-delete-error" role="alert">
          {t.sessions.loadFailed.replace('{error}', () => loadError)}
          {!isLoading && <button onClick={onLoadMore}>{t.sessions.retry}</button>}
          {!isLoading && onRefreshLatest && <button onClick={onRefreshLatest}>{t.sessions.refreshLatest}</button>}
        </div>}
        {sessions.map(session => {
          const ref = catalogEntryRef(session);
          return (
            <SessionCard
              key={sessionKey(ref)}
              session={session}
              onOpen={() => onOpen(ref)}
              onDelete={() => onDelete(ref)}
            />
          );
        })}
        {sessions.length === 0 && !loadError && (
          <div className="session-list-empty">
            {isLoading ? t.sessions.loading : <><h3>{t.sessions.emptyTitle}</h3><p>{t.sessions.emptyHint}</p></>}
          </div>
        )}
        {isLoading && sessions.length > 0 && (
          <div className="session-list-empty">{t.sessions.loadingOlder}</div>
        )}
        {hasMore && !isLoading && !loadError && sessions.length > 0 && (
          <div ref={loadMoreRef} style={{ height: '20px', margin: '10px 0' }} />
        )}
      </div>
    </main>
  );
}

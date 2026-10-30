import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MediaOwnerDetailsResponse, ObservationMedia, ObservationMediaRef } from '../types';
import { useMediaStates } from '../hooks/useMediaStates';
import { useI18n } from '../i18n';
import { formatDate } from '../utils/formatters';
import {
  MAX_CARD_THUMBNAILS,
  canRetryMediaState,
  formatMediaBytes,
  galleryKeyAction,
  inspectionText,
  mediaAltText,
  mediaOwnerDetailsUrl,
  mediaStatusText,
  mediaVariantFailed,
  mediaVariantStatusText,
  mediaVariantUrl,
  nextFocusIndex,
  sourceAvailabilityText,
  type MediaDisplayState,
  type MediaVariantName,
} from '../utils/media';

const LOADING: MediaDisplayState = { kind: 'loading' };

interface StripViewProps {
  observationId: number;
  media: ObservationMedia;
  states: Record<string, MediaDisplayState>;
  onOpen: (index: number, opener: HTMLElement) => void;
  onRetry: (id: string) => void;
  onImageError: (id: string, variant: MediaVariantName) => void;
}

/**
 * Bounded thumbnail strip: at most MAX_CARD_THUMBNAILS tiles, the last one
 * carrying a "+N" count when more images exist. Every tile opens the gallery.
 */
export function ObservationMediaStripView({ observationId, media, states, onOpen, onRetry, onImageError }: StripViewProps) {
  const { t } = useI18n();
  const refs = media.attachments;
  const visible = refs.slice(0, MAX_CARD_THUMBNAILS);
  const hiddenCount = refs.length - visible.length;
  return (
    <div className="media-strip" role="group" aria-label={(refs.length === 1 ? t.media.attachedOne : t.media.attachedMany).replace('{count}', String(refs.length))}>
      {visible.map((ref, index) => {
        const state = states[ref.id] ?? LOADING;
        const isLastWithMore = index === visible.length - 1 && hiddenCount > 0;
        const alt = mediaAltText(ref, index, refs.length, observationId, t.media);
        return (
          <div key={ref.id} className={`media-thumb media-thumb--${state.kind}`}>
            <button
              type="button"
              className="media-thumb-button"
              aria-label={t.media.openImage.replace('{alt}', () => alt) + (isLastWithMore ? t.media.andMore.replace('{count}', String(hiddenCount)) : '')}
              onClick={event => onOpen(index, event.currentTarget)}
            >
              {state.kind === 'ready' && !mediaVariantFailed(state, 'llm') ? (
                <img
                  src={mediaVariantUrl(ref.id, 'llm')}
                  alt={alt}
                  loading="lazy"
                  decoding="async"
                  width={state.metadata.llm?.width}
                  height={state.metadata.llm?.height}
                  onError={() => onImageError(ref.id, 'llm')}
                />
              ) : (
                <span className="media-thumb-status">{mediaVariantStatusText(state, 'llm', t.media)}</span>
              )}
              {ref.inspection === 'uninspected' && <span className="media-thumb-badge">{t.media.notInspected}</span>}
              {isLastWithMore && <span className="media-thumb-more">+{hiddenCount}</span>}
            </button>
            {canRetryMediaState(state) && (
              <button type="button" className="media-thumb-retry" onClick={() => onRetry(ref.id)}>{t.feed.retry}</button>
            )}
          </div>
        );
      })}
      <span className="media-strip-count">
        {(refs.length === 1 ? t.media.countOne : t.media.countMany).replace('{count}', String(refs.length))}
        {media.overflow ? t.media.overflow : ''}
      </span>
    </div>
  );
}

interface DialogViewProps {
  observationId: number;
  refs: ObservationMediaRef[];
  index: number;
  state: MediaDisplayState;
  ownerDetails: MediaOwnerDetailsResponse | 'loading' | 'error' | null;
  onClose: () => void;
  onShow: (index: number) => void;
  onRetry: (id: string) => void;
  onImageError: (id: string, variant: MediaVariantName) => void;
  onRequestOwnerDetails: () => void;
}

/** The dialog body, without portal or document effects (renderable on the server for tests). */
export function MediaLightboxDialog({ observationId, refs, index, state, ownerDetails, onClose, onShow, onRetry, onImageError, onRequestOwnerDetails }: DialogViewProps) {
  const { t } = useI18n();
  const ref = refs[index];
  const alt = mediaAltText(ref, index, refs.length, observationId, t.media);
  const metadata = state.kind === 'ready' ? state.metadata : null;
  const titleId = `media-lightbox-title-${observationId}`;
  return (
    <div className="media-lightbox" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <div className="media-lightbox-header">
        <h2 id={titleId} className="media-lightbox-title">
          {t.media.imagePosition.replace('{index}', String(index + 1)).replace('{count}', String(refs.length))} <span className="media-lightbox-label">{ref.label}</span>
        </h2>
        <button type="button" className="modal-close-btn media-lightbox-close" aria-label={t.media.closeViewer} onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <div className="media-lightbox-stage">
        <button type="button" className="media-lightbox-nav" aria-label={t.media.previousImage} disabled={index === 0} onClick={() => onShow(index - 1)}>‹</button>
        <div className="media-lightbox-frame" aria-live="polite">
          {metadata && !mediaVariantFailed(state, 'viewer') ? (
            <img
              src={mediaVariantUrl(ref.id, 'viewer')}
              alt={alt}
              width={metadata.viewer?.width}
              height={metadata.viewer?.height}
              onError={() => onImageError(ref.id, 'viewer')}
            />
          ) : (
            <div className={`media-lightbox-status media-thumb--${state.kind}`}>
              <span>{mediaVariantStatusText(state, 'viewer', t.media)}</span>
              {canRetryMediaState(state) && <button type="button" className="media-thumb-retry" onClick={() => onRetry(ref.id)}>{t.feed.retry}</button>}
            </div>
          )}
        </div>
        <button type="button" className="media-lightbox-nav" aria-label={t.media.nextImage} disabled={index === refs.length - 1} onClick={() => onShow(index + 1)}>›</button>
      </div>
      <dl className="media-lightbox-provenance">
        <dt>{t.media.inspection}</dt><dd>{inspectionText(ref, t.media)}</dd>
        <dt>{t.media.status}</dt><dd>{mediaStatusText(state, t.media)}</dd>
        {metadata && (
          <>
            <dt>{t.media.recipe}</dt><dd>{metadata.recipe}</dd>
            {metadata.viewer && (
              <>
                <dt>{t.media.dimensions}</dt><dd>{metadata.viewer.width} × {metadata.viewer.height}</dd>
                <dt>{t.media.size}</dt><dd>{formatMediaBytes(metadata.viewer.byteLength)} (WebP)</dd>
              </>
            )}
            <dt>{t.media.captured}</dt><dd>{formatDate(metadata.capturedAt)}</dd>
          </>
        )}
      </dl>
      {metadata && (
        <div className="media-lightbox-owner">
          {ownerDetails === null && (
            <button type="button" className="view-mode-toggle" onClick={onRequestOwnerDetails}>{t.media.showSourceDetails}</button>
          )}
          {ownerDetails === 'loading' && <span>{t.media.loadingSourceDetails}</span>}
          {ownerDetails === 'error' && <span>{t.media.sourceDetailsUnavailable}</span>}
          {ownerDetails && typeof ownerDetails === 'object' && (
            <dl className="media-lightbox-provenance">
              <dt>{t.media.source}</dt><dd>{sourceAvailabilityText(ownerDetails, t.media)}</dd>
              {ownerDetails.platform !== null && (
                <>
                  <dt>{t.media.platform}</dt><dd>{ownerDetails.platform}</dd>
                  <dt>{t.media.sourceShape}</dt><dd>{ownerDetails.sourceShape}</dd>
                  <dt>{t.media.sourceFile}</dt><dd className="media-lightbox-path">{ownerDetails.sourceLocatorPath ?? t.media.inlineImage}</dd>
                </>
              )}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

interface LightboxProps {
  observationId: number;
  refs: ObservationMediaRef[];
  initialIndex: number;
  states: Record<string, MediaDisplayState>;
  opener: HTMLElement | null;
  onClose: () => void;
  onRetry: (id: string) => void;
  onImageError: (id: string, variant: MediaVariantName) => void;
}

/** Modal gallery: focus moves in on open, is trapped while open, and returns to the opener. */
function MediaLightbox({ observationId, refs, initialIndex, states, opener, onClose, onRetry, onImageError }: LightboxProps) {
  const [index, setIndex] = useState(initialIndex);
  const [ownerDetails, setOwnerDetails] = useState<Record<string, MediaOwnerDetailsResponse | 'loading' | 'error'>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const ref = refs[index];

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    containerRef.current?.querySelector<HTMLElement>('.media-lightbox-close')?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, [opener]);

  // A control that just disappeared or became disabled (a nav button at the
  // end, the source-details button once loaded, a status that turned into an
  // image) drops focus to <body>. After every render, pull it back inside.
  useEffect(() => {
    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) container.querySelector<HTMLElement>('.media-lightbox')?.focus();
  });

  // Listen on the document so Escape and the arrows work wherever focus is.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const focusable = Array.from(containerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
        const next = nextFocusIndex(focusable.indexOf(document.activeElement as HTMLElement), focusable.length, event.shiftKey);
        if (next >= 0) {
          event.preventDefault();
          focusable[next].focus();
        }
        return;
      }
      const action = galleryKeyAction(event.key, index, refs.length);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action.type === 'close') onClose();
      else setIndex(action.index);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [index, refs.length, onClose]);

  const requestOwnerDetails = useCallback(async () => {
    const id = ref.id;
    setOwnerDetails(previous => ({ ...previous, [id]: 'loading' }));
    try {
      const response = await fetch(mediaOwnerDetailsUrl(id), { credentials: 'same-origin' });
      const body = response.ok ? await response.json() as MediaOwnerDetailsResponse : null;
      setOwnerDetails(previous => ({ ...previous, [id]: body ?? 'error' }));
    } catch {
      setOwnerDetails(previous => ({ ...previous, [id]: 'error' }));
    }
  }, [ref.id]);

  return createPortal(
    <div
      className="modal-backdrop media-lightbox-backdrop"
      ref={containerRef}
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <MediaLightboxDialog
        observationId={observationId}
        refs={refs}
        index={index}
        state={states[ref.id] ?? LOADING}
        ownerDetails={ownerDetails[ref.id] ?? null}
        onClose={onClose}
        onShow={setIndex}
        onRetry={onRetry}
        onImageError={onImageError}
        onRequestOwnerDetails={() => { void requestOwnerDetails(); }}
      />
    </div>,
    document.body,
  );
}

/** Card section for an observation with media refs; image-free rows never render it. */
export function ObservationMediaSection({ observationId, media }: { observationId: number; media: ObservationMedia }) {
  const ids = media.attachments.map(ref => ref.id);
  const { states, retry, markImageError } = useMediaStates(ids);
  const [open, setOpen] = useState<{ index: number; opener: HTMLElement } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  return (
    <>
      <ObservationMediaStripView
        observationId={observationId}
        media={media}
        states={states}
        onOpen={(index, opener) => setOpen({ index, opener })}
        onRetry={retry}
        onImageError={markImageError}
      />
      {open && (
        <MediaLightbox
          observationId={observationId}
          refs={media.attachments}
          initialIndex={open.index}
          states={states}
          opener={open.opener}
          onClose={close}
          onRetry={retry}
          onImageError={markImageError}
        />
      )}
    </>
  );
}

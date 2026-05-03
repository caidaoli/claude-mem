import { EventEmitter } from 'events';
import { PendingMessageStore, PersistentPendingMessage } from '../sqlite/PendingMessageStore.js';
import type { PendingMessageWithId } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
// Stop hook fires summarize + complete in parallel; give summarize time to enqueue.
const COMPLETE_GRACE_MS = 2_000;
// Avoid tight loops if complete is claimed while other work is still "processing"
// (e.g. crashed worker within stale self-heal window).
const COMPLETE_DEFER_BACKOFF_MS = 500;

export interface CreateIteratorOptions {
  sessionDbId: number;
  signal: AbortSignal;
  onIdleTimeout?: () => void;
  /** Called when a session-complete control message is processed */
  onComplete?: () => void;
}

export class SessionQueueProcessor {
  constructor(
    private store: PendingMessageStore,
    private events: EventEmitter
  ) {}

  async *createIterator(options: CreateIteratorOptions): AsyncIterableIterator<PendingMessageWithId> {
    const { sessionDbId, signal, onIdleTimeout, onComplete } = options;
    let lastActivityTime = Date.now();

    while (!signal.aborted) {
      let persistentMessage: PersistentPendingMessage | null = null;
      try {
        persistentMessage = this.store.claimNextMessage(sessionDbId);
      } catch (error) {
        if (signal.aborted) return;
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        logger.error('QUEUE', 'Failed to claim next message; ending iterator', { sessionDbId }, normalizedError);
        return;
      }

      if (persistentMessage) {
        // Control message: session-complete
        if (persistentMessage.message_type === 'complete') {
          // Avoid race where /api/sessions/complete arrives before /api/sessions/summarize.
          // resetToPending does not update created_at_epoch, so after a reset→re-claim
          // cycle the grace period will have already elapsed. One grace window is enough.
          const ageMs = Date.now() - persistentMessage.created_at_epoch;
          const remainingGraceMs = Math.max(0, COMPLETE_GRACE_MS - ageMs);
          if (remainingGraceMs > 0) {
            await this.waitForMessage(signal, remainingGraceMs);
          }

          if (signal.aborted) {
            this.store.resetToPending(persistentMessage.id);
            return;
          }

          // getWorkCount excludes complete messages; 0 means safe to finalize.
          const workCount = this.store.getWorkCount(sessionDbId);
          if (workCount > 0) {
            this.store.resetToPending(persistentMessage.id);
            await this.waitForMessage(signal, COMPLETE_DEFER_BACKOFF_MS);
            continue;
          }

          const confirmed = this.store.confirmProcessed(persistentMessage.id);
          if (!confirmed) {
            // /api/sessions/init can cancel completion by clearing the control message.
            logger.info('SESSION', 'Completion control message was cleared before confirm; continuing', {
              sessionDbId,
              messageId: persistentMessage.id
            });
            continue;
          }

          onComplete?.();
          logger.info('SESSION', 'Completion message processed, exiting iterator', { sessionDbId });
          return;
        }

        // Reset activity time when we successfully yield a message
        lastActivityTime = Date.now();
        yield this.toPendingMessageWithId(persistentMessage);
        continue;
      }

      try {
        const idleTimedOut = await this.handleWaitPhase(signal, lastActivityTime, sessionDbId, onIdleTimeout);
        if (idleTimedOut) return;
        lastActivityTime = Date.now();
      } catch (error) {
        if (signal.aborted) return;
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        logger.error('QUEUE', 'Error waiting for message; ending iterator', { sessionDbId }, normalizedError);
        return;
      }
    }
  }

  private toPendingMessageWithId(msg: PersistentPendingMessage): PendingMessageWithId {
    const pending = this.store.toPendingMessage(msg);
    return {
      ...pending,
      _persistentId: msg.id,
      _originalTimestamp: msg.created_at_epoch
    };
  }

  private async handleWaitPhase(
    signal: AbortSignal,
    lastActivityTime: number,
    sessionDbId: number,
    onIdleTimeout?: () => void
  ): Promise<boolean> {
    const receivedMessage = await this.waitForMessage(signal, IDLE_TIMEOUT_MS);

    if (!receivedMessage && !signal.aborted) {
      const idleDuration = Date.now() - lastActivityTime;
      if (idleDuration >= IDLE_TIMEOUT_MS) {
        logger.info('SESSION', 'Idle timeout reached, triggering abort to kill subprocess', {
          sessionDbId,
          idleDurationMs: idleDuration,
          thresholdMs: IDLE_TIMEOUT_MS
        });
        onIdleTimeout?.();
        return true;
      }
    }
    return false;
  }

  private waitForMessage(signal: AbortSignal, timeoutMs: number = IDLE_TIMEOUT_MS): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const onMessage = () => {
        cleanup();
        resolve(true); 
      };

      const onAbort = () => {
        cleanup();
        resolve(false); 
      };

      const onTimeout = () => {
        cleanup();
        resolve(false); 
      };

      const cleanup = () => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        this.events.off('message', onMessage);
        signal.removeEventListener('abort', onAbort);
      };

      this.events.once('message', onMessage);
      signal.addEventListener('abort', onAbort, { once: true });
      timeoutId = setTimeout(onTimeout, timeoutMs);
    });
  }
}

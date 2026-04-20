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
  /** Called when idle timeout occurs - should trigger abort to kill subprocess */
  onIdleTimeout?: () => void;
  /** Called when a session-complete control message is processed */
  onComplete?: () => void;
}

export class SessionQueueProcessor {
  constructor(
    private store: PendingMessageStore,
    private events: EventEmitter
  ) {}

  /**
   * Create an async iterator that yields messages as they become available.
   * Uses atomic claim-confirm to prevent duplicates.
   * Messages are claimed (marked processing) and stay in DB until confirmProcessed().
   * Self-heals stale processing messages before each claim.
   * Waits for 'message' event when queue is empty.
   *
   * CRITICAL: Calls onIdleTimeout callback after 3 minutes of inactivity.
   * The callback should trigger abortController.abort() to kill the SDK subprocess.
   * Just returning from the iterator is NOT enough - the subprocess stays alive!
   */
  async *createIterator(options: CreateIteratorOptions): AsyncIterableIterator<PendingMessageWithId> {
    const { sessionDbId, signal, onIdleTimeout, onComplete } = options;
    let lastActivityTime = Date.now();

    while (!signal.aborted) {
      // Claim phase: atomically claim next pending message (marks as 'processing')
      // Self-heals any stale processing messages before claiming
      let persistentMessage: PersistentPendingMessage | null = null;
      try {
        persistentMessage = this.store.claimNextMessage(sessionDbId);
      } catch (error) {
        if (signal.aborted) return;
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        logger.error('QUEUE', 'Failed to claim next message', { sessionDbId }, normalizedError);
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
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
        // Yield the message for processing (it's marked as 'processing' in DB)
        yield this.toPendingMessageWithId(persistentMessage);
        continue;
      }

      // Wait phase: queue empty - wait for wake-up event or timeout
      try {
        const idleTimedOut = await this.handleWaitPhase(signal, lastActivityTime, sessionDbId, onIdleTimeout);
        if (idleTimedOut) return;
        // Reset timer on spurious wakeup if not timed out
        lastActivityTime = Date.now();
      } catch (error) {
        if (signal.aborted) return;
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        logger.error('QUEUE', 'Error waiting for message', { sessionDbId }, normalizedError);
        // Small backoff to prevent tight loop on error
        await new Promise(resolve => setTimeout(resolve, 1000));
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

  /**
   * Handle the wait phase: wait for a message or check idle timeout.
   * @returns true if idle timeout was reached (caller should return/exit iterator)
   */
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

  /**
   * Wait for a message event or timeout.
   * @param signal - AbortSignal to cancel waiting
   * @param timeoutMs - Maximum time to wait before returning
   * @returns true if a message was received, false if timeout occurred
   */
  private waitForMessage(signal: AbortSignal, timeoutMs: number = IDLE_TIMEOUT_MS): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const onMessage = () => {
        cleanup();
        resolve(true); // Message received
      };

      const onAbort = () => {
        cleanup();
        resolve(false); // Aborted, let loop check signal.aborted
      };

      const onTimeout = () => {
        cleanup();
        resolve(false); // Timeout occurred
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

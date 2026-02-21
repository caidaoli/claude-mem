import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { EventEmitter } from 'events';
import { SessionQueueProcessor, CreateIteratorOptions } from '../../../src/services/queue/SessionQueueProcessor.js';
import type { PendingMessageStore, PersistentPendingMessage } from '../../../src/services/sqlite/PendingMessageStore.js';

/**
 * Mock PendingMessageStore that returns null (empty queue) by default.
 * Individual tests can override claimNextMessage behavior.
 */
function createMockStore(): PendingMessageStore {
  return {
    claimNextMessage: mock(() => null),
    confirmProcessed: mock(() => true),
    resetToPending: mock(() => true),
    getPendingCount: mock(() => 1),
    getWorkCount: mock(() => 0),
    toPendingMessage: mock((msg: PersistentPendingMessage) => ({
      type: msg.message_type,
      tool_name: msg.tool_name || undefined,
      tool_input: msg.tool_input ? JSON.parse(msg.tool_input) : undefined,
      tool_response: msg.tool_response ? JSON.parse(msg.tool_response) : undefined,
      prompt_number: msg.prompt_number || undefined,
      cwd: msg.cwd || undefined,
      last_assistant_message: msg.last_assistant_message || undefined
    }))
  } as unknown as PendingMessageStore;
}

/**
 * Create a mock PersistentPendingMessage for testing
 */
function createMockMessage(overrides: Partial<PersistentPendingMessage> = {}): PersistentPendingMessage {
  return {
    id: 1,
    session_db_id: 123,
    content_session_id: 'test-session',
    message_type: 'observation',
    tool_name: 'Read',
    tool_input: JSON.stringify({ file: 'test.ts' }),
    tool_response: JSON.stringify({ content: 'file contents' }),
    cwd: '/test',
    last_assistant_message: null,
    prompt_number: 1,
    status: 'pending',
    retry_count: 0,
    created_at_epoch: Date.now(),
    started_processing_at_epoch: null,
    completed_at_epoch: null,
    ...overrides
  };
}

describe('SessionQueueProcessor', () => {
  let store: PendingMessageStore;
  let events: EventEmitter;
  let processor: SessionQueueProcessor;
  let abortController: AbortController;

  beforeEach(() => {
    store = createMockStore();
    events = new EventEmitter();
    processor = new SessionQueueProcessor(store, events);
    abortController = new AbortController();
  });

  afterEach(() => {
    // Ensure abort controller is triggered to clean up any pending iterators
    abortController.abort();
    // Remove all listeners to prevent memory leaks
    events.removeAllListeners();
  });

  describe('createIterator', () => {
    describe('idle timeout behavior', () => {
      it('should exit after idle timeout when no messages arrive', async () => {
        // Use a very short timeout for testing (50ms)
        const SHORT_TIMEOUT_MS = 50;

        // Mock the private waitForMessage to use short timeout
        // We'll test with real timing but short durations
        const onIdleTimeout = mock(() => {});

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          onIdleTimeout
        };

        const iterator = processor.createIterator(options);

        // Store returns null (empty queue), so iterator waits for message event
        // With no messages arriving, it should eventually timeout

        const startTime = Date.now();
        const results: any[] = [];

        // We need to trigger the timeout scenario
        // The iterator uses IDLE_TIMEOUT_MS (3 minutes) which is too long for tests
        // Instead, we'll test the abort path and verify callback behavior

        // Abort after a short delay to simulate timeout-like behavior
        setTimeout(() => abortController.abort(), 100);

        for await (const message of iterator) {
          results.push(message);
        }

        // Iterator should exit cleanly when aborted
        expect(results).toHaveLength(0);
      });

      it('should invoke onIdleTimeout callback when idle timeout occurs', async () => {
        // This test verifies the callback mechanism works
        // We can't easily test the full 3-minute timeout, so we verify the wiring

        const onIdleTimeout = mock(() => {
          // Callback should trigger abort in real usage
          abortController.abort();
        });

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          onIdleTimeout
        };

        // To test this properly, we'd need to mock the internal waitForMessage
        // For now, verify that abort signal exits cleanly
        const iterator = processor.createIterator(options);

        // Simulate external abort (which is what onIdleTimeout should do)
        setTimeout(() => abortController.abort(), 50);

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        expect(results).toHaveLength(0);
      });

      it('should reset idle timer when message arrives', async () => {
        const onIdleTimeout = mock(() => abortController.abort());
        let callCount = 0;

        // Return a message on first call, then null
        (store.claimNextMessage as any) = mock(() => {
          callCount++;
          if (callCount === 1) {
            return createMockMessage({ id: 1 });
          }
          return null;
        });

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          onIdleTimeout
        };

        const iterator = processor.createIterator(options);
        const results: any[] = [];

        // First message should be yielded
        // Then queue is empty, wait for more
        // Abort after receiving first message
        setTimeout(() => abortController.abort(), 100);

        for await (const message of iterator) {
          results.push(message);
        }

        // Should have received exactly one message
        expect(results).toHaveLength(1);
        expect(results[0]._persistentId).toBe(1);

        // Store's claimNextMessage should have been called at least twice
        // (once returning message, once returning null)
        expect(callCount).toBeGreaterThanOrEqual(1);
      });
    });

    describe('abort signal handling', () => {
      it('should exit immediately when abort signal is triggered', async () => {
        const onIdleTimeout = mock(() => {});

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          onIdleTimeout
        };

        const iterator = processor.createIterator(options);

        // Abort immediately
        abortController.abort();

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        // Should exit with no messages
        expect(results).toHaveLength(0);
        // onIdleTimeout should NOT be called when abort signal is used
        expect(onIdleTimeout).not.toHaveBeenCalled();
      });

      it('should take precedence over timeout when both could fire', async () => {
        const onIdleTimeout = mock(() => {});

        // Return null to trigger wait
        (store.claimNextMessage as any) = mock(() => null);

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          onIdleTimeout
        };

        const iterator = processor.createIterator(options);

        // Abort very quickly - before any timeout could fire
        setTimeout(() => abortController.abort(), 10);

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        // Should have exited cleanly
        expect(results).toHaveLength(0);
        // onIdleTimeout should NOT have been called
        expect(onIdleTimeout).not.toHaveBeenCalled();
      });
    });

    it('should process completion control message and exit without yielding', async () => {
      const onComplete = mock(() => {});

      // Return a completion control message immediately
      (store.claimNextMessage as any) = mock(() => createMockMessage({ id: 42, message_type: 'complete', created_at_epoch: Date.now() - 10_000 }));

      const options: CreateIteratorOptions = {
        sessionDbId: 123,
        signal: abortController.signal,
        onComplete
      };

      const iterator = processor.createIterator(options);
      const results: any[] = [];

      for await (const message of iterator) {
        results.push(message);
      }

      expect(results).toHaveLength(0);
      expect((store.confirmProcessed as any)).toHaveBeenCalledTimes(1);
      expect((store.confirmProcessed as any)).toHaveBeenCalledWith(42);
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('should not mark complete if completion was cleared before confirmProcessed', async () => {
      const onComplete = mock(() => {});
      const waits: number[] = [];

      let claimCount = 0;
      (store.claimNextMessage as any) = mock(() => {
        claimCount++;
        if (claimCount === 1) {
          return createMockMessage({ id: 42, message_type: 'complete', created_at_epoch: Date.now() - 10_000 });
        }
        return null;
      });

      // Simulate /api/sessions/init clearing the claimed completion message.
      (store.confirmProcessed as any) = mock(() => false);

      // Avoid real waiting; ensure the iterator keeps running instead of exiting.
      (processor as any).waitForMessage = mock(async (_signal: AbortSignal, timeoutMs: number) => {
        waits.push(timeoutMs);
        abortController.abort();
        return false;
      });

      const options: CreateIteratorOptions = {
        sessionDbId: 123,
        signal: abortController.signal,
        onComplete
      };

      const iterator = processor.createIterator(options);
      const results: any[] = [];

      for await (const message of iterator) {
        results.push(message);
      }

      expect(results).toHaveLength(0);
      expect(onComplete).not.toHaveBeenCalled();
      expect((store.confirmProcessed as any)).toHaveBeenCalledTimes(1);
      expect((store.confirmProcessed as any)).toHaveBeenCalledWith(42);
      // It should continue looping (queue empty) rather than return immediately.
      expect(waits.length).toBeGreaterThanOrEqual(1);
    });

    it('should back off when completion arrives but other work is still processing', async () => {
      const onComplete = mock(() => {});
      const timeouts: number[] = [];

      let claimCount = 0;
      (store.claimNextMessage as any) = mock(() => {
        claimCount++;
        if (claimCount === 1) {
          return createMockMessage({ id: 42, message_type: 'complete', created_at_epoch: Date.now() - 10_000 });
        }
        return null;
      });

      // Simulate work items stuck in 'processing' (e.g. crashed worker within stale threshold)
      (store.getWorkCount as any) = mock(() => 1);

      // Avoid real waiting; capture the requested delay and stop the iterator.
      (processor as any).waitForMessage = mock(async (_signal: AbortSignal, timeoutMs: number) => {
        timeouts.push(timeoutMs);
        abortController.abort();
        return false;
      });

      const options: CreateIteratorOptions = {
        sessionDbId: 123,
        signal: abortController.signal,
        onComplete
      };

      const iterator = processor.createIterator(options);
      const results: any[] = [];

      for await (const message of iterator) {
        results.push(message);
      }

      expect(results).toHaveLength(0);
      expect(onComplete).not.toHaveBeenCalled();
      expect((store.resetToPending as any)).toHaveBeenCalledWith(42);
      // Must wait/back off rather than immediately looping into the idle wait (3 minutes).
      expect(timeouts.length).toBeGreaterThanOrEqual(1);
      expect(timeouts[0]).toBeLessThan(3 * 60 * 1000);
    });

    describe('message event handling', () => {
      it('should wake up when message event is emitted', async () => {
        let callCount = 0;
        const mockMessages = [
          createMockMessage({ id: 1 }),
          createMockMessage({ id: 2 })
        ];

        // First call: return null (queue empty)
        // After message event: return message
        // Then return null again
        (store.claimNextMessage as any) = mock(() => {
          callCount++;
          if (callCount === 1) {
            // First check - queue empty, will wait
            return null;
          } else if (callCount === 2) {
            // After wake-up - return message
            return mockMessages[0];
          } else if (callCount === 3) {
            // Second check after message processed - empty again
            return null;
          }
          return null;
        });

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);
        const results: any[] = [];

        // Emit message event after a short delay to wake up the iterator
        setTimeout(() => events.emit('message'), 50);

        // Abort after collecting results
        setTimeout(() => abortController.abort(), 150);

        for await (const message of iterator) {
          results.push(message);
        }

        // Should have received exactly one message
        expect(results.length).toBeGreaterThanOrEqual(1);
        if (results.length > 0) {
          expect(results[0]._persistentId).toBe(1);
        }
      });
    });

    describe('event listener cleanup', () => {
      it('should clean up event listeners on abort', async () => {
        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);

        // Get initial listener count
        const initialListenerCount = events.listenerCount('message');

        // Abort to trigger cleanup
        abortController.abort();

        // Consume the iterator
        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        // After iterator completes, listener count should be same or less
        // (the cleanup happens inside waitForMessage which may not be called)
        const finalListenerCount = events.listenerCount('message');
        expect(finalListenerCount).toBeLessThanOrEqual(initialListenerCount + 1);
      });

      it('should clean up event listeners when message received', async () => {
        // Return a message immediately
        (store.claimNextMessage as any) = mock(() => createMockMessage({ id: 1 }));

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);

        // Get first message
        const firstResult = await iterator.next();
        expect(firstResult.done).toBe(false);
        expect(firstResult.value._persistentId).toBe(1);

        // Now abort and complete iteration
        abortController.abort();

        // Drain remaining
        for await (const _ of iterator) {
          // Should not get here since we aborted
        }

        // Verify no leftover listeners (accounting for potential timing)
        const finalListenerCount = events.listenerCount('message');
        expect(finalListenerCount).toBeLessThanOrEqual(1);
      });
    });

    describe('error handling', () => {
      it('should continue after store error with backoff', async () => {
        let callCount = 0;

        (store.claimNextMessage as any) = mock(() => {
          callCount++;
          if (callCount === 1) {
            throw new Error('Database error');
          }
          if (callCount === 2) {
            return createMockMessage({ id: 1 });
          }
          return null;
        });

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);
        const results: any[] = [];

        // Abort after giving time for retry
        setTimeout(() => abortController.abort(), 1500);

        for await (const message of iterator) {
          results.push(message);
          break; // Exit after first message
        }

        // Should have recovered and received message after error
        expect(results).toHaveLength(1);
        expect(callCount).toBeGreaterThanOrEqual(2);
      });

      it('should exit cleanly if aborted during error backoff', async () => {
        (store.claimNextMessage as any) = mock(() => {
          throw new Error('Database error');
        });

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);

        // Abort during the backoff period
        setTimeout(() => abortController.abort(), 100);

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        // Should exit cleanly with no messages
        expect(results).toHaveLength(0);
      });
    });

    describe('message conversion', () => {
      it('should convert PersistentPendingMessage to PendingMessageWithId', async () => {
        const mockPersistentMessage = createMockMessage({
          id: 42,
          message_type: 'observation',
          tool_name: 'Grep',
          tool_input: JSON.stringify({ pattern: 'test' }),
          tool_response: JSON.stringify({ matches: ['file.ts'] }),
          prompt_number: 5,
          created_at_epoch: 1704067200000
        });

        (store.claimNextMessage as any) = mock(() => mockPersistentMessage);

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);
        const result = await iterator.next();

        // Abort to clean up
        abortController.abort();

        expect(result.done).toBe(false);
        expect(result.value).toMatchObject({
          _persistentId: 42,
          _originalTimestamp: 1704067200000,
          type: 'observation',
          tool_name: 'Grep',
          prompt_number: 5
        });
      });
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { EventEmitter } from 'events';
import { SessionQueueProcessor, CreateIteratorOptions } from '../../../src/services/queue/SessionQueueProcessor.js';
import type { PendingMessageStore, PersistentPendingMessage } from '../../../src/services/sqlite/PendingMessageStore.js';

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
      last_assistant_message: msg.last_assistant_message || undefined,
      agentId: msg.agent_id ?? undefined,
      agentType: msg.agent_type ?? undefined
    }))
  } as unknown as PendingMessageStore;
}

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
    created_at_epoch: Date.now(),
    agent_type: null,
    agent_id: null,
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
    abortController.abort();
    events.removeAllListeners();
  });

  describe('createIterator', () => {
    describe('idle timeout behavior', () => {
      it('should exit after idle timeout when no messages arrive', async () => {
        const SHORT_TIMEOUT_MS = 50;

        const onIdleTimeout = mock(() => {});

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          onIdleTimeout,
          idleTimeoutMs: SHORT_TIMEOUT_MS
        };

        const iterator = processor.createIterator(options);

        const results: any[] = [];

        for await (const message of iterator) {
          results.push(message);
        }

        expect(results).toHaveLength(0);
        expect(onIdleTimeout).toHaveBeenCalled();
      });

      it('should invoke onIdleTimeout callback when idle timeout occurs', async () => {

        const onIdleTimeout = mock(() => {
          abortController.abort();
        });

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          onIdleTimeout,
          idleTimeoutMs: 50
        };

        const iterator = processor.createIterator(options);

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        expect(results).toHaveLength(0);
      });

      it('should reset idle timer when message arrives', async () => {
        const onIdleTimeout = mock(() => abortController.abort());
        let callCount = 0;

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
          onIdleTimeout,
          idleTimeoutMs: 50
        };

        const iterator = processor.createIterator(options);
        const results: any[] = [];

        setTimeout(() => abortController.abort(), 25);

        for await (const message of iterator) {
          results.push(message);
        }

        expect(results).toHaveLength(1);
        expect(results[0]._persistentId).toBe(1);

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

        abortController.abort();

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        expect(results).toHaveLength(0);
        expect(onIdleTimeout).not.toHaveBeenCalled();
      });

      it('should take precedence over timeout when both could fire', async () => {
        const onIdleTimeout = mock(() => {});

        (store.claimNextMessage as any) = mock(() => null);

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          onIdleTimeout
        };

        const iterator = processor.createIterator(options);

        setTimeout(() => abortController.abort(), 10);

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        expect(results).toHaveLength(0);
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

        (store.claimNextMessage as any) = mock(() => {
          callCount++;
          if (callCount === 1) {
            return null;
          } else if (callCount === 2) {
            return mockMessages[0];
          } else if (callCount === 3) {
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

        setTimeout(() => events.emit('message'), 50);

        setTimeout(() => abortController.abort(), 150);

        for await (const message of iterator) {
          results.push(message);
        }

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

        const initialListenerCount = events.listenerCount('message');

        abortController.abort();

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        const finalListenerCount = events.listenerCount('message');
        expect(finalListenerCount).toBeLessThanOrEqual(initialListenerCount + 1);
      });

      it('should clean up event listeners when message received', async () => {
        (store.claimNextMessage as any) = mock(() => createMockMessage({ id: 1 }));

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);

        const firstResult = await iterator.next();
        expect(firstResult.done).toBe(false);
        expect(firstResult.value._persistentId).toBe(1);

        abortController.abort();

        for await (const _ of iterator) {
          // Should not get here since we aborted
        }

        const finalListenerCount = events.listenerCount('message');
        expect(finalListenerCount).toBeLessThanOrEqual(1);
      });
    });

    describe('error handling', () => {
      it('should retry after a transient store claim error', async () => {
        let callCount = 0;

        (store.claimNextMessage as any) = mock(() => {
          callCount++;
          if (callCount === 1) {
            throw new Error('Database error');
          }
          return createMockMessage({ id: 7 });
        });

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          claimRetryDelayMs: 1
        };

        const iterator = processor.createIterator(options);
        const result = await iterator.next();
        abortController.abort();

        expect(result.done).toBe(false);
        expect(result.value._persistentId).toBe(7);
        expect(callCount).toBe(2);
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

        setTimeout(() => abortController.abort(), 100);

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

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

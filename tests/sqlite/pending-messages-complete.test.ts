import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';

describe('pending_messages message_type', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  it('allows message_type=complete', () => {
    const sessionDbId = createSDKSession(db, 'content-complete-type', 'test-project', 'prompt');

    expect(() => {
      db.prepare(`
        INSERT INTO pending_messages
        (session_db_id, content_session_id, message_type, created_at_epoch)
        VALUES (?, ?, 'complete', ?)
      `).run(sessionDbId, 'content-complete-type', Date.now());
    }).not.toThrow();
  });
});

describe('PendingMessageStore complete control messages', () => {
  let db: Database;
  let store: PendingMessageStore;
  let sessionDbId: number;
  const contentSessionId = 'test-content-session';

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    store = new PendingMessageStore(db, 3);
    sessionDbId = createSDKSession(db, contentSessionId, 'test-project', 'prompt');
  });

  afterEach(() => {
    db.close();
  });

  describe('clearPendingComplete', () => {
    it('deletes pending complete messages', () => {
      store.enqueue(sessionDbId, contentSessionId, { type: 'complete' });
      expect(store.getPendingCount(sessionDbId)).toBe(1);

      const cleared = store.clearPendingComplete(sessionDbId);
      expect(cleared).toBe(1);
      expect(store.getPendingCount(sessionDbId)).toBe(0);
    });

    it('deletes processing complete messages', () => {
      store.enqueue(sessionDbId, contentSessionId, { type: 'complete' });
      // Claim it so it transitions to 'processing'
      store.claimNextMessage(sessionDbId);
      expect(store.getPendingCount(sessionDbId)).toBe(1); // processing counts

      const cleared = store.clearPendingComplete(sessionDbId);
      expect(cleared).toBe(1);
      expect(store.getPendingCount(sessionDbId)).toBe(0);
    });

    it('does not delete observation or summarize messages', () => {
      store.enqueue(sessionDbId, contentSessionId, { type: 'observation', tool_name: 'Read' });
      store.enqueue(sessionDbId, contentSessionId, { type: 'summarize' });
      store.enqueue(sessionDbId, contentSessionId, { type: 'complete' });

      const cleared = store.clearPendingComplete(sessionDbId);
      expect(cleared).toBe(1);
      expect(store.getPendingCount(sessionDbId)).toBe(2);
    });

    it('does not affect other sessions', () => {
      const otherSessionDbId = createSDKSession(db, 'other-session', 'test-project', 'prompt');
      store.enqueue(sessionDbId, contentSessionId, { type: 'complete' });
      store.enqueue(otherSessionDbId, 'other-session', { type: 'complete' });

      store.clearPendingComplete(sessionDbId);
      expect(store.getPendingCount(sessionDbId)).toBe(0);
      expect(store.getPendingCount(otherSessionDbId)).toBe(1);
    });
  });

  describe('getWorkCount', () => {
    it('counts observations and summarize but not complete', () => {
      store.enqueue(sessionDbId, contentSessionId, { type: 'observation', tool_name: 'Read' });
      store.enqueue(sessionDbId, contentSessionId, { type: 'summarize' });
      store.enqueue(sessionDbId, contentSessionId, { type: 'complete' });

      expect(store.getPendingCount(sessionDbId)).toBe(3);
      expect(store.getWorkCount(sessionDbId)).toBe(2);
    });

    it('returns 0 when only complete messages exist', () => {
      store.enqueue(sessionDbId, contentSessionId, { type: 'complete' });

      expect(store.getPendingCount(sessionDbId)).toBe(1);
      expect(store.getWorkCount(sessionDbId)).toBe(0);
    });

    it('includes processing work items', () => {
      store.enqueue(sessionDbId, contentSessionId, { type: 'observation', tool_name: 'Read' });
      store.enqueue(sessionDbId, contentSessionId, { type: 'observation', tool_name: 'Edit' });
      // Claim one — transitions to processing
      store.claimNextMessage(sessionDbId);

      expect(store.getWorkCount(sessionDbId)).toBe(2);
    });

    it('returns 0 for empty queue', () => {
      expect(store.getWorkCount(sessionDbId)).toBe(0);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

function summary(overrides: Partial<Parameters<SessionStore['storeSummary']>[2]> = {}) {
  return {
    request: 'User requested feature X',
    investigated: 'Explored the codebase',
    learned: 'Discovered pattern Y',
    completed: 'Implemented feature X',
    next_steps: 'Add tests and documentation',
    notes: 'Consider edge case Z' as string | null,
    ...overrides,
  };
}

function importSummaryInput(
  memorySessionId: string,
  overrides: Partial<Parameters<SessionStore['importSessionSummary']>[0]> = {}
) {
  const createdAtEpoch = overrides.created_at_epoch ?? 1700000000000;
  return {
    memory_session_id: memorySessionId,
    project: 'project',
    request: 'Imported request',
    investigated: 'Imported investigation',
    learned: 'Imported learning',
    completed: 'Imported completion',
    next_steps: 'Imported next step',
    files_read: null,
    files_edited: null,
    notes: null,
    prompt_number: 1,
    discovery_tokens: 0,
    created_at: new Date(createdAtEpoch).toISOString(),
    created_at_epoch: createdAtEpoch,
    ...overrides,
  };
}

describe('SessionStore summaries', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  // session_summaries references sdk_sessions(memory_session_id) via enforced FK.
  function session(memorySessionId: string): string {
    const id = store.createSDKSession(`content-${memorySessionId}`, 'project', 'prompt');
    store.updateMemorySessionId(id, memorySessionId);
    return memorySessionId;
  }

  describe('storeSummary', () => {
    it('returns a positive id and createdAtEpoch', () => {
      const result = store.storeSummary(session('mem-sum-1'), 'project', summary());
      expect(result.id).toBeGreaterThan(0);
      expect(result.createdAtEpoch).toBeGreaterThan(0);
    });

    it('round-trips all fields and prompt_number via getSummaryForSession', () => {
      const mem = session('mem-sum-2');
      store.storeSummary(mem, 'project', summary({
        request: 'Refactor the database layer',
        investigated: 'Analyzed current schema',
        learned: 'Found N+1 query issues',
        completed: 'Optimized queries',
        next_steps: 'Monitor performance',
        notes: 'May need caching',
      }), 1, 500);

      const stored = store.getSummaryForSession(mem);
      expect(stored?.request).toBe('Refactor the database layer');
      expect(stored?.investigated).toBe('Analyzed current schema');
      expect(stored?.learned).toBe('Found N+1 query issues');
      expect(stored?.completed).toBe('Optimized queries');
      expect(stored?.next_steps).toBe('Monitor performance');
      expect(stored?.notes).toBe('May need caching');
      expect(stored?.prompt_number).toBe(1);
    });

    it('honors overrideTimestampEpoch', () => {
      const past = 1650000000000;
      const mem = session('mem-sum-3');
      const result = store.storeSummary(mem, 'project', summary(), 1, 0, past);
      expect(result.createdAtEpoch).toBe(past);
      expect(store.getSummaryForSession(mem)?.created_at_epoch).toBe(past);
    });

    it('defaults timestamp to now when omitted', () => {
      const before = Date.now();
      const result = store.storeSummary(session('mem-sum-now'), 'project', summary());
      const after = Date.now();
      expect(result.createdAtEpoch).toBeGreaterThanOrEqual(before);
      expect(result.createdAtEpoch).toBeLessThanOrEqual(after);
    });

    it('preserves null notes', () => {
      const mem = session('mem-sum-null');
      store.storeSummary(mem, 'project', summary({ notes: null }));
      expect(store.getSummaryForSession(mem)?.notes).toBeNull();
    });

    it('dedupes identical summary payloads in the same memory session', () => {
      const mem = session('mem-sum-dedup');
      const input = summary({ request: 'Same request', completed: 'Same completion' });

      const first = store.storeSummary(mem, 'project', input, 1, 0, 1700000000000);
      const second = store.storeSummary(mem, 'project', input, 1, 0, 1700000000100);

      expect(second.id).toBe(first.id);
      expect(second.createdAtEpoch).toBe(first.createdAtEpoch);

      const count = store.db.prepare(
        'SELECT COUNT(*) AS n FROM session_summaries WHERE memory_session_id = ?'
      ).get(mem) as { n: number };
      expect(count.n).toBe(1);
    });

    it('keeps distinct summary payloads in the same memory session', () => {
      const mem = session('mem-sum-distinct');

      const first = store.storeSummary(mem, 'project', summary({ request: 'First request' }), 1, 0, 1700000000000);
      const second = store.storeSummary(mem, 'project', summary({ request: 'Second request' }), 2, 0, 1700000000100);

      expect(second.id).not.toBe(first.id);

      const count = store.db.prepare(
        'SELECT COUNT(*) AS n FROM session_summaries WHERE memory_session_id = ?'
      ).get(mem) as { n: number };
      expect(count.n).toBe(2);
    });
  });

  describe('importSessionSummary', () => {
    it('dedupes identical imported summary payloads in the same memory session', () => {
      const mem = session('mem-import-dedup');
      const input = importSummaryInput(mem, {
        request: 'Same imported request',
        files_read: JSON.stringify(['src/a.ts']),
      });

      const first = store.importSessionSummary(input);
      const second = store.importSessionSummary(input);

      expect(first.imported).toBe(true);
      expect(second.imported).toBe(false);
      expect(second.id).toBe(first.id);

      const count = store.db.prepare(
        'SELECT COUNT(*) AS n FROM session_summaries WHERE memory_session_id = ?'
      ).get(mem) as { n: number };
      expect(count.n).toBe(1);
    });

    it('keeps imported summaries with distinct file payloads in the same memory session', () => {
      const mem = session('mem-import-distinct-files');

      const first = store.importSessionSummary(importSummaryInput(mem, {
        request: 'Same imported request',
        files_read: JSON.stringify(['src/a.ts']),
      }));
      const second = store.importSessionSummary(importSummaryInput(mem, {
        request: 'Same imported request',
        files_read: JSON.stringify(['src/b.ts']),
        created_at_epoch: 1700000000100,
      }));

      expect(first.imported).toBe(true);
      expect(second.imported).toBe(true);
      expect(second.id).not.toBe(first.id);

      const rows = store.db.prepare(`
        SELECT files_read
        FROM session_summaries
        WHERE memory_session_id = ?
        ORDER BY created_at_epoch
      `).all(mem) as Array<{ files_read: string | null }>;
      expect(rows.map(row => row.files_read)).toEqual([
        JSON.stringify(['src/a.ts']),
        JSON.stringify(['src/b.ts']),
      ]);
    });
  });

  describe('getSummaryForSession', () => {
    it('retrieves by memory_session_id', () => {
      const mem = session('mem-unique');
      store.storeSummary(mem, 'project', summary({ request: 'Unique request' }));
      expect(store.getSummaryForSession(mem)?.request).toBe('Unique request');
    });

    it('returns null when none exists', () => {
      expect(store.getSummaryForSession('nonexistent-session')).toBeNull();
    });

    it('returns the most recent summary when multiple exist', () => {
      const mem = session('mem-multi');
      store.storeSummary(mem, 'project', summary({ request: 'First request' }), 1, 0, 1000000000000);
      store.storeSummary(mem, 'project', summary({ request: 'Second request' }), 2, 0, 2000000000000);

      const retrieved = store.getSummaryForSession(mem);
      expect(retrieved?.request).toBe('Second request');
      expect(retrieved?.prompt_number).toBe(2);
    });
  });
});

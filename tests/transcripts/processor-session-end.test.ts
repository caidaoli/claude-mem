import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { setIngestContext } from '../../src/services/worker/http/shared.js';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';

let store: SessionStore;
let sessionDbId: number;
const queued: Array<{ sessionDbId: number; message?: string }> = [];

beforeEach(() => {
  store = new SessionStore(':memory:');
  sessionDbId = store.createSDKSession('codex-session-1', 'project', 'work', undefined, 'codex');
  queued.length = 0;
  setIngestContext({
    dbManager: { getSessionStore: () => store } as any,
    sessionManager: { queueSummarize: (sessionDbId: number, message?: string) => {
      queued.push({ sessionDbId, message });
    } } as any,
    eventBroadcaster: { broadcastSummarizeQueued: () => {} } as any,
  });
});

afterEach(() => store.close());

describe('TranscriptEventProcessor session_end', () => {
  it('queues a summary request from Codex transcript session_end events', async () => {
    const processor = new TranscriptEventProcessor();

    const schema = {
      name: 'codex',
      events: [
        {
          name: 'assistant-message',
          match: { path: 'payload.type', equals: 'agent_message' },
          action: 'assistant_message' as const,
          fields: {
            message: 'payload.message',
          },
        },
        {
          name: 'session-end',
          match: { path: 'payload.type', equals: 'turn_completed' },
          action: 'session_end' as const,
        },
      ],
    };

    await processor.processEntry(
      { payload: { type: 'agent_message', message: 'done' } },
      {
        name: 'codex',
        path: '~/.codex/sessions/**/*.jsonl',
        schema: 'codex',
      },
      schema,
      'codex-session-1'
    );

    await processor.processEntry(
      { payload: { type: 'turn_completed' } },
      {
        name: 'codex',
        path: '~/.codex/sessions/**/*.jsonl',
        schema: 'codex',
      },
      schema,
      'codex-session-1'
    );

    expect(queued).toEqual([{ sessionDbId, message: 'done' }]);
  });

});

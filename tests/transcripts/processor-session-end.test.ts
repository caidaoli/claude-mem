import { afterAll, describe, expect, it, mock } from 'bun:test';

import * as realWorkerUtils from '../../src/shared/worker-utils.js';

const realWorkerUtilsSnapshot = { ...realWorkerUtils };

const workerCalls: Array<{ path: string; body?: unknown }> = [];

mock.module('../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(true),
  executeWithWorkerFallback: () => Promise.resolve({ status: 'queued' }),
  fetchWithTimeout: () => Promise.resolve(new Response('{"ok":true}', { status: 200 })),
  getWorkerPort: () => 37777,
  isWorkerFallback: () => false,
  workerHttpRequest: (path: string, options?: { body?: unknown }) => {
    workerCalls.push({ path, body: options?.body });
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  },
}));

afterAll(() => {
  mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

describe('TranscriptEventProcessor session_end', () => {
  it('queues a summary request from Codex transcript session_end events', async () => {
    workerCalls.length = 0;
    const { TranscriptEventProcessor } = await import('../../src/services/transcripts/processor.js');
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

    const summaryCall = workerCalls.find(call => call.path === '/api/sessions/summarize');
    expect(summaryCall).toBeDefined();
    expect(JSON.parse(String(summaryCall?.body))).toEqual({
      contentSessionId: 'codex-session-1',
      last_assistant_message: 'done',
      platformSource: 'codex',
    });
  });

  it('keeps the default Codex transcript schema in the summary producer path', async () => {
    const { CODEX_SAMPLE_SCHEMA } = await import('../../src/services/transcripts/config.js');

    expect(CODEX_SAMPLE_SCHEMA.events.some(event => event.action === 'session_end')).toBe(true);
  });
});

import { describe, expect, it, mock } from 'bun:test';

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

describe('TranscriptEventProcessor session_end', () => {
  it('does not produce a summarize request from transcript session_end events', async () => {
    workerCalls.length = 0;
    const { TranscriptEventProcessor } = await import('../../src/services/transcripts/processor.js');
    const processor = new TranscriptEventProcessor();

    await processor.processEntry(
      { payload: { type: 'turn_completed' } },
      {
        name: 'codex',
        path: '~/.codex/sessions/**/*.jsonl',
        schema: 'codex',
      },
      {
        name: 'codex',
        events: [
          {
            name: 'session-end',
            match: { path: 'payload.type', equals: 'turn_completed' },
            action: 'session_end',
          },
        ],
      },
      'codex-session-1'
    );

    expect(workerCalls.find(call => call.path === '/api/sessions/summarize')).toBeUndefined();
  });

  it('keeps the default Codex transcript schema out of the summary producer path', async () => {
    const { SAMPLE_CONFIG } = await import('../../src/services/transcripts/config.js');
    const codexSchema = SAMPLE_CONFIG.schemas?.codex;

    expect(codexSchema?.events.some(event => event.action === 'session_end')).toBe(false);
  });
});

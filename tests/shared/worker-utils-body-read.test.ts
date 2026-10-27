import { afterEach, describe, expect, it } from 'bun:test';
// Freeze paths.ts on the per-run temp data dir before worker-utils loads (see
// tests/shared/worker-utils-timeout.test.ts for why the order matters).
import '../../src/shared/paths.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../src/shared/worker-utils.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe('executeWithWorkerFallback body read (#3161)', () => {
  it('returns the worker fallback, not a thrown error, when the worker dies mid-body', async () => {
    global.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/api/readiness')) {
        return new Response('{"status":"ready"}', { status: 200 });
      }
      // Headers arrive, then the socket closes before the body is complete.
      const bodyThatDiesMidRead = new ReadableStream({
        start(controller) {
          controller.error(new Error('socket closed mid-body'));
        },
      });
      return new Response(bodyThatDiesMidRead, { status: 200 });
    }) as typeof fetch;

    // The bounded startup path (Codex) keeps the worker probe to one mocked
    // readiness request.
    const result = await executeWithWorkerFallback<string>('/api/context/inject?projects=demo', 'GET', undefined, {
      workerStartupTimeoutMs: 1_000,
      timeoutMs: 1_000,
    });

    expect(isWorkerFallback(result)).toBe(true);
    expect((result as { reason?: string }).reason).toBe('worker_body_read_failed');
  });
});

describe('body first-chunk deadline', () => {
  it('keeps waiting for the first chunk after HTTP headers arrived', async () => {
    const { fetchStreamWithIdleTimeout } = await import('../../src/shared/worker-utils.js');
    global.fetch = (async (_url: unknown, init: RequestInit) => new Response(new ReadableStream({ start(controller) {
      init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
    } }))) as typeof fetch;
    const response = await fetchStreamWithIdleTimeout('http://localhost/model', {}, {
      idleTimeoutMs: 500, absoluteCapMs: 1000, firstChunkTimeoutMs: 15,
    });
    const consume = async () => { for await (const _chunk of response.chunks) {} };
    await expect(consume()).rejects.toThrow('first body chunk');
  });

  it('clears the first-chunk deadline while continuing to enforce the total cap', async () => {
    const { fetchStreamWithIdleTimeout } = await import('../../src/shared/worker-utils.js');
    global.fetch = (async (_url: unknown, init: RequestInit) => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('first'));
      init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
    } }))) as typeof fetch;
    const response = await fetchStreamWithIdleTimeout('http://localhost/model', {}, {
      idleTimeoutMs: 500, absoluteCapMs: 45, firstChunkTimeoutMs: 10,
    });
    const consume = async () => { for await (const _chunk of response.chunks) {} };
    await expect(consume()).rejects.toThrow('45ms');
  });
});

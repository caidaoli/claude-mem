import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let closeCalls = 0;
let failFirstOne = false;
const ingestCalls: Array<{ toolResponse: unknown }> = [];

const realFs = await import('node:fs');

mock.module('fs', () => ({
  ...realFs,
  watch: () => ({
    close: () => {
      closeCalls++;
    },
  }),
}));

mock.module('../../src/services/worker/http/shared.js', () => ({
  ingestObservation: (payload: { toolResponse: unknown }) => {
    ingestCalls.push({ toolResponse: payload.toolResponse });
    if (payload.toolResponse === 'one' && failFirstOne) {
      failFirstOne = false;
      return Promise.resolve({ ok: false, reason: 'synthetic failure' });
    }
    return Promise.resolve({ ok: true, sessionDbId: 1 });
  },
}));

describe('TranscriptWatcher polling fallback', () => {
  let dir: string;

  beforeEach(() => {
    closeCalls = 0;
    failFirstOne = false;
    ingestCalls.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'claude-mem-watcher-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('advances offsets for appended transcript lines even when fs.watch emits no events', async () => {
    const transcriptPath = join(dir, 'session.jsonl');
    const statePath = join(dir, 'state.json');
    writeFileSync(transcriptPath, '{"timestamp":"start"}\n');

    const { TranscriptWatcher } = await import('../../src/services/transcripts/watcher.js');
    const watcher = new TranscriptWatcher(
      {
        version: 1,
        schemas: {
          empty: { name: 'empty', events: [] },
        },
        watches: [
          {
            name: 'codex',
            path: transcriptPath,
            schema: 'empty',
            startAtEnd: true,
          },
        ],
      },
      statePath,
      {
        reconciliationTickMs: 20,
        activeReconcileIntervalMs: 20,
        idleReconcileIntervalMs: 20,
      },
    );

    await watcher.start();
    const initialOffset = '{"timestamp":"start"}\n'.length;

    writeFileSync(transcriptPath, '{"timestamp":"start"}\n{"timestamp":"later"}\n');
    await new Promise(resolve => setTimeout(resolve, 80));
    watcher.stop();

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(initialOffset).toBe(22);
    expect(state.offsets[transcriptPath]).toBe('{"timestamp":"start"}\n{"timestamp":"later"}\n'.length);
    expect(closeCalls).toBeGreaterThanOrEqual(1);
  });

  it('does not commit an offset past a failed transcript line before retrying it', async () => {
    const transcriptPath = join(dir, 'session.jsonl');
    const statePath = join(dir, 'state.json');
    const firstLine = '{"payload":{"type":"exec_command_output","output":"one"}}\n';
    const secondLine = '{"payload":{"type":"exec_command_output","output":"two"}}\n';
    writeFileSync(transcriptPath, firstLine + secondLine);
    failFirstOne = true;

    const { TranscriptWatcher } = await import('../../src/services/transcripts/watcher.js');
    const watcher = new TranscriptWatcher(
      {
        version: 1,
        schemas: {
          codex: {
            name: 'codex',
            events: [
              {
                name: 'exec-output',
                match: { path: 'payload.type', equals: 'exec_command_output' },
                action: 'observation',
                fields: {
                  sessionId: { value: 'session-1' },
                  toolName: { value: 'exec_command' },
                  toolResponse: 'payload.output',
                },
              },
            ],
          },
        },
        watches: [
          {
            name: 'codex',
            path: transcriptPath,
            schema: 'codex',
          },
        ],
      },
      statePath,
      {
        reconciliationTickMs: 20,
        activeReconcileIntervalMs: 20,
        idleReconcileIntervalMs: 20,
      },
    );

    await watcher.start();
    await new Promise(resolve => setTimeout(resolve, 120));
    watcher.stop();

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(ingestCalls.map(call => call.toolResponse)).toEqual(['one', 'one', 'two']);
    expect(state.offsets[transcriptPath]).toBe(Buffer.byteLength(firstLine + secondLine));
  });

  it('reconciles recently active files faster than idle files', async () => {
    const activePath = join(dir, 'active.jsonl');
    const idlePath = join(dir, 'idle.jsonl');
    const statePath = join(dir, 'state.json');
    const firstLine = '{"timestamp":"start"}\n';
    const laterLine = '{"timestamp":"later"}\n';

    writeFileSync(activePath, firstLine);
    writeFileSync(idlePath, firstLine);

    const { TranscriptWatcher } = await import('../../src/services/transcripts/watcher.js');
    const watcher = new TranscriptWatcher(
      {
        version: 1,
        schemas: {
          empty: { name: 'empty', events: [] },
        },
        watches: [
          {
            name: 'codex',
            path: activePath,
            schema: 'empty',
          },
          {
            name: 'codex-idle',
            path: idlePath,
            schema: 'empty',
            startAtEnd: true,
          },
        ],
      },
      statePath,
      {
        reconciliationTickMs: 10,
        activeReconcileIntervalMs: 20,
        idleReconcileIntervalMs: 250,
        activeWindowMs: 1_000,
      },
    );

    await watcher.start();
    await new Promise(resolve => setTimeout(resolve, 30));

    writeFileSync(activePath, firstLine + laterLine);
    writeFileSync(idlePath, firstLine + laterLine);
    await new Promise(resolve => setTimeout(resolve, 90));
    watcher.stop();

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state.offsets[activePath]).toBe(Buffer.byteLength(firstLine + laterLine));
    expect(state.offsets[idlePath]).not.toBe(Buffer.byteLength(firstLine + laterLine));
  });
});

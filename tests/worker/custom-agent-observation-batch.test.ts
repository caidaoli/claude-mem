import { afterEach, describe, expect, it, mock } from 'bun:test';
import { CustomAgent, resolveCustomConfig } from '../../src/services/worker/CustomAgent.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { buildObservationPromptParts, renderObservationPromptJson } from '../../src/sdk/prompts.js';
import { observationFieldMaxChars } from '../../src/services/worker/context-window.js';
import type { PendingMessage, PendingMessageWithId } from '../../src/services/worker-types.js';

const SETTING = 'CLAUDE_MEM_CUSTOM_OBSERVATION_BATCH_SIZE';
const stores: SessionStore[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const originalLoad = SettingsDefaultsManager.loadFromFile;
afterEach(() => {
  SettingsDefaultsManager.loadFromFile = originalLoad;
  mock.restore();
  for (const server of servers.splice(0)) server.stop(true);
  for (const store of stores.splice(0)) store.close();
});

const IMAGE_REF = { id: 'att-1', label: 'event1_image1' } as unknown as NonNullable<PendingMessage['mediaRefs']>[number];

function harness(count: unknown, contextWindowTokens?: number) {
  ModeManager.getInstance().loadMode('code');
  const settings: Record<string, unknown> = { ...SettingsDefaultsManager.getAllDefaults(), [SETTING]: count,
    CLAUDE_MEM_PROVIDER: 'custom', CLAUDE_MEM_CUSTOM_API_URL: 'http://127.0.0.1:1', CLAUDE_MEM_CUSTOM_API_KEY: '',
    CLAUDE_MEM_CUSTOM_MODEL: 'batch-fixture', CLAUDE_MEM_CUSTOM_PROTOCOL: 'openai', CLAUDE_MEM_CUSTOM_STREAMING: 'false',
    CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false', CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
  };
  SettingsDefaultsManager.loadFromFile = (() => settings) as unknown as typeof originalLoad;
  const store = new SessionStore(':memory:');
  stores.push(store);
  const sessionDbId = store.createSDKSession('batch-session', 'batch-project', 'inspect files');
  store.ensureMemorySessionIdRegistered(sessionDbId, 'batch-memory');
  const manager = new SessionManager(null as any);
  const session: any = { sessionDbId, contentSessionId: 'batch-session', memorySessionId: 'batch-memory',
    project: 'batch-project', platformSource: 'claude', abortController: new AbortController(),
    claimedMessageIds: [], earliestPendingTimestamp: null, conversationHistory: [], lastPromptNumber: 1,
    cumulativeInputTokens: 0, cumulativeOutputTokens: 0, observerContextWindowTokens: contextWindowTokens };
  (manager as any).sessions.set(sessionDbId, session);
  const buffer = manager.getMessageBuffer();
  const db = { getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null };
  const provider: any = new CustomAgent(db as any, manager);
  provider.conversationMaxChars = () => 1_000_000;
  const enqueue = (overrides: Partial<PendingMessage> = {}, timestamp = 1_700_000_000_000) => buffer.enqueue(sessionDbId, {
    type: 'observation', tool_name: 'Read', tool_input: { file_path: 'file.ts' }, tool_response: 'file contents',
    prompt_number: 1, cwd: '/batch-project', ...overrides,
  }, timestamp);
  const first = () => manager.claimNextObservation(sessionDbId, () => true)!;
  const parts = (m: PendingMessageWithId) => buildObservationPromptParts({ id: m._persistentId,
    tool_name: m.tool_name!, tool_input: JSON.stringify(m.tool_input), tool_output: JSON.stringify(m.tool_response),
    created_at_epoch: m._originalTimestamp, cwd: m.cwd }, observationFieldMaxChars(contextWindowTokens));
  const render = (m: PendingMessageWithId) => provider.observationTurnPrompt(session, m, parts(m), provider.getMode()) as string;
  const single = (m: PendingMessageWithId) => renderObservationPromptJson(parts(m), provider.getMode());
  const process = (m: PendingMessageWithId) => provider.processObservationMessage(session, m, undefined, resolveCustomConfig(),
    m._originalTimestamp, m.cwd, provider.getMode());
  return { settings, manager, session, buffer, store, provider, enqueue, first, render, single, process };
}

describe('Custom observation batching', () => {
  it('defaults to one event per request', () => {
    expect(SettingsDefaultsManager.getAllDefaults()[SETTING]).toBe('1');
  });

  for (const count of [undefined, '1', '0', '33', 'invalid']) {
    it(`keeps the single-event JSON prompt for batch size ${count}`, () => {
      const h = harness(count);
      h.enqueue(); h.enqueue();
      const first = h.first();
      expect(h.render(first)).toBe(h.single(first));
      expect(h.session.claimedMessageIds).toEqual([first._persistentId]);
    });
  }

  it('claims the configured number in FIFO order and asks for an observations array', () => {
    const h = harness('2');
    const ids = Array.from({ length: 3 }, (_, i) => h.enqueue({ tool_response: `event-${i}` }, 1_700_000_000_000 + i * 1000));
    const prompt = h.render(h.first());
    expect(h.session.claimedMessageIds).toEqual(ids.slice(0, 2));
    expect(prompt.indexOf('event-0')).toBeLessThan(prompt.indexOf('event-1'));
    expect(prompt).not.toContain('event-2');
    expect(prompt).toContain('2023-11-14T22:13:21.000Z');
    expect(prompt).toContain('{"observations":[...]}');
  });

  it('does not cross a FIFO barrier', () => {
    const h = harness('4'); const id = h.enqueue();
    h.enqueue({ prompt_number: 2 }); h.enqueue();
    h.render(h.first());
    expect(h.session.claimedMessageIds).toEqual([id]);
  });

  it('keeps an image event as a turn of its own', () => {
    const h = harness('4');
    h.enqueue({ mediaRefs: [IMAGE_REF], mediaEventKey: 'event-key-1' }); h.enqueue();
    const first = h.first();
    expect(h.render(first)).toBe(h.single(first));
    expect(h.session.claimedMessageIds).toEqual([first._persistentId]);

    const g = harness('4');
    const id = g.enqueue(); g.enqueue({ mediaRefs: [IMAGE_REF], mediaEventKey: 'event-key-2' }); g.enqueue();
    g.render(g.first());
    expect(g.session.claimedMessageIds).toEqual([id]);
    expect(g.buffer.getPendingCount(g.session.sessionDbId)).toBe(3);
  });

  it('ends the batch at the model-window character budget', () => {
    const fieldMaxChars = observationFieldMaxChars(10_000);
    const h = harness('32', 10_000);
    const ids = Array.from({ length: 4 }, () => h.enqueue({ tool_response: 'x'.repeat(Math.floor(fieldMaxChars * 0.8)) }));
    h.render(h.first());
    expect(h.session.claimedMessageIds).toEqual(ids.slice(0, 2));
  });

  it('confirms exactly the included batch after a JSON skip', async () => {
    const h = harness('2'); const ids = [h.enqueue(), h.enqueue(), h.enqueue()];
    h.provider.query = async () => ({ content: '{"skip":true}' });
    await h.process(h.first());
    expect(h.buffer.getMessagesByIds(h.session.sessionDbId, ids).map(m => m._persistentId)).toEqual([ids[2]]);
    expect(h.session.claimedMessageIds).toEqual([]);
  });

  it('stores the same eight observations with 2 HTTP requests instead of 8', async () => {
    const runs: Array<{ requests: number; titles: string[] }> = [];
    for (const size of ['1', '4']) {
      const h = harness(size);
      const requests: number[][] = [];
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        const events = [...body.messages.at(-1)!.content.matchAll(/batch-event-(\d+)/g)].map(match => Number(match[1]));
        requests.push(events);
        const content = JSON.stringify({ observations: events.map(id => ({ type: 'discovery', title: `event-${id}`,
          narrative: `Fixture finding ${id}`, facts: [`Finding ${id}`], concepts: ['how-it-works'] })) });
        return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
      } });
      servers.push(server);
      h.settings.CLAUDE_MEM_CUSTOM_API_URL = `http://127.0.0.1:${server.port}`;
      for (let i = 0; i < 8; i++) h.enqueue({ tool_input: { file_path: `src/file-${i}.ts` }, tool_response: `batch-event-${i}` });
      while (h.buffer.getPendingCount(h.session.sessionDbId) > 0) await h.process(h.first());
      expect(requests.flat()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      const rows = h.store.db.prepare('SELECT title, project, prompt_number, files_read FROM observations ORDER BY id')
        .all() as Array<{ title: string; project: string; prompt_number: number; files_read: string }>;
      expect(rows).toHaveLength(8);
      expect(rows.every(row => row.project === 'batch-project' && row.prompt_number === 1)).toBe(true);
      expect(new Set(rows.flatMap(row => JSON.parse(row.files_read)))).toEqual(new Set(Array.from({ length: 8 }, (_, i) => `src/file-${i}.ts`)));
      runs.push({ requests: requests.length, titles: rows.map(row => row.title) });
    }
    expect(runs[0].requests).toBe(8);
    expect(runs[1].requests).toBe(2);
    expect(runs[1].titles).toEqual(runs[0].titles);
  });
});

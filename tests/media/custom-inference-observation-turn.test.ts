// Custom provider image input end to end: real ingest capture, real SQLite,
// real MediaStore derivatives and the real response processor, with HTTP
// mocked at fetch. Scratch files live in the gitignored .scratch directory.
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { MediaStore } from '../../src/services/media/store.js';
import { ingestObservation, setIngestContext } from '../../src/services/worker/http/shared.js';
import { CustomAgent, resolveCustomConfig } from '../../src/services/worker/CustomAgent.js';
import { __resetContextWindowCacheForTests } from '../../src/services/worker/context-window.js';
import { __resetMediaCapabilityCacheForTests } from '../../src/services/worker/media-capability.js';
import { resetKeyPoolStateForTesting } from '../../src/shared/api-key-pool.js';
import { resetReasoningFieldRejectionsForTesting } from '../../src/services/worker/reasoning-budget.js';
import { resetStreamingEndpointMemoryForTests } from '../../src/services/worker/streamed-chat-completion.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import * as EnvManager from '../../src/shared/EnvManager.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { logger } from '../../src/utils/logger.js';
import type { ActiveSession, PendingMessageWithId } from '../../src/services/worker-types.js';

type Protocol = 'openai' | 'gemini' | 'codex';
type Part = { text: string } | { image: string };

const SCRATCH = join(import.meta.dir, '../../.scratch');
const RED = { r: 220, g: 30, b: 40 };
const BLUE = { r: 20, g: 60, b: 210 };
let redPng: string;
let bluePng: string;

let dir: string;
let db: Database;
let sessions: SessionStore;
let media: MediaStore;
let queued: any[];
let settings: Record<string, string>;
let spies: ReturnType<typeof spyOn>[];
let originalFetch: typeof fetch;
let requests: Array<{ url: string; body: any }>;
let replies: Array<() => Response>;

beforeAll(async () => {
  const make = (color: typeof RED) => sharp({ create: { width: 320, height: 180, channels: 3, background: color } }).png().toBuffer();
  redPng = (await make(RED)).toString('base64');
  bluePng = (await make(BLUE)).toString('base64');
  ModeManager.getInstance().loadMode('code');
});

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  dir = realpathSync(mkdtempSync(join(SCRATCH, 'custom-media-')));
  mkdirSync(join(dir, 'project'));
  db = new Database(':memory:');
  sessions = new SessionStore(db);
  media = new MediaStore(db, join(dir, 'data'));
  queued = [];
  settings = {
    ...SettingsDefaultsManager.getAllDefaults(),
    CLAUDE_MEM_SKIP_TOOLS: '',
    CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'true',
    CLAUDE_MEM_MEDIA_INFERENCE_ENABLED: 'true',
    CLAUDE_MEM_PROVIDER: 'custom',
    CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
    CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
    CLAUDE_MEM_CUSTOM_MODEL: 'vision-model',
    CLAUDE_MEM_CUSTOM_PROTOCOL: 'openai',
    CLAUDE_MEM_CUSTOM_STREAMING: 'false',
    CLAUDE_MEM_CUSTOM_IMAGE_INPUT: 'true',
    CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
    CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
  };
  spies = [
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => settings as never),
    spyOn(EnvManager, 'getCredential').mockImplementation(() => undefined),
    ...(['info', 'debug', 'warn', 'error', 'success', 'failure'] as const)
      .map(level => spyOn(logger, level as never).mockImplementation((() => {}) as never)),
  ];
  __resetContextWindowCacheForTests();
  __resetMediaCapabilityCacheForTests();
  resetKeyPoolStateForTesting();
  resetReasoningFieldRejectionsForTesting();
  resetStreamingEndpointMemoryForTests();
  requests = [];
  replies = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected call to ${url}`);
    return reply();
  }) as typeof fetch;
  setIngestContext({
    dbManager: { getSessionStore: () => sessions, getMediaStore: () => media } as any,
    sessionManager: { queueObservation: async (_id: number, observation: any) => { queued.push(observation); } } as any,
    eventBroadcaster: { broadcastObservationQueued: () => {} } as any,
    ensureGeneratorRunning: async () => {},
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  spies.forEach(spy => spy.mockRestore());
  resetKeyPoolStateForTesting();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function ingest(toolUseId: string, ...images: string[]) {
  return ingestObservation({
    contentSessionId: 'media-session', toolName: 'mcp__browser__screenshot', toolInput: { action: 'screenshot' },
    toolResponse: { content: [
      { type: 'text', text: 'Took screenshots of the viewport.' },
      ...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })),
    ] },
    cwd: join(dir, 'project'), platformSource: 'claude', toolUseId,
  } as any);
}

function makeSession(): ActiveSession {
  const id = (db.prepare(`SELECT id FROM sdk_sessions WHERE content_session_id='media-session'`).get() as { id: number }).id;
  sessions.updateMemorySessionId(id, 'custom-media-session-1');
  return {
    sessionDbId: id, contentSessionId: 'media-session', memorySessionId: 'custom-media-session-1',
    project: 'project', platformSource: 'claude', userPrompt: 'look at the UI',
    abortController: new AbortController(), generatorPromise: null, lastPromptNumber: 1, startTime: Date.now(),
    cumulativeInputTokens: 0, cumulativeOutputTokens: 0, earliestPendingTimestamp: null, claimedMessageIds: [1],
    conversationHistory: [
      { role: 'user', content: 'Start observing the primary session.' },
      { role: 'assistant', content: '{"skip":true}' },
    ],
    currentProvider: 'custom', consecutiveRestarts: 0, lastGeneratorActivity: Date.now(),
  } as unknown as ActiveSession;
}

async function runTurn() {
  const message: PendingMessageWithId = { ...queued[0], type: 'observation', _persistentId: 1, _originalTimestamp: Date.now() };
  const dbManager = { getSessionStore: () => sessions, getMediaStore: () => media, getChromaSync: () => null, getCloudSync: () => null };
  const sessionManager = {
    getClaimedMessages: () => [message],
    confirmClaimedMessages: async () => 1,
    resetProcessingToPending: async () => 0,
  };
  const agent: any = new CustomAgent(dbManager as any, sessionManager as any);
  const session = makeSession();
  await agent.processObservationMessage(session, message, undefined, resolveCustomConfig(), message._originalTimestamp,
    join(dir, 'project'), agent.getMode());
  return session;
}

/** A successful reply in the protocol's own response shape. */
function reply(protocol: Protocol, content: string): () => Response {
  const body = protocol === 'gemini'
    ? { candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 5, totalTokenCount: 12 } }
    : protocol === 'codex'
      ? { status: 'completed', output: [{ content: [{ type: 'output_text', text: content }] }], usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 } }
      : { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } };
  return () => new Response(JSON.stringify(body), { status: 200 });
}
const failure = (status: number, message: string) => () =>
  new Response(JSON.stringify({ error: { code: status, message } }), { status });

/** The request's earlier turns, and its final turn as protocol-neutral parts. */
function turns(protocol: Protocol, body: any): { earlierTextOnly: boolean; finalRole: string; parts: Part[] } {
  if (protocol === 'gemini') {
    const contents = body.contents as Array<{ role: string; parts: any[] }>;
    return {
      earlierTextOnly: contents.slice(0, -1).every(turn => turn.parts.every(part => typeof part.text === 'string')),
      finalRole: contents.at(-1)!.role,
      parts: contents.at(-1)!.parts.map(part => part.inlineData
        ? { image: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` } : { text: part.text }),
    };
  }
  if (protocol === 'codex') {
    const input = body.input as Array<{ role: string; content: any[] }>;
    return {
      earlierTextOnly: input.slice(0, -1).every(turn => turn.content.every(part => part.type !== 'input_image')),
      finalRole: input.at(-1)!.role,
      parts: input.at(-1)!.content.map(part => part.type === 'input_image' ? { image: part.image_url } : { text: part.text }),
    };
  }
  const messages = body.messages as Array<{ role: string; content: any }>;
  const last = messages.at(-1)!;
  return {
    earlierTextOnly: messages.slice(0, -1).every(turn => typeof turn.content === 'string'),
    finalRole: last.role,
    parts: typeof last.content === 'string' ? [{ text: last.content }]
      : last.content.map((part: any) => part.type === 'image_url' ? { image: part.image_url.url } : { text: part.text }),
  };
}

async function pixel(dataUrl: string): Promise<number[]> {
  expect(dataUrl.startsWith('data:image/webp;base64,')).toBe(true);
  const { data } = await sharp(Buffer.from(dataUrl.slice('data:image/webp;base64,'.length), 'base64')).raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
}
const near = (actual: number[], expected: typeof RED) =>
  Math.abs(actual[0] - expected.r) <= 6 && Math.abs(actual[1] - expected.g) <= 6 && Math.abs(actual[2] - expected.b) <= 6;

const rows = (sql: string) => db.prepare(sql).all() as any[];
const links = () => rows('SELECT label, inspection FROM observation_media_links ORDER BY observation_id, label');
const observation = (title: string, attachments?: string[]) =>
  ({ type: 'discovery', title, narrative: `${title} in the viewport.`, facts: [title], concepts: ['how-it-works'], ...(attachments ? { attachments } : {}) });

const PROTOCOLS: Protocol[] = ['openai', 'gemini', 'codex'];

describe('Custom image input', () => {
  for (const protocol of PROTOCOLS) {
    it(`${protocol}: sends the turn's images in the native shape on the final user turn only and links them`, async () => {
      settings.CLAUDE_MEM_CUSTOM_PROTOCOL = protocol;
      await ingest('toolu_two', redPng, bluePng);
      replies.push(reply(protocol, JSON.stringify(observation('Viewport'))));

      const session = await runTurn();

      expect(requests).toHaveLength(1);
      const { earlierTextOnly, finalRole, parts } = turns(protocol, requests[0].body);
      expect(earlierTextOnly).toBe(true);
      expect(finalRole).toBe('user');
      expect(parts.map(part => 'image' in part ? 'image' : 'text')).toEqual(['text', 'text', 'text', 'image', 'text', 'image']);
      const text = (index: number) => (parts[index] as { text: string }).text;
      expect(text(0)).toContain('Took screenshots of the viewport.');
      expect(text(1)).toBe('Images attached to this turn: event1_image1, event1_image2. Each image follows a line [image LABEL]. In each observation informed by an image, list its label in that observation\'s "attachments" array, for example "attachments":["event1_image1"]. Use only these labels.');
      expect(text(2)).toBe('[image event1_image1]');
      expect(text(4)).toBe('[image event1_image2]');
      expect(near(await pixel((parts[3] as { image: string }).image), RED)).toBe(true);
      expect(near(await pixel((parts[5] as { image: string }).image), BLUE)).toBe(true);
      expect(JSON.stringify(requests[0].body)).not.toContain(redPng.slice(0, 48));

      for (const turn of session.conversationHistory) {
        expect(typeof turn.content).toBe('string');
        expect(turn.content).not.toContain('data:image');
      }
      // One observation, one event, no attachments array: every delivered image informed it.
      expect(links()).toEqual([
        { label: 'event1_image1', inspection: 'inspected' },
        { label: 'event1_image2', inspection: 'inspected' },
      ]);
      expect(rows('SELECT result_state FROM media_events')).toEqual([{ result_state: 'stored' }]);
    });
  }

  it('links each observation to the images its JSON attachments array names', async () => {
    await ingest('toolu_two', redPng, bluePng);
    replies.push(reply('openai', JSON.stringify({ observations: [
      observation('Red header', ['event1_image1']),
      observation('Blue footer', ['event1_image2', 'not_a_label']),
    ] })));
    await runTurn();
    const stored = rows('SELECT o.title, l.label FROM observation_media_links l JOIN observations o ON o.id = l.observation_id ORDER BY o.id');
    expect(stored).toEqual([{ title: 'Red header', label: 'event1_image1' }, { title: 'Blue footer', label: 'event1_image2' }]);
  });

  for (const [name, overrides] of [
    ['image input is off', { CLAUDE_MEM_CUSTOM_IMAGE_INPUT: 'false' }],
    ['media inference is off', { CLAUDE_MEM_MEDIA_INFERENCE_ENABLED: 'false' }],
  ] as const) {
    it(`sends today's text-only request and keeps an uninspected link when ${name}`, async () => {
      Object.assign(settings, overrides);
      await ingest('toolu_off', redPng);
      replies.push(reply('openai', JSON.stringify(observation('Viewport', ['event1_image1']))));
      await runTurn();
      expect(requests).toHaveLength(1);
      expect(requests[0].body.messages.every((turn: { content: unknown }) => typeof turn.content === 'string')).toBe(true);
      expect(links()).toEqual([{ label: 'event1_image1', inspection: 'uninspected' }]);
      expect(rows('SELECT result_state FROM media_events')).toEqual([{ result_state: 'stored' }]);
    });
  }

  for (const [protocol, status] of [['openai', 400], ['openai', 413], ['gemini', 400], ['codex', 400]] as const) {
    it(`${protocol}: a ${status} refusal of the image request resends the turn once text-only and keeps an uninspected link`, async () => {
      settings.CLAUDE_MEM_CUSTOM_PROTOCOL = protocol;
      await ingest('toolu_refused', redPng);
      replies.push(failure(status, 'Invalid content: image input is not supported for this model'));
      replies.push(reply(protocol, JSON.stringify(observation('Viewport', ['event1_image1']))));

      await runTurn();

      expect(requests).toHaveLength(2);
      expect(turns(protocol, requests[0].body).parts.some(part => 'image' in part)).toBe(true);
      const resend = turns(protocol, requests[1].body);
      expect(resend.parts).toHaveLength(1);
      expect(JSON.stringify(requests[1].body)).not.toContain('data:image');
      expect(links()).toEqual([{ label: 'event1_image1', inspection: 'uninspected' }]);
      expect(rows('SELECT title FROM observations')).toEqual([{ title: 'Viewport' }]);
      expect(rows('SELECT result_state FROM media_events')).toEqual([{ result_state: 'stored' }]);
    });
  }

  it('does not resend text-only when the image request fails for a reason other than its shape', async () => {
    await ingest('toolu_auth', redPng);
    replies.push(failure(401, 'invalid api key'));
    await runTurn().catch(() => {});
    expect(requests).toHaveLength(1);
    expect(links()).toEqual([]);
  });
});

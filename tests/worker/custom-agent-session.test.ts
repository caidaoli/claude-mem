import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';

import { CustomAgent, isCustomAvailable } from '../../src/services/worker/CustomAgent.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import * as EnvManager from '../../src/shared/EnvManager.js';
import * as contextGenerator from '../../src/services/context-generator.js';
import { resetReasoningFieldRejectionsForTesting } from '../../src/services/worker/reasoning-budget.js';
import { resetStreamingEndpointMemoryForTests } from '../../src/services/worker/streamed-chat-completion.js';
import { PaidSendBudget } from '../../src/services/worker/paid-send-budget.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';

const mockMode = {
  name: 'code',
  prompts: {
    system_identity: 'You are observer',
    observer_role: 'Observe tool usage',
    spatial_awareness: 'Use cwd context',
    recording_focus: 'Record meaningful changes',
    skip_guidance: 'Skip noise',
    language_instruction: 'LANGUAGE REQUIREMENTS: Please write the observation data in Bahasa Indonesia',
    footer: 'footer',
    header_memory_start: 'MEMORY_START',
    continuation_greeting: 'CONTINUE',
    continuation_instruction: 'continue observing',
    header_memory_continued: 'MEMORY_CONTINUED',
    output_format_header: 'XML OUTPUT',
    format_examples: '',
    type_guidance: 'type guidance',
    field_guidance: 'field guidance',
    concept_guidance: 'concept guidance',
    xml_title_placeholder: 'title',
    xml_subtitle_placeholder: 'subtitle',
    xml_fact_placeholder: 'fact',
    xml_narrative_placeholder: 'narrative',
    xml_concept_placeholder: 'concept',
    xml_file_placeholder: 'file',
    header_summary_checkpoint: 'summary checkpoint',
    summary_instruction: 'summary instruction',
    summary_context_label: 'summary context',
    summary_format_instruction: 'summary format',
    summary_footer: 'summary footer',
    xml_summary_request_placeholder: 'request',
    xml_summary_investigated_placeholder: 'investigated',
    xml_summary_learned_placeholder: 'learned',
    xml_summary_completed_placeholder: 'completed',
    xml_summary_next_steps_placeholder: 'next_steps',
    xml_summary_notes_placeholder: 'notes'
  },
  observation_types: [{ id: 'discovery', description: '发现' }],
  observation_concepts: []
} as any;

function createSession() {
  return {
    sessionDbId: 1,
    contentSessionId: 'content-1',
    memorySessionId: 'mem-custom-1',
    project: 'proj',
    userPrompt: '请分析代码',
    pendingMessages: [],
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    conversationHistory: [],
    currentProvider: null,
    processingMessageIds: [],
    claimedMessageIds: [],
    lastUsage: null
  } as any;
}

const observation = JSON.stringify({ type: 'discovery', title: 'ok', narrative: 'n', files_read: [], files_modified: [], concepts: [] });
const toolMessage = { _persistentId: 101, _originalTimestamp: Date.now(), type: 'observation', prompt_number: 2,
  tool_name: 'Read', tool_input: { file: 'a.ts' }, tool_response: { content: 'code' }, cwd: '/tmp/project' };

describe('CustomAgent session behavior', () => {
  const originalFetch = global.fetch;
  let settings: ReturnType<typeof SettingsDefaultsManager.getAllDefaults>;
  let mode: any;
  let credential: string | undefined;
  let requests: Array<{ url: string; body: any; headers: Record<string, string>; signal: AbortSignal }>;
  let replies: Array<Response | ((signal: AbortSignal) => Response | Promise<Response>)>;

  function chat(content = observation, usage: Record<string, number> = { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 }) {
    return new Response(JSON.stringify({ model: 'served-model', choices: [{ message: { content }, finish_reason: 'stop' }], usage }));
  }
  function gemini(content = observation) {
    return new Response(JSON.stringify({ modelVersion: 'served-gemini', candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 5, totalTokenCount: 12 } }));
  }
  function codex(content = observation) {
    return new Response(JSON.stringify({ model: 'served-codex', status: 'completed', output: [{ content: [{ type: 'output_text', text: content }] }],
      usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 } }));
  }
  function sse(events: any[], done = true, contentType = true) {
    const text = events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : '');
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream({ start(controller) {
      // Exercise framing and UTF-8 across byte boundaries.
      for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13));
      controller.close();
    } }), { headers: contentType ? { 'content-type': 'text/event-stream' } : {} });
  }
  function fixture(messages: any[] = [toolMessage]) {
    const session = createSession();
    const storeObservations = mock(() => ({ observationIds: [1], summaryId: null, createdAtEpoch: Date.now() }));
    const updateMemorySessionId = mock(() => {});
    const store = { getSessionById: () => ({ memory_session_id: 'mem-custom-1' }), updateMemorySessionId,
      ensureMemorySessionIdRegistered: () => {}, storeObservations };
    const dbManager = { getSessionStore: () => store, getCloudSync: () => null,
      getChromaSync: () => ({ syncObservation: async () => {}, syncSummary: async () => {} }) } as unknown as DatabaseManager;
    const confirm = mock(async () => { session.claimedMessageIds = []; });
    const resetToPending = mock(() => true);
    const resetProcessingToPending = mock(async () => {});
    const sessionManager = {
      clearPendingForSession: () => {}, confirmClaimedMessages: confirm, resetProcessingToPending,
      getClaimedMessages: () => messages,
      getMessageIterator: async function* () {
        for (const message of messages) {
          session.claimedMessageIds = [message._persistentId ?? 101];
          yield message;
        }
      },
      getPendingMessageStore: () => ({ confirmProcessed: () => {}, resetToPending, resetStaleProcessing: () => {}, getPendingCount: () => 1 }),
    } as unknown as SessionManager;
    return { session, store, storeObservations, updateMemorySessionId, confirm, resetToPending, resetProcessingToPending, agent: new CustomAgent(dbManager, sessionManager) };
  }

  beforeEach(() => {
    settings = { ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key', CLAUDE_MEM_CUSTOM_MODEL: 'gpt-4o', CLAUDE_MEM_CUSTOM_PROTOCOL: 'openai',
      CLAUDE_MEM_CUSTOM_STREAMING: 'false', CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0', CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0', CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0' };
    mode = mockMode;
    credential = undefined;
    requests = [];
    replies = [];
    resetStreamingEndpointMemoryForTests();
    resetReasoningFieldRejectionsForTesting();
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => settings);
    spyOn(ModeManager, 'getInstance').mockImplementation(() => ({ getActiveMode: () => mode, loadMode: () => {} }) as any);
    spyOn(EnvManager, 'getCredential').mockImplementation(key => key === 'CUSTOM_API_KEY' ? credential : undefined);
    spyOn(contextGenerator, 'generateContext').mockResolvedValue('Prior session memory');
    global.fetch = mock(async (url: any, options: any) => {
      requests.push({ url: String(url), body: JSON.parse(options.body), headers: options.headers, signal: options.signal });
      const reply = replies.shift() ?? chat();
      return typeof reply === 'function' ? reply(options.signal) : reply;
    }) as any;
  });
  afterEach(() => { global.fetch = originalFetch; mock.restore(); });

  it('does not send or store a bare init by default', async () => {
    const f = fixture([]);
    await f.agent.startSession(f.session);
    expect(requests).toHaveLength(0);
    expect(f.storeObservations).not.toHaveBeenCalled();
  });
  it('keeps one assistant init turn without storing invented observations when bare prompts are enabled', async () => {
    settings.CLAUDE_MEM_OBSERVE_BARE_PROMPTS = 'true';
    const f = fixture([]);
    await f.agent.startSession(f.session);
    expect(f.session.conversationHistory).toHaveLength(2);
    expect(f.session.conversationHistory[1]).toEqual({ role: 'assistant', content: observation });
    expect(f.storeObservations).not.toHaveBeenCalled();
  });
  it('stores one real observation and records the actual input/output usage', async () => {
    const f = fixture();
    await f.agent.startSession(f.session);
    expect(f.storeObservations).toHaveBeenCalledTimes(1);
    expect(f.session.conversationHistory.filter((message: any) => message.role === 'assistant')).toHaveLength(1);
    expect(f.session.cumulativeInputTokens).toBe(7);
    expect(f.session.cumulativeOutputTokens).toBe(5);
    expect(f.session.lastContextTokens).toBe(7);
    expect(requests[0].body.messages[0].role).toBe('system');
    expect(requests[0].body.messages[0].content).toContain('Prior session memory');
  });
  it('does not fabricate usage from a total-only response', async () => {
    replies.push(chat(observation, { total_tokens: 12 }));
    const f = fixture();
    await f.agent.startSession(f.session);
    expect(f.session.lastUsage).toBeNull();
    // Shared historical totals retain their documented estimate; event usage stays unknown.
    expect(f.session.lastContextTokens).toBeUndefined();
  });
  it('restores the persisted memory FK over a stale fallback id', async () => {
    const f = fixture();
    f.session.memorySessionId = 'wrong-fallback';
    await f.agent.startSession(f.session);
    expect(f.session.memorySessionId).toBe('mem-custom-1');
    expect(f.storeObservations.mock.calls[0][0]).toBe('mem-custom-1');
  });
  it('uses CUSTOM_API_KEY credential fallback and allows keyless local servers', async () => {
    settings.CLAUDE_MEM_CUSTOM_API_KEY = '';
    credential = 'fallback-key';
    expect(isCustomAvailable()).toBe(true);
    const f = fixture();
    await f.agent.startSession(f.session);
    expect(requests[0].headers.Authorization).toBe('Bearer fallback-key');
    requests.length = 0;
    credential = undefined;
    settings.CLAUDE_MEM_CUSTOM_API_URL = 'http://localhost:11434';
    expect(isCustomAvailable()).toBe(true);
    const local = fixture();
    await local.agent.startSession(local.session);
    expect(requests[0].headers.Authorization).toBeUndefined();
    settings.CLAUDE_MEM_CUSTOM_API_URL = 'https://hosted.example.com';
    expect(isCustomAvailable()).toBe(false);
  });
  it('keeps the original Session_id and prompt_cache_key across requests', async () => {
    const f = fixture([toolMessage, { ...toolMessage, _persistentId: 102 }]);
    await f.agent.startSession(f.session);
    expect(requests.map(request => request.headers.Session_id)).toEqual(['content-1', 'content-1']);
    expect(requests.map(request => request.body.prompt_cache_key)).toEqual(['content-1', 'content-1']);
  });
  it('generates a request session id when contentSessionId is blank', async () => {
    const f = fixture([toolMessage, { ...toolMessage, _persistentId: 102 }]);
    f.session.contentSessionId = ' ';
    await f.agent.startSession(f.session);
    expect(requests[0].headers.Session_id).toMatch(/^custom-/);
    expect(requests[0].body.prompt_cache_key).toBe(requests[0].headers.Session_id);
    expect(requests[1].headers.Session_id).toBe(requests[0].headers.Session_id);
  });
  for (const [model, expected] of [['gpt-4o', { reasoning_effort: 'low' }], ['mimo-v2', { thinking: { type: 'disabled' } }],
    ['gemini-3.5-flash', { thinkingConfig: { thinkingLevel: 'low' } }], ['claude-proxy', {}]] as const) {
    it(`preserves model-specific tuning for ${model}`, async () => {
      settings.CLAUDE_MEM_CUSTOM_MODEL = model;
      const f = fixture();
      await f.agent.startSession(f.session);
      expect(requests[0].body).toMatchObject(expected);
      expect(requests[0].body.reasoning).toEqual({ enabled: false });
      if (model === 'claude-proxy') expect(requests[0].body.reasoning_effort).toBeUndefined();
    });
  }
  it('negotiates unknown reasoning and streaming parameters only after explicit refusals', async () => {
    settings.CLAUDE_MEM_CUSTOM_STREAMING = 'true';
    replies.push(new Response(JSON.stringify({ error: { message: "Unknown parameter: reasoning" } }), { status: 400 }),
      new Response(JSON.stringify({ error: { message: "Unknown parameter: stream_options" } }), { status: 400 }), chat());
    const f = fixture();
    await f.agent.startSession(f.session);
    expect(requests).toHaveLength(3);
    expect(requests[0].body.reasoning).toEqual({ enabled: false });
    expect(requests[1].body.reasoning).toBeUndefined();
    expect(requests[2].body.stream).toBeUndefined();
    expect(f.session.paidSendBudget.spentPaidSends).toBe(1);
  });
  it('uses max_completion_tokens when the endpoint explicitly refuses max_tokens', async () => {
    replies.push(new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }), { status: 400 }), chat());
    const f = fixture();
    await f.agent.startSession(f.session);
    expect(requests[1].body.max_completion_tokens).toBeGreaterThan(0);
    expect(requests[1].body.max_tokens).toBeUndefined();
  });
  for (const protocol of ['gemini', 'codex'] as const) {
    it(`supports ${protocol} non-stream replies, real usage, and the common output cap`, async () => {
      settings.CLAUDE_MEM_CUSTOM_PROTOCOL = protocol;
      settings.CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS = '8192';
      settings.CLAUDE_MEM_CUSTOM_MODEL = protocol === 'gemini' ? 'models/gemini-3.5-flash' : 'gpt-5.4';
      replies.push(protocol === 'gemini' ? gemini() : codex());
      const f = fixture();
      await f.agent.startSession(f.session);
      expect(f.session.cumulativeInputTokens).toBe(7);
    expect(f.session.cumulativeOutputTokens).toBe(5);
      expect(f.storeObservations).toHaveBeenCalledTimes(1);
      expect(requests[0].headers.Session_id).toBe('content-1');
      if (protocol === 'gemini') {
        expect(requests[0].url).toContain('/v1beta/models/gemini-3.5-flash:generateContent');
        expect(requests[0].body.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: 'low' }, maxOutputTokens: 8192, responseMimeType: 'application/json' });
        expect(requests[0].body.systemInstruction.parts[0].text).toContain('Prior session memory');
      } else {
        expect(requests[0].url).toBe('https://custom.example.com/v1/responses');
        expect(requests[0].body.max_output_tokens).toBe(8192);
        expect(requests[0].body.text.format.type).toBe('json_object');
      }
    });
    for (const streaming of [true, false]) it(`parses ${protocol} SSE across chunk boundaries with streaming=${streaming}`, async () => {
      settings.CLAUDE_MEM_CUSTOM_PROTOCOL = protocol;
      settings.CLAUDE_MEM_CUSTOM_STREAMING = String(streaming);
      replies.push(protocol === 'gemini' ? sse([
        { candidates: [{ content: { parts: [{ thought: true, text: 'hidden reasoning' }, { text: observation, thoughtSignature: 'signature' }] } }] },
        { candidates: [{ finishReason: 'STOP' }], modelVersion: 'served-gemini', usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 5, totalTokenCount: 12 } },
      ], false, streaming) : sse([
        { type: 'response.reasoning_summary_text.delta', delta: 'hidden reasoning' },
        { type: 'response.output_text.delta', delta: observation.slice(0, 30) },
        { type: 'response.output_text.delta', delta: observation.slice(30) },
        { type: 'response.completed', response: { status: 'completed', model: 'served-codex', usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 } } },
      ], false, streaming));
      const f = fixture();
      await f.agent.startSession(f.session);
      expect(f.session.cumulativeInputTokens).toBe(7);
    expect(f.session.cumulativeOutputTokens).toBe(5);
      expect(f.storeObservations).toHaveBeenCalledTimes(1);
      expect(f.session.conversationHistory.at(-1).content).toBe(observation);
    });
    it(`preserves ${protocol} visible text carrying thought metadata and drops reasoning output`, async () => {
      settings.CLAUDE_MEM_CUSTOM_PROTOCOL = protocol;
      replies.push(protocol === 'gemini' ? new Response(JSON.stringify({ candidates: [{ content: { parts: [
        { text: 'hidden', thought: true }, { text: observation, thoughtSignature: 'signature' },
      ] } }] })) : new Response(JSON.stringify({ output: [{ content: [
        { type: 'reasoning_text', text: 'hidden' }, { type: 'output_text', text: observation },
      ] }] })));
      const f = fixture();
      await f.agent.startSession(f.session);
      expect(f.session.conversationHistory.at(-1).content).toBe(observation);
    });
  }
  for (const streaming of [true, false]) for (const contentType of [true, false]) it(`parses OpenAI SSE across chunks with streaming=${streaming}, contentType=${contentType}`, async () => {
    settings.CLAUDE_MEM_CUSTOM_STREAMING = String(streaming);
    replies.push(sse([{ choices: [{ delta: { reasoning_content: 'hidden', content: observation.slice(0, 30) } }] },
      { choices: [{ delta: { content: observation.slice(30) }, finish_reason: 'stop' }], model: 'served-model', usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } }], true, contentType));
    const f = fixture();
    await f.agent.startSession(f.session);
    expect(f.session.cumulativeInputTokens).toBe(7);
    expect(f.session.cumulativeOutputTokens).toBe(5);
    expect(f.session.conversationHistory.at(-1).content).toBe(observation);
  });
  it('keeps every Custom prompt in Chinese and fixes the mode for one generation', async () => {
    const f = fixture([toolMessage, { ...toolMessage, _persistentId: 102 }, { type: 'summarize', _persistentId: 103 }]);
    const startedMode = { ...mockMode, prompts: { ...mockMode.prompts, field_guidance: 'mode A fields' } };
    mode = startedMode;
    replies.push(() => { mode = { ...mockMode, prompts: { ...mockMode.prompts, field_guidance: 'mode B fields' } }; return chat(); }, chat(),
      chat(JSON.stringify({ request: '请求', investigated: '调查', learned: '了解', completed: '完成', next_steps: '后续', notes: null })));
    await f.agent.startSession(f.session);
    const prompts = requests.map(request => JSON.stringify(request.body));
    expect(prompts.join('')).not.toContain('Bahasa Indonesia');
    expect(prompts[0]).toContain('中文');
    expect(prompts[1]).toContain('mode A fields');
    expect(prompts[1]).not.toContain('mode B fields');
    expect(prompts[2]).toContain('ALL summary content');
    expect(prompts[2]).toContain('中文');
  });
  it('processes empty observation responses through the queue recovery path', async () => {
    replies.push(chat(''));
    const f = fixture();
    await f.agent.startSession(f.session);
    expect(f.storeObservations).not.toHaveBeenCalled();
    expect(f.resetProcessingToPending).toHaveBeenCalledTimes(1);
    expect(f.session.abortReason).toBe('output_retry:idle');
  });
  for (const protocol of ['openai', 'gemini', 'codex'] as const) {
    it(`classifies ${protocol} quota without resending paid work`, async () => {
      settings.CLAUDE_MEM_CUSTOM_PROTOCOL = protocol;
      replies.push(new Response(JSON.stringify({ error: { code: 429, message: 'quota exceeded',
        ...(protocol === 'gemini' ? { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', description: 'daily quota' }] }] } : {}),
      } }), { status: 200 }));
      const f = fixture();
      await expect(f.agent.startSession(f.session)).rejects.toMatchObject({ kind: 'quota_exhausted' });
      expect(requests).toHaveLength(1);
      expect(f.session.abortReason).toBe('quota:quota_exhausted');
    });
    it(`does not resend malformed ${protocol} output`, async () => {
      settings.CLAUDE_MEM_CUSTOM_PROTOCOL = protocol;
      replies.push(new Response('<html>upstream failure</html>'));
      const f = fixture();
      await f.agent.startSession(f.session);
      expect(requests).toHaveLength(1);
    });
    it(`does not resend an interrupted ${protocol} stream after output started`, async () => {
      settings.CLAUDE_MEM_CUSTOM_PROTOCOL = protocol;
      settings.CLAUDE_MEM_CUSTOM_STREAMING = 'true';
      replies.push(sse([protocol === 'openai' ? { choices: [{ delta: { content: '{"type":' } }] }
        : protocol === 'gemini' ? { candidates: [{ content: { parts: [{ thought: true, text: 'thinking' }] } }] }
          : { type: 'response.output_text.delta', delta: '{"type":' }], false));
      const f = fixture();
      await f.agent.startSession(f.session);
      expect(requests).toHaveLength(1);
    });
  }
  it('rotates a refused key without charging a second paid send', async () => {
    settings.CLAUDE_MEM_CUSTOM_API_KEY = 'rotation-primary';
    settings.CLAUDE_MEM_CUSTOM_API_KEYS = 'rotation-secondary';
    replies.push(new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 }), chat());
    const f = fixture();
    await f.agent.startSession(f.session);
    expect(requests.map(request => request.headers.Authorization)).toEqual(['Bearer rotation-primary', 'Bearer rotation-secondary']);
    expect(f.session.paidSendBudget.spentPaidSends).toBe(1);
  });
  it('honors session cancellation during a body read', async () => {
    const f = fixture();
    replies.push(signal => new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      setTimeout(() => f.session.abortController.abort(), 5);
    } })));
    await expect(f.agent.startSession(f.session)).rejects.toBeInstanceOf(Error);
    expect(requests).toHaveLength(1);
    expect(requests[0].signal.aborted).toBe(true);
    expect(f.storeObservations).not.toHaveBeenCalled();
  });
  for (const protocol of ['openai', 'gemini', 'codex'] as const) {
    it(`times out ${protocol} before its first body chunk without blindly resending`, async () => {
      settings.CLAUDE_MEM_CUSTOM_PROTOCOL = protocol;
      settings.CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT = '1';
      settings.CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT = '10';
      replies.push(signal => new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      } })));
      const f = fixture();
      if (protocol === 'openai') await f.agent.startSession(f.session);
      else await expect(f.agent.startSession(f.session)).rejects.toMatchObject({ kind: 'transient' });
      expect(requests).toHaveLength(1);
      expect(f.storeObservations).not.toHaveBeenCalled();
    });
  }
  for (const protocol of ['openai', 'gemini', 'codex'] as const) it(`formats Telegram through ${protocol} without forcing JSON`, async () => {
    settings.CLAUDE_MEM_CUSTOM_PROTOCOL = protocol;
    replies.push(protocol === 'openai' ? chat('Telegram 中文总结') : protocol === 'gemini' ? gemini('Telegram 中文总结') : codex('Telegram 中文总结'));
    const f = fixture();
    expect(await f.agent.formatTelegramWrapup({ summaryText: 'done' } as any)).toBe('Telegram 中文总结');
    const body = requests[0].body;
    expect(body.response_format).toBeUndefined();
    expect(body.text).toBeUndefined();
    expect(body.generationConfig?.responseMimeType).toBeUndefined();
  });

  for (const protocol of ['openai', 'gemini', 'codex'] as const) it(`generates standalone Chinese human copy through ${protocol} with summary-tier routing`, async () => {
    settings.CLAUDE_MEM_CUSTOM_PROTOCOL = protocol;
    settings.CLAUDE_MEM_TIER_ROUTING_ENABLED = 'true';
    settings.CLAUDE_MEM_TIER_SUMMARY_MODEL = protocol === 'gemini' ? 'gemini-summary' : 'custom-summary';
    const input = { original: { text: '修复付款失败' }, workstreams: [{ id: 'payments' }] };
    const output = { title: '修复付款失败', summary: '正在修复付款失败。', next: '', stage: '', workstreams: [{ id: 'payments', title: '付款', summary: '定位付款问题。' }] };
    const content = JSON.stringify(output);
    replies.push(protocol === 'openai' ? chat(content) : protocol === 'gemini' ? gemini(content) : codex(content));
    const f = fixture();

    expect(await f.agent.generateHumanCopy(input)).toEqual({
      output, usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      model: protocol === 'openai' ? 'served-model' : `served-${protocol}`, responseId: null, error: null,
    });

    expect(requests).toHaveLength(1);
    const { body, url, headers } = requests[0];
    let messages: Array<{ role: string; content: string }>;
    if (protocol === 'gemini') {
      expect(url).toContain('/v1beta/models/gemini-summary:generateContent');
      expect(headers['x-goog-api-key']).toBe('test-key');
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      messages = [{ role: 'system', content: body.systemInstruction.parts.map((part: any) => part.text).join('') },
        ...body.contents.map((message: any) => ({ role: message.role, content: message.parts.map((part: any) => part.text).join('') }))];
    } else if (protocol === 'codex') {
      expect(url).toBe('https://custom.example.com/v1/responses');
      expect(body.model).toBe('custom-summary');
      expect(body.text.format.type).toBe('json_object');
      messages = body.input.map((message: any) => ({ role: message.role, content: message.content.map((part: any) => part.text).join('') }));
    } else {
      expect(url).toBe('https://custom.example.com/v1/chat/completions');
      expect(body.model).toBe('custom-summary');
      expect(body.response_format).toEqual({ type: 'json_object' });
      messages = body.messages;
    }
    expect(messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(messages[0].content).toContain('中文');
    expect(messages[0].content).toContain('JSON');
    expect(JSON.parse(messages[1].content)).toEqual(input);
    expect(headers.Session_id).toBeTruthy();
    expect(f.storeObservations).not.toHaveBeenCalled();
    expect(f.updateMemorySessionId).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.session.conversationHistory).toEqual([]);
    expect(contextGenerator.generateContext).not.toHaveBeenCalled();
  });

  it('keeps standalone request identity stable without inventing missing usage fields', async () => {
    const input = { original: { text: 'same request' }, workstreams: [] };
    replies.push(chat('{"title":"First"}', { total_tokens: 12 }), chat('{"title":"Second"}', {}));
    const f = fixture();
    expect((await f.agent.generateHumanCopy(input)).usage).toEqual({ total_tokens: 12 });
    expect((await f.agent.generateHumanCopy(input)).usage).toBeNull();
    expect(requests[1].headers.Session_id).toBe(requests[0].headers.Session_id);
    expect(requests[0].body.prompt_cache_key).toBe(requests[0].headers.Session_id);
    expect(requests[1].body.prompt_cache_key).toBe(requests[0].headers.Session_id);
    expect(f.storeObservations).not.toHaveBeenCalled();
  });

  it('routes a JSON summary to the summary-tier model and stores its fields', async () => {
    settings.CLAUDE_MEM_TIER_ROUTING_ENABLED = 'true';
    settings.CLAUDE_MEM_TIER_SUMMARY_MODEL = 'custom-summary-model';
    const summary = { request: '请求', investigated: '调查', learned: '了解', completed: '完成', next_steps: '后续', notes: null };
    replies.push(chat(JSON.stringify(summary)));
    const f = fixture([{ type: 'summarize', _persistentId: 103, last_assistant_message: 'done' }]);
    await f.agent.startSession(f.session);
    expect(requests[0].body.model).toBe('custom-summary-model');
    expect(requests[0].body.response_format).toEqual({ type: 'json_object' });
    expect(f.storeObservations).toHaveBeenCalledTimes(1);
    expect(f.storeObservations.mock.calls[0][3]).toMatchObject(summary);
  });

  for (const protocol of ['openai', 'gemini', 'codex'] as const) it(`condenses oversized ${protocol} fields as text before the JSON observation`, async () => {
    settings.CLAUDE_MEM_CUSTOM_PROTOCOL = protocol;
    settings.CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW = '8192';
    const text = 'several words of ordinary tool output '.repeat(300);
    replies.push(protocol === 'openai' ? chat('Condensed payload') : protocol === 'gemini' ? gemini('Condensed payload') : codex('Condensed payload'),
      protocol === 'openai' ? chat() : protocol === 'gemini' ? gemini() : codex());
    const f = fixture([{ ...toolMessage, tool_response: { text } }]);
    await f.agent.startSession(f.session);
    expect(requests).toHaveLength(2);
    expect(requests[0].body.response_format).toBeUndefined();
    expect(requests[0].body.text).toBeUndefined();
    expect(requests[0].body.generationConfig?.responseMimeType).toBeUndefined();
    const observationBody = JSON.stringify(requests[1].body);
    expect(observationBody).toContain('Condensed payload');
    expect(f.storeObservations).toHaveBeenCalledTimes(1);
  });

  it('recycles a context overflow with the claimed batch preserved', async () => {
    replies.push(new Response(JSON.stringify({ error: { message: 'maximum context length exceeded' } }), { status: 400 }));
    const f = fixture();
    await f.agent.startSession(f.session);
    expect(f.resetProcessingToPending).toHaveBeenCalledTimes(1);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.session.abortReason).toBe('overflow:recycle');
    expect(f.session.conversationHistory).toEqual([]);
    expect(f.session.forceInit).toBe(true);
    expect(f.storeObservations).not.toHaveBeenCalled();
  });

  it('does not store a late observation after the session was aborted', async () => {
    const f = fixture();
    replies.push(() => { f.session.abortController.abort(); return chat(); });
    await expect(f.agent.startSession(f.session)).rejects.toBeInstanceOf(Error);
    expect(f.storeObservations).not.toHaveBeenCalled();
  });

  for (const protocol of ['openai', 'gemini', 'codex'] as const) it(`lets reasoning=on remove forced-off ${protocol} tuning`, async () => {
    settings.CLAUDE_MEM_CUSTOM_REASONING = 'on';
    settings.CLAUDE_MEM_CUSTOM_PROTOCOL = protocol;
    settings.CLAUDE_MEM_CUSTOM_MODEL = protocol === 'gemini' ? 'gemini-2.5-flash' : 'gpt-5.4';
    replies.push(protocol === 'openai' ? chat() : protocol === 'gemini' ? gemini() : codex());
    const f = fixture();
    await f.agent.startSession(f.session);
    expect(requests[0].body.reasoning).toBeUndefined();
    expect(requests[0].body.reasoning_effort).toBeUndefined();
    expect(requests[0].body.generationConfig?.thinkingConfig).toBeUndefined();
  });

  for (const allowance of [1, 2]) it(`bounds the empty-reasoning retry to ${allowance} paid sends`, async () => {
    settings.CLAUDE_MEM_CUSTOM_REASONING = 'on';
    replies.push(new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 7, completion_tokens: 40, total_tokens: 47 } })), chat());
    const f = fixture();
    f.session.paidSendBudget = new PaidSendBudget(101, allowance);
    await f.agent.startSession(f.session);
    expect(requests).toHaveLength(allowance);
    expect(f.session.paidSendBudget.spentPaidSends).toBe(allowance);
    if (allowance === 2) {
      expect(requests[1].body.reasoning).toEqual({ enabled: false });
      expect(f.session.cumulativeOutputTokens).toBe(45);
    }
  });

  for (const protocol of ['openai', 'gemini', 'codex'] as const) it(`uses the shared deadline when ${protocol} total timeout is zero`, async () => {
    settings.CLAUDE_MEM_CUSTOM_PROTOCOL = protocol;
    settings.CLAUDE_MEM_LLM_TIMEOUT_MS = '500';
    replies.push(signal => new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } })));
    const f = fixture();
    const started = Date.now();
    try { await f.agent.startSession(f.session); } catch (error) { expect(error).toBeInstanceOf(ClassifiedProviderError); }
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(requests).toHaveLength(1);
  });

  for (const protocol of ['openai', 'gemini', 'codex'] as const) it(`honors an explicit ${protocol} total timeout over the shared default`, async () => {
    settings.CLAUDE_MEM_CUSTOM_PROTOCOL = protocol;
    settings.CLAUDE_MEM_LLM_TIMEOUT_MS = '500';
    settings.CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT = '2';
    replies.push(async () => {
      await new Promise(resolve => setTimeout(resolve, 550));
      return protocol === 'openai' ? chat() : protocol === 'gemini' ? gemini() : codex();
    });
    const f = fixture();
    await f.agent.startSession(f.session);
    expect(f.storeObservations).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it('uses the shared plain timeout after an endpoint refuses streaming', async () => {
    settings.CLAUDE_MEM_CUSTOM_STREAMING = 'true';
    settings.CLAUDE_MEM_LLM_TIMEOUT_MS = '500';
    replies.push(new Response(JSON.stringify({ error: { message: 'unknown parameter: stream_options' } }), { status: 400 }),
      signal => new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      } })));
    const f = fixture();
    const started = Date.now();
    await f.agent.startSession(f.session);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(requests).toHaveLength(2);
    expect(requests[1].body.stream).toBeUndefined();
  });

  it('rotates native Gemini HTTP 400 invalid keys using its structured error taxonomy', async () => {
    settings.CLAUDE_MEM_CUSTOM_PROTOCOL = 'gemini';
    settings.CLAUDE_MEM_CUSTOM_API_KEY = 'gemini-400-primary';
    settings.CLAUDE_MEM_CUSTOM_API_KEYS = 'gemini-400-secondary';
    replies.push(new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API_KEY_INVALID: API key not valid' } }), { status: 400 }), gemini());
    const f = fixture();
    await f.agent.startSession(f.session);
    expect(requests.map(request => request.headers['x-goog-api-key'])).toEqual(['gemini-400-primary', 'gemini-400-secondary']);
    expect(f.session.paidSendBudget.spentPaidSends).toBe(1);
  });

  it('honors native Gemini RetryInfo and keeps the queued work on a long throttle', async () => {
    settings.CLAUDE_MEM_CUSTOM_PROTOCOL = 'gemini';
    settings.CLAUDE_MEM_CUSTOM_API_KEY = 'retryinfo-primary';
    settings.CLAUDE_MEM_CUSTOM_API_KEYS = 'retryinfo-secondary';
    const errorReply = () => new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'per-minute rate limit',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '90s' }],
    } }), { status: 429 });
    replies.push(errorReply(), errorReply());
    const f = fixture();
    try {
      await f.agent.startSession(f.session);
      throw new Error('expected pooled rate limit');
    } catch (error) {
      expect(error).toMatchObject({ kind: 'rate_limit' });
      expect((error as ClassifiedProviderError).retryAfterMs).toBeGreaterThan(89000);
      expect((error as ClassifiedProviderError).retryAfterMs).toBeLessThanOrEqual(90000);
    }
    expect(requests).toHaveLength(2);
    expect(f.session.abortReason).toBe('rate_limit:rate_limit');
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it('accepts full-message SSE chunks used by compatible gateways', async () => {
    settings.CLAUDE_MEM_CUSTOM_STREAMING = 'true';
    replies.push(sse([{ choices: [{ message: { content: observation }, finish_reason: 'stop' }] }]));
    const f = fixture();
    await f.agent.startSession(f.session);
    expect(f.storeObservations).toHaveBeenCalledTimes(1);
    expect(f.session.conversationHistory.at(-1).content).toBe(observation);
  });

  for (const protocol of ['openai', 'gemini', 'codex'] as const) it(`sniffs ${protocol} SSE beginning with id and retry fields under text/plain`, async () => {
    settings.CLAUDE_MEM_CUSTOM_PROTOCOL = protocol;
    settings.CLAUDE_MEM_CUSTOM_STREAMING = 'true';
    const payload = protocol === 'openai' ? { choices: [{ delta: { content: observation }, finish_reason: 'stop' }] }
      : protocol === 'gemini' ? { candidates: [{ content: { parts: [{ text: observation }] }, finishReason: 'STOP' }] }
        : { type: 'response.completed', response: { status: 'completed', output_text: observation } };
    replies.push(new Response('id: 1\nretry: 1000\n' + await sse([payload]).text(), { headers: { 'content-type': 'text/plain' } }));
    const f = fixture();
    await f.agent.startSession(f.session);
    expect(f.storeObservations).toHaveBeenCalledTimes(1);
    expect(f.session.conversationHistory.at(-1).content).toBe(observation);
  });
});

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';

import { CustomAgent } from '../../src/services/worker/CustomAgent.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import * as EnvManager from '../../src/shared/EnvManager.js';
import { logger } from '../../src/utils/logger.js';
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
    footer: '',
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
    processingMessageIds: []
  } as any;
}

describe('CustomAgent session behavior', () => {
  let originalFetch: typeof global.fetch;
  let loadFromFileSpy: ReturnType<typeof spyOn>;
  let modeManagerSpy: ReturnType<typeof spyOn>;
  let getCredentialSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalFetch = global.fetch;

    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {}
    } as any));

    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
      CLAUDE_MEM_CUSTOM_MODEL: 'gpt-4o',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'openai',
      CLAUDE_MEM_CUSTOM_STREAMING: 'false',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0'
    }));

    getCredentialSpy = spyOn(EnvManager, 'getCredential').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (loadFromFileSpy) loadFromFileSpy.mockRestore();
    if (modeManagerSpy) modeManagerSpy.mockRestore();
    if (getCredentialSpy) getCredentialSpy.mockRestore();
    mock.restore();
  });

  it('does not duplicate assistant message in conversation history during init', async () => {
    const mockStoreObservations = mock(() => ({
      observationIds: [1],
      summaryId: null,
      createdAtEpoch: Date.now()
    }));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mockStoreObservations
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {}
      })
    } as unknown as SessionManager;

    const session = createSession();

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' } }],
      usage: { total_tokens: 12 }
    }))));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(session);

    expect(session.conversationHistory).toHaveLength(2);
    expect(session.conversationHistory[0].role).toBe('user');
    expect(session.conversationHistory[1].role).toBe('assistant');
    expect(mockStoreObservations).toHaveBeenCalledTimes(1);
  });

  it('uses CUSTOM_API_KEY credential fallback when settings key is empty', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: '',
      CLAUDE_MEM_CUSTOM_MODEL: 'gpt-4o',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'openai',
      CLAUDE_MEM_CUSTOM_STREAMING: 'false',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0'
    }));

    getCredentialSpy.mockImplementation((key: any) => key === 'CUSTOM_API_KEY' ? 'fallback-custom-key' : undefined);

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {}
      })
    } as unknown as SessionManager;

    const session = createSession();

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' } }],
      usage: { total_tokens: 12 }
    }))));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(session);

    const call = (global.fetch as any).mock.calls[0];
    expect(call[1].headers.Authorization).toBe('Bearer fallback-custom-key');
    expect(call[1].headers.Session_id).toBe('content-1');
    const requestBody = JSON.parse(call[1].body as string);
    expect(requestBody.prompt_cache_key).toBe('content-1');
  });

  it('generates random Session_id when contentSessionId is blank', async () => {
    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {}
      })
    } as unknown as SessionManager;

    const session = createSession();
    session.contentSessionId = '   ';

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' } }],
      usage: { total_tokens: 12 }
    }))));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(session);

    const call = (global.fetch as any).mock.calls[0];
    expect(call[1].headers.Session_id).toMatch(/^custom-\d+-[a-z0-9]+$/);
    const requestBody = JSON.parse(call[1].body as string);
    expect(requestBody.prompt_cache_key).toBe(call[1].headers.Session_id);
  });

  it('sets lowest reasoning effort for gpt-* models in OpenAI requests', async () => {
    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {}
      })
    } as unknown as SessionManager;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' } }],
      usage: { total_tokens: 12 }
    }))));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    const requestBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(requestBody.reasoning_effort).toBe('low');
  });

  it('serializes OpenAI request config before dynamic messages for prompt-cache prefix stability', async () => {
    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {}
      })
    } as unknown as SessionManager;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' } }],
      usage: { total_tokens: 12 }
    }))));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    const rawBody = (global.fetch as any).mock.calls[0][1].body as string;
    expect(rawBody.indexOf('"temperature"')).toBeLessThan(rawBody.indexOf('"messages"'));
    expect(rawBody.indexOf('"response_format"')).toBeLessThan(rawBody.indexOf('"messages"'));
  });

  it('disables thinking for mimo models in OpenAI requests', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
      CLAUDE_MEM_CUSTOM_MODEL: 'mimo-v2.5',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'openai',
      CLAUDE_MEM_CUSTOM_STREAMING: 'false',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0'
    }));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {}
      })
    } as unknown as SessionManager;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' } }],
      usage: { total_tokens: 12 }
    }))));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    const requestBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(requestBody.thinking).toEqual({ type: 'disabled' });
  });

  it('uses minimal thinking for gemini-3 models in OpenAI requests', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
      CLAUDE_MEM_CUSTOM_MODEL: 'gemini-3-flash-preview',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'openai',
      CLAUDE_MEM_CUSTOM_STREAMING: 'false',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0'
    }));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {}
      })
    } as unknown as SessionManager;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' } }],
      usage: { total_tokens: 12 }
    }))));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    const requestBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(requestBody.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });

  it('uses minimal thinking when Gemini protocol normalizes models-prefixed gemini-3.5 models', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
      CLAUDE_MEM_CUSTOM_MODEL: 'models/gemini-3.5-flash',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'gemini',
      CLAUDE_MEM_CUSTOM_STREAMING: 'false',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0'
    }));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {}
      })
    } as unknown as SessionManager;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' }] } }],
      usageMetadata: { totalTokenCount: 12 }
    }))));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    const call = (global.fetch as any).mock.calls[0];
    expect(call[0]).toContain('/v1beta/models/gemini-3.5-flash:generateContent');
    const requestBody = JSON.parse(call[1].body as string);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });

  it('serializes Gemini generationConfig before dynamic contents for prompt-cache prefix stability', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
      CLAUDE_MEM_CUSTOM_MODEL: 'gemini-2.5-flash',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'gemini',
      CLAUDE_MEM_CUSTOM_STREAMING: 'false',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0'
    }));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {}
      })
    } as unknown as SessionManager;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' }] } }],
      usageMetadata: { totalTokenCount: 12 }
    }))));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    const rawBody = (global.fetch as any).mock.calls[0][1].body as string;
    expect(rawBody.indexOf('"generationConfig"')).toBeLessThan(rawBody.indexOf('"contents"'));
  });

  it('sets stable Session_id header for Gemini protocol requests', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
      CLAUDE_MEM_CUSTOM_MODEL: 'gemini-2.5-flash',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'gemini',
      CLAUDE_MEM_CUSTOM_STREAMING: 'false',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0'
    }));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () {
        yield {
          _persistentId: 902,
          _originalTimestamp: Date.now(),
          type: 'observation',
          prompt_number: 2,
          tool_name: 'Read',
          tool_input: { path: 'a.ts' },
          tool_response: { ok: true },
          cwd: '/tmp/project'
        } as any;
      },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {}
      })
    } as unknown as SessionManager;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' }] } }],
      usageMetadata: { totalTokenCount: 12 }
    }))));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    const firstCall = (global.fetch as any).mock.calls[0];
    const secondCall = (global.fetch as any).mock.calls[1];
    expect(firstCall[1].headers.Session_id).toBe('content-1');
    expect(secondCall[1].headers.Session_id).toBe('content-1');
    expect(JSON.parse(firstCall[1].body as string).prompt_cache_key).toBeUndefined();
  });

  it('sets stable Session_id header for Gemini streaming requests', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
      CLAUDE_MEM_CUSTOM_MODEL: 'gemini-2.5-flash',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'gemini',
      CLAUDE_MEM_CUSTOM_STREAMING: 'true',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0'
    }));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {}
      })
    } as unknown as SessionManager;

    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"{\\"type\\":\\"discovery\\",\\"title\\":\\"ok\\",\\"narrative\\":\\"n\\",\\"files_read\\":[],\\"files_modified\\":[],\\"concepts\\":[]}"}]}}],"usageMetadata":{"totalTokenCount":12}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');

    global.fetch = mock(() => Promise.resolve(new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    const call = (global.fetch as any).mock.calls[0];
    expect(call[1].headers.Session_id).toBe('content-1');
  });

  it('does not set reasoning effort for non-gpt models', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
      CLAUDE_MEM_CUSTOM_MODEL: 'claude-3-5-sonnet',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'openai',
      CLAUDE_MEM_CUSTOM_STREAMING: 'false',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0'
    }));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {}
      })
    } as unknown as SessionManager;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' } }],
      usage: { total_tokens: 12 }
    }))));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    const requestBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(requestBody.reasoning_effort).toBeUndefined();
  });

  it('supports Codex protocol with responses endpoint (non-streaming)', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
      CLAUDE_MEM_CUSTOM_MODEL: 'codex-mini-latest',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'codex',
      CLAUDE_MEM_CUSTOM_STREAMING: 'false',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0'
    }));

    const mockStoreObservations = mock(() => ({
      observationIds: [1],
      summaryId: null,
      createdAtEpoch: Date.now()
    }));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mockStoreObservations
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {}
      })
    } as unknown as SessionManager;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      output: [{
        content: [{
          type: 'output_text',
          text: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}'
        }]
      }],
      usage: { total_tokens: 12 }
    }))));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    expect(mockStoreObservations).toHaveBeenCalledTimes(1);
    const call = (global.fetch as any).mock.calls[0];
    expect(call[0]).toBe('https://custom.example.com/v1/responses');
    expect(call[1].headers.Session_id).toBe('content-1');
    const requestBody = JSON.parse(call[1].body as string);
    expect(requestBody.prompt_cache_key).toBe('content-1');
    expect(Array.isArray(requestBody.input)).toBe(true);
    expect(requestBody.text?.format?.type).toBe('json_object');
    expect(requestBody.messages).toBeUndefined();
  });

  it('supports Codex protocol with SSE stream responses', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
      CLAUDE_MEM_CUSTOM_MODEL: 'codex-mini-latest',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'codex',
      CLAUDE_MEM_CUSTOM_STREAMING: 'true',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0',
    }));

    const mockStoreObservations = mock(() => ({
      observationIds: [1],
      summaryId: null,
      createdAtEpoch: Date.now(),
    }));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mockStoreObservations,
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve(),
      }),
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {},
      }),
    } as unknown as SessionManager;

    const sse = [
      'data: {"type":"response.output_text.delta","delta":"{\\"type\\":\\"disco"}',
      '',
      'data: {"type":"response.output_text.delta","delta":"very\\",\\"title\\":\\"ok\\",\\"narrative\\":\\"n\\",\\"files_read\\":[],\\"files_modified\\":[],\\"concepts\\":[]}"}',
      '',
      'data: {"type":"response.completed","response":{"usage":{"total_tokens":12}}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');

    global.fetch = mock(() => Promise.resolve(new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    expect(mockStoreObservations).toHaveBeenCalledTimes(1);
    const firstCall = (global.fetch as any).mock.calls[0];
    expect(firstCall[1].headers.Session_id).toBe('content-1');
    const requestBody = JSON.parse(firstCall[1].body as string);
    expect(requestBody.stream).toBe(true);
  });

  it('handles Codex SSE response even when custom streaming is disabled', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
      CLAUDE_MEM_CUSTOM_MODEL: 'codex-mini-latest',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'codex',
      CLAUDE_MEM_CUSTOM_STREAMING: 'false',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0',
    }));

    const mockStoreObservations = mock(() => ({
      observationIds: [1],
      summaryId: null,
      createdAtEpoch: Date.now(),
    }));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mockStoreObservations,
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve(),
      }),
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {},
      }),
    } as unknown as SessionManager;

    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"{\\"type\\":\\"discovery\\",\\"title\\":\\"ok\\",\\"narrative\\":\\"n\\",\\"files_read\\":[],\\"files_modified\\":[],\\"concepts\\":[]}"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"usage":{"total_tokens":12}}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');

    global.fetch = mock(() => Promise.resolve(new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    expect(mockStoreObservations).toHaveBeenCalledTimes(1);
    const call = (global.fetch as any).mock.calls[0];
    const requestBody = JSON.parse(call[1].body as string);
    expect(requestBody.stream).toBeUndefined();
  });

  it('handles OpenAI SSE response even when custom streaming is disabled', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
      CLAUDE_MEM_CUSTOM_MODEL: 'grok-4.2-fast',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'openai',
      CLAUDE_MEM_CUSTOM_STREAMING: 'false',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0',
    }));

    const mockStoreObservations = mock(() => ({
      observationIds: [1],
      summaryId: null,
      createdAtEpoch: Date.now(),
    }));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mockStoreObservations,
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve(),
      }),
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {},
      }),
    } as unknown as SessionManager;

    const sse = [
      'event: message',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"grok-4.2-fast","choices":[{"delta":{"content":"{\\"type\\":\\"discovery\\",\\"title\\":\\"ok\\",\\"narrative\\":\\"n\\",\\"files_read\\":[],\\"files_modified\\":[],\\"concepts\\":[]}"}}],"usage":{"total_tokens":12}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');

    global.fetch = mock(() => Promise.resolve(new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    expect(mockStoreObservations).toHaveBeenCalledTimes(1);
    const call = (global.fetch as any).mock.calls[0];
    const requestBody = JSON.parse(call[1].body as string);
    expect(requestBody.stream).toBeUndefined();
  });

  it('handles Gemini SSE response even when custom streaming is disabled', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
      CLAUDE_MEM_CUSTOM_MODEL: 'gemini-2.5-flash',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'gemini',
      CLAUDE_MEM_CUSTOM_STREAMING: 'false',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0',
    }));

    const mockStoreObservations = mock(() => ({
      observationIds: [1],
      summaryId: null,
      createdAtEpoch: Date.now(),
    }));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mockStoreObservations,
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve(),
      }),
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {},
      }),
    } as unknown as SessionManager;

    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"{\\"type\\":\\"discovery\\",\\"title\\":\\"ok\\",\\"narrative\\":\\"n\\",\\"files_read\\":[],\\"files_modified\\":[],\\"concepts\\":[]}"}]}}],"usageMetadata":{"totalTokenCount":12}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');

    global.fetch = mock(() => Promise.resolve(new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    expect(mockStoreObservations).toHaveBeenCalledTimes(1);
    const call = (global.fetch as any).mock.calls[0];
    expect(call[0]).toContain(':generateContent');
    expect(call[0]).not.toContain(':streamGenerateContent');
  });

  it('passes session abort signal to Custom provider requests', async () => {
    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {},
        resetToPending: () => true
      })
    } as unknown as SessionManager;

    const session = createSession();

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' } }],
      usage: { total_tokens: 12 }
    }))));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(session);

    const call = (global.fetch as any).mock.calls[0];
    expect(call[1].signal).toBe(session.abortController.signal);
  });

  it('retries when firstTokenTimeout expires before first body chunk arrives', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
      CLAUDE_MEM_CUSTOM_MODEL: 'gpt-4o',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'openai',
      CLAUDE_MEM_CUSTOM_STREAMING: 'false',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '1',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '10',
    }));

    const mockStoreObservations = mock(() => ({
      observationIds: [1],
      summaryId: null,
      createdAtEpoch: Date.now(),
    }));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mockStoreObservations,
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve(),
      }),
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {},
      }),
    } as unknown as SessionManager;

    const jsonBody = JSON.stringify({
      choices: [{ message: { content: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' } }],
      usage: { total_tokens: 12 },
    });

    const encoder = new TextEncoder();
    let callCount = 0;
    global.fetch = mock((_url: any, options: any) => {
      callCount += 1;
      const delayMs = callCount === 1 ? 1500 : 0;
      const signal = options?.signal as AbortSignal | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const onAbort = () => {
            if (timer) clearTimeout(timer);
            const error = new Error('aborted');
            (error as any).name = 'AbortError';
            controller.error(error);
          };

          if (signal) {
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
          }

          timer = setTimeout(() => {
            if (signal) {
              signal.removeEventListener('abort', onAbort);
            }
            controller.enqueue(encoder.encode(jsonBody));
            controller.close();
          }, delayMs);
        },
        cancel() {
          if (timer) clearTimeout(timer);
        },
      });

      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    // With firstTokenTimeout=1s and a delayed first chunk on the first attempt,
    // the Custom fetcher should retry and eventually succeed on the second attempt.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockStoreObservations).toHaveBeenCalledTimes(1);
  });

  it('injects structured language instruction into observation prompt without footer regex', async () => {
    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () {
        yield {
          _persistentId: 901,
          _originalTimestamp: Date.now(),
          type: 'observation',
          prompt_number: 2,
          tool_name: 'Read',
          tool_input: { path: 'a.ts' },
          tool_response: { ok: true },
          cwd: '/tmp/project'
        } as any;
      },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {},
        resetToPending: () => true
      })
    } as unknown as SessionManager;

    const session = createSession();

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' } }],
      usage: { total_tokens: 12 }
    }))));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(session);

    const secondRequestBody = JSON.parse((global.fetch as any).mock.calls[1][1].body as string);
    const observationPrompt = secondRequestBody.messages.find((message: any) =>
      typeof message.content === 'string' && message.content.includes('OUTPUT FORMAT: Return compact single-line JSON')
    )?.content as string;

    const firstRequestHeaders = (global.fetch as any).mock.calls[0][1].headers;
    const secondRequestHeaders = (global.fetch as any).mock.calls[1][1].headers;

    expect(observationPrompt).toBeTruthy();
    expect(observationPrompt).toContain('LANGUAGE REQUIREMENTS: Please write the observation data in Bahasa Indonesia');
    expect(firstRequestHeaders.Session_id).toBe('content-1');
    expect(secondRequestHeaders.Session_id).toBe('content-1');
  });

  it('processes empty observation response to keep queue state consistent', async () => {
    const confirmProcessedMock = mock(() => {});
    const clearPendingForSessionMock = mock(() => {});
    const confirmClaimedMessagesMock = mock(() => Promise.resolve());
    const mockStoreObservations = mock(() => ({
      observationIds: [],
      summaryId: null,
      createdAtEpoch: Date.now()
    }));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mockStoreObservations
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: clearPendingForSessionMock,
      confirmClaimedMessages: confirmClaimedMessagesMock,
      getMessageIterator: async function* () {
        yield {
          _persistentId: 333,
          _originalTimestamp: Date.now(),
          type: 'observation',
          prompt_number: 2,
          tool_name: 'Read',
          tool_input: { path: 'a.ts' },
          tool_response: { ok: true },
          cwd: '/tmp/project'
        } as any;
      },
      getPendingMessageStore: () => ({
        confirmProcessed: confirmProcessedMock,
        resetToPending: () => true
      })
    } as unknown as SessionManager;

    let callCount = 0;
    global.fetch = mock(() => {
      callCount += 1;

      if (callCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: '{"type":"discovery","title":"init","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' } }],
          usage: { total_tokens: 12 }
        })));
      }

      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: '' } }],
        usage: { total_tokens: 2 }
      })));
    });

    const session = createSession();
    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(session);

    expect(mockStoreObservations).toHaveBeenCalledTimes(2);
    // Second call (empty observation) should produce empty observations array
    const secondCallArgs = mockStoreObservations.mock.calls[1];
    expect(secondCallArgs[2]).toEqual([]); // observations parameter is empty array
    expect(clearPendingForSessionMock).not.toHaveBeenCalled();
    expect(confirmClaimedMessagesMock).toHaveBeenCalledWith(session.sessionDbId);
    expect(confirmProcessedMock).not.toHaveBeenCalled();
    expect(session.processingMessageIds).toEqual([]);
    expect(session.earliestPendingTimestamp).toBeNull();
  });

  it('uses session-start mode for all observation prompts', async () => {
    const modeA = {
      ...mockMode,
      prompts: {
        ...mockMode.prompts,
        language_instruction: 'LANGUAGE REQUIREMENTS: Please write the observation data in Mode A'
      },
      observation_types: [{ id: 'discovery', description: 'A 模式发现' }]
    };

    const modeB = {
      ...mockMode,
      prompts: {
        ...mockMode.prompts,
        language_instruction: 'LANGUAGE REQUIREMENTS: Please write the observation data in Mode B'
      },
      observation_types: [{ id: 'bugfix', description: 'B 模式修复' }]
    };

    let activeMode = modeA;
    modeManagerSpy.mockRestore();
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => activeMode,
      loadMode: () => {}
    } as any));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () {
        yield {
          _persistentId: 902,
          _originalTimestamp: Date.now(),
          type: 'observation',
          prompt_number: 2,
          tool_name: 'Read',
          tool_input: { path: 'a.ts' },
          tool_response: { ok: true },
          cwd: '/tmp/project'
        } as any;
      },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {},
        resetToPending: () => true
      })
    } as unknown as SessionManager;

    let callCount = 0;
    global.fetch = mock(() => {
      callCount += 1;
      if (callCount === 1) {
        activeMode = modeB;
      }

      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' } }],
        usage: { total_tokens: 12 }
      })));
    });

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    const secondRequestBody = JSON.parse((global.fetch as any).mock.calls[1][1].body as string);
    const observationPrompt = secondRequestBody.messages.find((message: any) =>
      typeof message.content === 'string' && message.content.includes('OUTPUT FORMAT: Return compact single-line JSON')
    )?.content as string;

    expect(observationPrompt).toBeTruthy();
    expect(observationPrompt).toMatch(/"type"\s*:\s*"discovery"/);
    expect(observationPrompt).toContain('LANGUAGE REQUIREMENTS: Please write the observation data in Mode A');
    expect(observationPrompt).not.toContain('LANGUAGE REQUIREMENTS: Please write the observation data in Mode B');
  });

  it('throws meaningful error when OpenAI response is non-JSON', async () => {
    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {},
        resetToPending: () => true
      })
    } as unknown as SessionManager;

    global.fetch = mock(() => Promise.resolve(new Response('<html>503 upstream</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    })));

    const agent = new CustomAgent(dbManager, sessionManager);
    await expect(agent.startSession(createSession())).rejects.toThrow('Custom/OpenAI API returned invalid JSON (status 200)');
  });

  it('throws API error when OpenAI returns HTTP 200 with error object', async () => {
    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {},
        resetToPending: () => true
      })
    } as unknown as SessionManager;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      error: {
        code: 'rate_limit',
        message: 'Too many requests'
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })));

    const agent = new CustomAgent(dbManager, sessionManager);
    await expect(agent.startSession(createSession())).rejects.toThrow('Custom/OpenAI API error: rate_limit - Too many requests');
  });

  it('parses OpenAI SSE stream when data lines are split across chunks', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
      CLAUDE_MEM_CUSTOM_MODEL: 'gpt-4o',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'openai',
      CLAUDE_MEM_CUSTOM_STREAMING: 'true',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0',
    }));

    const mockStoreObservations = mock(() => ({
      observationIds: [1],
      summaryId: null,
      createdAtEpoch: Date.now(),
    }));

    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mockStoreObservations,
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve(),
      }),
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {},
      }),
    } as unknown as SessionManager;

    const encoder = new TextEncoder();
    const chunk1 = 'data: {"choices":[{"delta":{"content":"{\\"type\\":\\"disco';
    const chunk2 = 'very\\",\\"title\\":\\"ok\\",\\"narrative\\":\\"n\\",\\"files_read\\":[],\\"files_modified\\":[],\\"concepts\\":[]}"}}],"usage":{"total_tokens":12}}\n\n' +
      'data: [DONE]\n\n';

    global.fetch = mock(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(chunk1));
          controller.enqueue(encoder.encode(chunk2));
          controller.close();
        },
      });

      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    });

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    expect(mockStoreObservations).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse((global.fetch as any).mock.calls[0][1].body as string);
    expect(requestBody.reasoning_effort).toBe('low');
  });

  it('logs warn instead of error for empty OpenAI stream responses', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
      CLAUDE_MEM_CUSTOM_API_KEY: 'test-key',
      CLAUDE_MEM_CUSTOM_MODEL: 'gpt-4o',
      CLAUDE_MEM_CUSTOM_PROTOCOL: 'openai',
      CLAUDE_MEM_CUSTOM_STREAMING: 'true',
      CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_CUSTOM_MAX_TOKENS: '0',
      CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT: '0',
      CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT: '0'
    }));

    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    const dbManager = {
      getSessionStore: () => ({
        getSessionById: () => ({ memory_session_id: 'mem-custom-1' }),
        updateMemorySessionId: () => {},
        ensureMemorySessionIdRegistered: () => {},
        storeObservations: mock(() => ({
          observationIds: [1],
          summaryId: null,
          createdAtEpoch: Date.now()
        }))
      }),
      getChromaSync: () => ({
        syncObservation: () => Promise.resolve(),
        syncSummary: () => Promise.resolve()
      })
    } as unknown as DatabaseManager;

    const sessionManager = {
      clearPendingForSession: () => {},
      confirmClaimedMessages: () => Promise.resolve(),
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        confirmProcessed: () => {},
        resetToPending: () => true
      })
    } as unknown as SessionManager;

    global.fetch = mock(() => Promise.resolve(new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })));

    const agent = new CustomAgent(dbManager, sessionManager);
    await agent.startSession(createSession());

    expect(warnSpy).toHaveBeenCalledWith('SDK', 'Empty stream response from Custom/OpenAI');
    expect(errorSpy).not.toHaveBeenCalledWith('SDK', 'Empty stream response from Custom/OpenAI');
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

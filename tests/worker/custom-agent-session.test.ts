import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';

import { CustomAgent } from '../../src/services/worker/CustomAgent.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import * as EnvManager from '../../src/shared/EnvManager.js';
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

  it('resets processing messages before fallback to Claude', async () => {
    const resetToPendingMock = mock(() => true);
    const fallbackStartSession = mock(async () => {});

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
      getMessageIterator: async function* () {
        yield {
          _persistentId: 777,
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
        resetToPending: resetToPendingMock
      })
    } as unknown as SessionManager;

    const session = createSession();

    let callCount = 0;
    global.fetch = mock(() => {
      callCount += 1;

      if (callCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: '{"type":"discovery","title":"ok","narrative":"n","files_read":[],"files_modified":[],"concepts":[]}' } }],
          usage: { total_tokens: 12 }
        })));
      }

      return Promise.reject(new Error('503 upstream unavailable'));
    });

    const agent = new CustomAgent(dbManager, sessionManager);
    agent.setFallbackAgent({ startSession: fallbackStartSession });

    await agent.startSession(session);

    expect(resetToPendingMock).toHaveBeenCalledTimes(1);
    expect(resetToPendingMock).toHaveBeenCalledWith(777);
    expect(fallbackStartSession).toHaveBeenCalledTimes(1);
    expect(session.processingMessageIds).toEqual([]);
  });
});

/**
 * CustomAgent: Configurable AI provider with multi-protocol support
 *
 * A flexible provider that supports:
 * - Custom API endpoints (proxies, self-hosted models)
 * - Multiple protocols (OpenAI, Gemini)
 * - Streaming responses
 * - Gemini 2.5+ thinking part extraction
 * - JSON response format for reliable summary parsing
 *
 * Responsibility:
 * - Call configurable REST APIs for observation extraction
 * - Support both OpenAI and Gemini message formats
 * - Parse responses (XML for observations, JSON for summaries)
 * - Sync to database and Chroma
 */

import path from 'path';
import { homedir } from 'os';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPromptJson, buildObservationPrompt, buildSummaryPromptJson, buildContinuationPromptJson } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import {
  processAgentResponse,
  cleanupProcessedMessages,
  shouldFallbackToClaude,
  isAbortError,
  type WorkerRef,
  type FallbackAgent
} from './agents/index.js';

// Context window management constants
const CHARS_PER_TOKEN_ESTIMATE = 4;  // Conservative estimate: 1 token = 4 chars

// Protocol types
export type CustomProtocol = 'openai' | 'gemini';

// Configuration interface
export interface CustomAgentConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  protocol: CustomProtocol;
  streaming: boolean;
  maxContextMessages: number;  // 0 = disabled
  maxTokens: number;  // 0 = disabled
  firstTokenTimeoutSeconds: number;  // 0 = disabled
  totalTimeoutSeconds: number;  // 0 = disabled
}

/**
 * Build full API URL from base URL based on protocol
 * - OpenAI: {baseUrl}/v1/chat/completions
 * - Gemini: {baseUrl}/v1beta/models/{model}:generateContent or :streamGenerateContent?alt=sse
 */
function buildApiUrl(baseUrl: string, protocol: CustomProtocol, model: string, streaming: boolean = false): string {
  // Remove trailing slash if present
  const cleanBaseUrl = baseUrl.replace(/\/+$/, '');

  if (protocol === 'gemini') {
    // Normalize model name (avoid "models/models/..." if user included prefix)
    const cleanModel = model.replace(/^models\//, '');
    const action = streaming ? 'streamGenerateContent' : 'generateContent';
    // Add alt=sse for streaming to ensure SSE format (data: prefix on each message)
    const sseParam = streaming ? '?alt=sse' : '';
    return `${cleanBaseUrl}/v1beta/models/${cleanModel}:${action}${sseParam}`;
  } else {
    // Allow apiUrl to be either:
    // - Base URL (https://host) -> append /v1/chat/completions
    // - OpenAI compatible base (https://host/v1) -> append /chat/completions
    // - Full endpoint (https://host/v1/chat/completions) -> use as-is
    if (cleanBaseUrl.endsWith('/v1/chat/completions')) {
      return cleanBaseUrl;
    }
    if (cleanBaseUrl.endsWith('/v1')) {
      return `${cleanBaseUrl}/chat/completions`;
    }
    return `${cleanBaseUrl}/v1/chat/completions`;
  }
}

// Gemini response types
interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;  // Gemini 2.5+ thinking indicator
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

// OpenAI response types
interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
    delta?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Extract non-thinking text from Gemini response parts
 * Gemini 2.5+ models may return thinking parts with thought=true flag.
 * Gemini 3 also returns thoughtSignature parts (hash of thinking content).
 * Thinking parts are internal reasoning - never valid output content.
 */
function extractResponseText(parts: Array<{ text?: string; thought?: boolean; thoughtSignature?: string }> | undefined): string {
  if (!parts || parts.length === 0) return '';

  // Filter out thinking parts (thought=true) and thought signatures
  const nonThinkingParts = parts.filter(p => !p.thought && !p.thoughtSignature && p.text);
  return nonThinkingParts.map(p => p.text).join('');
}

/**
 * Build Gemini generation config with optional JSON mode
 * For Gemini 3 models, thinkingLevel: 'minimal' speeds up responses.
 */
function buildGeminiGenerationConfig(model: string, jsonMode: boolean = false): Record<string, unknown> {
  const config: Record<string, unknown> = {
    temperature: 0.3,
    maxOutputTokens: 4096,
  };

  if (jsonMode) {
    config.responseMimeType = 'application/json';
  }

  // Minimal thinking speeds up Gemini 3 responses
  if (model.startsWith('gemini-3')) {
    config.thinkingConfig = {
      thinkingLevel: 'minimal',
    };
  }

  return config;
}

/**
 * Parse SSE stream response from Gemini API
 * Extracts parts and token usage from data: {...} format lines
 */
export function parseGeminiSseStream(responseText: string): { parts: Array<{ text?: string; thought?: boolean; thoughtSignature?: string }>; tokensUsed?: number } {
  const lines = responseText.split(/\r?\n/);
  let allParts: Array<{ text?: string; thought?: boolean; thoughtSignature?: string }> = [];
  let tokensUsed: number | undefined;

  const currentEventData: string[] = [];
  const flushEvent = () => {
    if (currentEventData.length === 0) return;

    const payload = currentEventData.join('\n').trim();
    currentEventData.length = 0;
    if (!payload) return;

    // Gemini SSE uses JSON payloads; ignore OpenAI-style terminators if a proxy mixes formats.
    if (payload === '[DONE]') return;

    try {
      const data = JSON.parse(payload) as GeminiResponse;
      const parts = data.candidates?.[0]?.content?.parts;
      if (parts) allParts = allParts.concat(parts);
      if (data.usageMetadata?.totalTokenCount) tokensUsed = data.usageMetadata.totalTokenCount;
    } catch {
      // Ignore invalid/partial events (some proxies may stream pretty-printed JSON across multiple data: lines)
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Blank line = end of SSE event
    if (line === '') {
      flushEvent();
      continue;
    }

    if (!line.startsWith('data:')) continue;

    // Keep data lines verbatim (minus the "data:" prefix) and join per SSE spec.
    currentEventData.push(line.slice(5).replace(/^\s*/, ''));
  }

  flushEvent();

  // Fallback: some proxies ignore `alt=sse` and return a single JSON object.
  if (allParts.length === 0) {
    const trimmed = responseText.trim();
    if (trimmed.startsWith('{')) {
      try {
        const data = JSON.parse(trimmed) as GeminiResponse;
        const parts = data.candidates?.[0]?.content?.parts;
        if (parts) allParts = allParts.concat(parts);
        if (data.usageMetadata?.totalTokenCount) tokensUsed = data.usageMetadata.totalTokenCount;
      } catch {
        // ignore
      }
    }
  }

  return { parts: allParts, tokensUsed };
}

/**
 * Parse SSE stream response from OpenAI API
 * Extracts content deltas and token usage from data: {...} format lines
 * Stream format: data: {"choices":[{"delta":{"content":"..."}}]}
 * Final line: data: [DONE]
 */
function parseOpenAISseStream(responseText: string): { content: string; tokensUsed?: number } {
  const lines = responseText.split('\n').filter(line => line.trim());
  let content = '';
  let tokensUsed: number | undefined;

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;

    const jsonStr = line.slice(5).trim();
    if (!jsonStr || jsonStr === '[DONE]') continue;

    try {
      const data = JSON.parse(jsonStr) as OpenAIResponse;
      const delta = data.choices?.[0]?.delta?.content;
      if (delta) {
        content += delta;
      }
      if (data.usage?.total_tokens) {
        tokensUsed = data.usage.total_tokens;
      }
    } catch {
      // Skip invalid JSON lines
    }
  }

  return { content, tokensUsed };
}

/**
 * Custom timeout error for request timeouts
 */
class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Result from fetchWithTimeout - body is fully read before returning
 * so that timeout covers the entire request lifecycle
 */
interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * Fetch with timeout control
 * - firstTokenTimeoutMs: Timeout for receiving the first byte of response (0 = disabled)
 * - totalTimeoutMs: Total request timeout including body read (0 = disabled)
 * Returns the full response body if successful, throws TimeoutError on timeout
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  firstTokenTimeoutMs: number,
  totalTimeoutMs: number
): Promise<FetchResult> {
  const controller = new AbortController();
  const { signal } = controller;

  const fetchOptions: RequestInit = {
    ...options,
    signal,
  };

  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let firstTokenTimer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    if (totalTimer) clearTimeout(totalTimer);
    if (firstTokenTimer) clearTimeout(firstTokenTimer);
  };

  try {
    if (totalTimeoutMs > 0) {
      totalTimer = setTimeout(() => {
        controller.abort();
      }, totalTimeoutMs);
    }

    if (firstTokenTimeoutMs > 0) {
      firstTokenTimer = setTimeout(() => {
        controller.abort();
      }, firstTokenTimeoutMs);
    }

    const response = await fetch(url, fetchOptions);

    // First byte received, clear first token timeout
    if (firstTokenTimer) {
      clearTimeout(firstTokenTimer);
      firstTokenTimer = undefined;
    }

    // Read body fully before clearing totalTimer
    const body = await response.text();
    cleanup();

    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    cleanup();
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TimeoutError('Request timeout');
    }
    throw error;
  }
}

/**
 * Fetch with timeout and automatic retry on timeout
 * Retries up to maxRetries times on timeout
 */
async function fetchWithTimeoutAndRetry(
  url: string,
  options: RequestInit,
  config: CustomAgentConfig,
  maxRetries: number = 3
): Promise<FetchResult> {
  const firstTokenTimeoutMs = config.firstTokenTimeoutSeconds > 0 ? config.firstTokenTimeoutSeconds * 1000 : 0;
  const totalTimeoutMs = config.totalTimeoutSeconds > 0 ? config.totalTimeoutSeconds * 1000 : 0;

  // If no timeout configured, just do a normal fetch and read body
  if (firstTokenTimeoutMs === 0 && totalTimeoutMs === 0) {
    const response = await fetch(url, options);
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  }

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fetchWithTimeout(url, options, firstTokenTimeoutMs, totalTimeoutMs);
    } catch (error) {
      if (error instanceof TimeoutError) {
        lastError = error;
        logger.warn('SDK', `Request timeout, retrying (${attempt}/${maxRetries})`, {
          url,
          firstTokenTimeoutMs,
          totalTimeoutMs,
        });
        continue;
      }
      throw error;
    }
  }

  throw lastError || new TimeoutError('Request timeout after max retries');
}

/**
 * Gemini content message format
 */
interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

/**
 * OpenAI content message format
 */
interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class CustomAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent (Claude SDK) for when Custom API fails
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Start Custom agent for a session
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      const config = this.getCustomConfig();

      if (!config.apiUrl || !config.apiKey) {
        throw new Error('Custom provider not configured. Set CLAUDE_MEM_CUSTOM_API_URL and CLAUDE_MEM_CUSTOM_API_KEY in settings.');
      }

      // CRITICAL: Always load memorySessionId from database for Custom agent
      // Custom is stateless and uses synthetic IDs. We must ALWAYS use the DB value
      // to prevent FK constraint failures (observations table references memory_session_id)
      // This overrides any value set by SDKAgent fallback or cached session state.
      const dbSession = this.dbManager.getSessionStore().getSessionById(session.sessionDbId);
      if (dbSession?.memory_session_id) {
        // Use existing memory_session_id from database
        if (session.memorySessionId !== dbSession.memory_session_id) {
          logger.info('SESSION', `MEMORY_ID_RESTORED | sessionDbId=${session.sessionDbId} | was=${session.memorySessionId || 'null'} | now=${dbSession.memory_session_id} | provider=Custom`);
        }
        session.memorySessionId = dbSession.memory_session_id;
      } else if (!session.memorySessionId) {
        // Generate new synthetic ID only if none exists anywhere
        const syntheticId = `custom-${session.contentSessionId}-${Date.now()}`;
        session.memorySessionId = syntheticId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=Custom`);
      }

      // Load active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // Build initial prompt (JSON format for Custom)
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPromptJson(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPromptJson(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // Add to conversation history and query with full context (multi-turn)
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryJsonMultiTurn(session.conversationHistory, config);

      if (initResponse.content) {
        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

        await processAgentResponse(
          initResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'Custom',
          undefined,
          {
            parseJsonObservation: true,
            observationText: initResponse.content
          }
        );
      } else {
        // Model chose to skip initial observation - this is expected when prompt doesn't warrant recording
        logger.debug('SDK', 'Empty Custom init response - model chose to skip', {
          sessionId: session.sessionDbId,
          model: config.model
        });
      }

      // Process pending messages
      let lastCwd: string | undefined;

      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        if (message.cwd) {
          lastCwd = message.cwd;
        }
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }

          // Build observation prompt (still XML format for input data)
          const obsPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd
          });

          // Get valid types from mode config
          const mode = ModeManager.getInstance().getActiveMode();
          const validTypesDesc = mode.observation_types.map(t => `  - "${t.id}": ${t.description}`).join('\n');

          // Extract language instruction from footer if present (e.g., "LANGUAGE REQUIREMENTS: Please write...in 中文")
          const langMatch = mode.prompts.footer?.match(/LANGUAGE REQUIREMENTS:[^\n]+/);
          const languageInstruction = langMatch ? `\n${langMatch[0]}` : '';

          // Append JSON output format reminder with type constraints
          const obsPromptWithJsonFormat = `${obsPrompt}

IMPORTANT: Respond with ONLY a valid JSON object for the observation. No explanations, no markdown.
OUTPUT FORMAT: Return compact single-line JSON without any line breaks, indentation, or extra whitespace.

CRITICAL - type field MUST be EXACTLY one of these values:
${validTypesDesc}

{"type":"${mode.observation_types[0].id}","title":"...","narrative":"...","files_read":[...],"files_modified":[...],"concepts":[...]}${languageInstruction}`;

          session.conversationHistory.push({ role: 'user', content: obsPromptWithJsonFormat });
          const obsResponse = await this.queryJsonMultiTurn(session.conversationHistory, config);

          let tokensUsed = 0;
          if (obsResponse.content) {
            tokensUsed = obsResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          } else {
            // Model chose to skip - avoid noisy JSON parse logs and unnecessary DB transactions
            logger.debug('SDK', 'Empty Custom observation response - model chose to skip', {
              sessionId: session.sessionDbId,
              model: config.model,
              promptNumber: session.lastPromptNumber
            });
            cleanupProcessedMessages(session, worker);
            continue;
          }

          await processAgentResponse(
            obsResponse.content,
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'Custom',
            lastCwd,
            {
              parseJsonObservation: true,
              observationText: obsResponse.content
            }
          );

        } else if (message.type === 'summarize') {
          // Build JSON-format summary prompt
          const summaryPrompt = buildSummaryPromptJson({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          // Add to conversation history and query with full context (multi-turn)
          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryJsonMultiTurn(session.conversationHistory, config);

          let tokensUsed = 0;
          if (summaryResponse.content) {
            tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

            logger.debug('SDK', 'Custom JSON summary response received', {
              sessionId: session.sessionDbId,
              responseLength: summaryResponse.content.length
            });
          } else {
            logger.warn('SDK', 'Custom returned empty summary response', {
              sessionId: session.sessionDbId
            });
            cleanupProcessedMessages(session, worker);
            continue;
          }

          // Process response with JSON parser option
          await processAgentResponse(
            summaryResponse.content,
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'Custom',
            lastCwd,
            {
              parseJsonSummary: true,
              summaryText: summaryResponse.content
            }
          );
        }
      }

      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'Custom agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length
      });

    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'Custom agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'Custom API failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
          historyLength: session.conversationHistory.length
        });

        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'Custom agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  /**
   * Convert conversation history to Gemini format
   */
  private toGeminiContents(history: ConversationMessage[]): GeminiContent[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));
  }

  /**
   * Convert conversation history to OpenAI format
   */
  private toOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
  }

  /**
   * Estimate token count from text (conservative estimate)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * Truncate conversation history to prevent runaway context costs
   * Only active when maxContextMessages or maxTokens > 0
   */
  private truncateHistory(history: ConversationMessage[], config: CustomAgentConfig): ConversationMessage[] {
    const { maxContextMessages, maxTokens } = config;

    // Disabled if both limits are 0
    if (maxContextMessages <= 0 && maxTokens <= 0) {
      return history;
    }

    // Check if within limits
    const withinMessageLimit = maxContextMessages <= 0 || history.length <= maxContextMessages;
    const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
    const withinTokenLimit = maxTokens <= 0 || totalTokens <= maxTokens;

    if (withinMessageLimit && withinTokenLimit) {
      return history;
    }

    // Sliding window: keep most recent messages within limits
    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    // Process messages in reverse (most recent first)
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);

      const exceedsMessageLimit = maxContextMessages > 0 && truncated.length >= maxContextMessages;
      const exceedsTokenLimit = maxTokens > 0 && tokenCount + msgTokens > maxTokens;

      if (exceedsMessageLimit || exceedsTokenLimit) {
        logger.warn('SDK', 'Context window truncated to prevent runaway costs', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: maxTokens
        });
        break;
      }

      truncated.unshift(msg);  // Add to beginning
      tokenCount += msgTokens;
    }

    return truncated;
  }

  /**
   * Query with full conversation history (multi-turn) and JSON response enforcement
   */
  private async queryJsonMultiTurn(
    history: ConversationMessage[],
    config: CustomAgentConfig
  ): Promise<{ content: string; tokensUsed?: number }> {
    // Truncate history if limits are configured
    const truncatedHistory = this.truncateHistory(history, config);

    if (config.protocol === 'gemini') {
      if (config.streaming) {
        return this.queryGeminiJsonMultiTurnStream(truncatedHistory, config);
      }
      return this.queryGeminiJsonMultiTurn(truncatedHistory, config);
    } else {
      if (config.streaming) {
        return this.queryOpenAIJsonMultiTurnStream(truncatedHistory, config);
      }
      return this.queryOpenAIJsonMultiTurn(truncatedHistory, config);
    }
  }

  /**
   * Query Gemini API with multi-turn conversation (streaming, JSON enforced)
   */
  private async queryGeminiJsonMultiTurnStream(
    history: ConversationMessage[],
    config: CustomAgentConfig
  ): Promise<{ content: string; tokensUsed?: number }> {
    const contents = this.toGeminiContents(history);
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);
    const url = buildApiUrl(config.apiUrl, config.protocol, config.model, true);

    logger.debug('SDK', `Querying Custom/Gemini JSON multi-turn stream (${config.model})`, {
      turns: history.length,
      totalChars,
      url
    });

    const result = await fetchWithTimeoutAndRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.apiKey,
      },
      body: JSON.stringify({
        contents,
        generationConfig: buildGeminiGenerationConfig(config.model, true),
      }),
    }, config);

    if (!result.ok) {
      throw new Error(`Custom/Gemini API error: ${result.status} - ${result.body}`);
    }

    const { parts, tokensUsed } = parseGeminiSseStream(result.body);

    if (parts.length === 0) {
      logger.error('SDK', 'Empty stream response from Custom/Gemini');
      return { content: '' };
    }

    return { content: extractResponseText(parts), tokensUsed };
  }

  /**
   * Query Gemini API with multi-turn conversation (non-streaming, JSON enforced)
   */
  private async queryGeminiJsonMultiTurn(
    history: ConversationMessage[],
    config: CustomAgentConfig
  ): Promise<{ content: string; tokensUsed?: number }> {
    const contents = this.toGeminiContents(history);
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);
    const url = buildApiUrl(config.apiUrl, config.protocol, config.model);

    logger.debug('SDK', `Querying Custom/Gemini JSON multi-turn (${config.model})`, {
      turns: history.length,
      totalChars,
      url
    });

    const result = await fetchWithTimeoutAndRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.apiKey,
      },
      body: JSON.stringify({
        contents,
        generationConfig: buildGeminiGenerationConfig(config.model, true),
      }),
    }, config);

    if (!result.ok) {
      throw new Error(`Custom/Gemini API error: ${result.status} - ${result.body}`);
    }

    const data = JSON.parse(result.body) as GeminiResponse;
    const parts = data.candidates?.[0]?.content?.parts;

    if (!parts || parts.length === 0) {
      logger.error('SDK', 'Empty response from Custom/Gemini');
      return { content: '' };
    }

    return { content: extractResponseText(parts), tokensUsed: data.usageMetadata?.totalTokenCount };
  }

  /**
   * Query OpenAI API with multi-turn conversation (JSON enforced)
   */
  private async queryOpenAIJsonMultiTurn(
    history: ConversationMessage[],
    config: CustomAgentConfig
  ): Promise<{ content: string; tokensUsed?: number }> {
    const messages = this.toOpenAIMessages(history);
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);

    logger.debug('SDK', `Querying Custom/OpenAI JSON multi-turn (${config.model})`, {
      turns: history.length,
      totalChars
    });

    const url = buildApiUrl(config.apiUrl, config.protocol, config.model);

    const result = await fetchWithTimeoutAndRetry(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.3,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
      }),
    }, config);

    if (!result.ok) {
      throw new Error(`Custom/OpenAI API error: ${result.status} - ${result.body}`);
    }

    const data = JSON.parse(result.body) as OpenAIResponse;
    const content = data.choices?.[0]?.message?.content || '';
    const tokensUsed = data.usage?.total_tokens;

    return { content, tokensUsed };
  }

  /**
   * Query OpenAI API with multi-turn conversation (streaming, JSON enforced)
   */
  private async queryOpenAIJsonMultiTurnStream(
    history: ConversationMessage[],
    config: CustomAgentConfig
  ): Promise<{ content: string; tokensUsed?: number }> {
    const messages = this.toOpenAIMessages(history);
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);

    logger.debug('SDK', `Querying Custom/OpenAI JSON multi-turn stream (${config.model})`, {
      turns: history.length,
      totalChars
    });

    const url = buildApiUrl(config.apiUrl, config.protocol, config.model);

    const result = await fetchWithTimeoutAndRetry(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.3,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
        stream: true,
        stream_options: { include_usage: true },
      }),
    }, config);

    if (!result.ok) {
      throw new Error(`Custom/OpenAI API error: ${result.status} - ${result.body}`);
    }

    const { content, tokensUsed } = parseOpenAISseStream(result.body);

    if (!content) {
      logger.error('SDK', 'Empty stream response from Custom/OpenAI');
      return { content: '' };
    }

    return { content, tokensUsed };
  }

  /**
   * Get Custom configuration from settings
   */
  private getCustomConfig(): CustomAgentConfig {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    return {
      apiUrl: settings.CLAUDE_MEM_CUSTOM_API_URL || '',
      apiKey: settings.CLAUDE_MEM_CUSTOM_API_KEY || '',
      model: settings.CLAUDE_MEM_CUSTOM_MODEL || 'gpt-4o',
      protocol: (settings.CLAUDE_MEM_CUSTOM_PROTOCOL || 'openai') as CustomProtocol,
      streaming: settings.CLAUDE_MEM_CUSTOM_STREAMING !== 'false',
      maxContextMessages: parseInt(settings.CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES) || 0,
      maxTokens: parseInt(settings.CLAUDE_MEM_CUSTOM_MAX_TOKENS) || 0,
      firstTokenTimeoutSeconds: parseInt(settings.CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT) || 0,
      totalTimeoutSeconds: parseInt(settings.CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT) || 0,
    };
  }
}

/**
 * Check if Custom provider is available (has URL and API key configured)
 */
export function isCustomAvailable(): boolean {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_CUSTOM_API_URL && settings.CLAUDE_MEM_CUSTOM_API_KEY);
}

/**
 * Check if Custom is the selected provider
 */
export function isCustomSelected(): boolean {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'custom';
}

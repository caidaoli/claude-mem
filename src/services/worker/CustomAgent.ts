import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { getCredential } from '../../shared/EnvManager.js';
import { buildKeyPool, resolvePoolKeys, retryPolicyForPool, withKeyPool } from '../../shared/api-key-pool.js';
import { keysForEndpoint } from '../../shared/cmem-gateway.js';
import { iterateByteStream, readSseEvents } from '../../shared/sse-reader.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import type { WorkerRef } from './agents/index.js';
import { OpenAICompatibleProvider, anonymousSessionId, assistantText, type ObserverRequestLabel, type ProviderQueryResult } from './OpenAICompatibleProvider.js';
import { resolveSummaryTierModel } from './model-aliases.js';
import type { StepModels } from '../agent-runner/run.js';
import { classifyGeminiError } from './GeminiProvider.js';
import { classifyOpenAICompatError, isLocalEndpointUrl, stripLeadingThinkBlock } from './OpenAICompatProvider.js';
import { ClassifiedProviderError, isClassified, rateLimitUntilNextKey } from './provider-errors.js';
import { withRetry, resolveLlmTimeoutMs } from './retry.js';
import type { PaidSendBudget } from './paid-send-budget.js';
import { resolveObserverMaxOutputTokens, resolveContextWindowTokens } from './context-window.js';
import { sendChatCompletion, streamsChatCompletion, resolveStreamLiveness, resolveStreamIdleTimeoutMs } from './streamed-chat-completion.js';
import {
  endpointRejectsReasoningField, isUnknownReasoningParameter, rememberEndpointRejectsReasoningField,
  REASONING_DISABLED, resolveOpenAICompatReasoning, isLengthTruncatedEmptyReply,
  claimReasoningBudgetRetry, combineBilledChatUsage,
} from './reasoning-budget.js';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Tiktoken } from 'tiktoken';
import { encodeJsonRequestBody, parseRequestCompression, type RequestCompression } from './request-compression.js';

// tiktoken is external (wasm sidecar) and the worker bundle is shared by every
// hook, which may run from a plugin cache without node_modules. Load it on first
// use so only Custom context truncation depends on it.
const _require = typeof __filename !== 'undefined'
  ? createRequire(__filename)
  : createRequire(import.meta.url);

// Context window management constants
let tokenEncoder: Tiktoken | undefined;
const textDecoder = new TextDecoder();

function getTokenEncoder(): Tiktoken {
  tokenEncoder ??= (_require('tiktoken') as typeof import('tiktoken')).get_encoding('o200k_base');
  return tokenEncoder;
}

function estimateTokenCount(text: string): number {
  return getTokenEncoder().encode_ordinary(text).length;
}

function truncateToTokenLimit(text: string, maxTokens: number): string {
  const encoder = getTokenEncoder();
  const tokens = encoder.encode_ordinary(text);
  if (tokens.length <= maxTokens) {
    return text;
  }

  return textDecoder.decode(encoder.decode(tokens.slice(0, Math.max(1, maxTokens))));
}

// Protocol types
export type CustomProtocol = 'openai' | 'gemini' | 'codex';

// Configuration interface
export interface CustomAgentConfig {
  apiUrl: string;
  apiKey: string;
  apiKeys?: string[];
  plainText?: boolean;
  /** Standalone display-copy instructions; never persisted as observer history. */
  systemPrompt?: string;
  /** Send no output cap, so the model answers at its own length (My Work's automatic refresh). */
  uncappedOutput?: boolean;
  reasoning?: string;
  model: string;
  protocol: CustomProtocol;
  streaming: boolean;
  requestCompression?: RequestCompression;
  maxContextMessages: number;  // 0 = disabled
  maxTokens: number;  // 0 = disabled
  firstTokenTimeoutSeconds: number;  // 0 = disabled (time to first body chunk, not HTTP headers)
  totalTimeoutSeconds: number;  // 0 = shared provider deadline
}

// Fork: Custom always writes Chinese, whatever language the active mode asks for.
const CUSTOM_OBSERVATION_LANGUAGE = 'LANGUAGE REQUIREMENTS: Please write the observation data in 中文';
const CUSTOM_SUMMARY_LANGUAGE = 'LANGUAGE REQUIREMENTS: Please write ALL summary content (request, investigated, learned, completed, next_steps, notes) in 中文';
/** Per-attempt deadline for one My Work refresh step: a whole-ledger answer can take minutes. The worker checks every 10 minutes. */
const WORK_VIEW_REFRESH_TIMEOUT_MS = 10 * 60_000;

function withCustomLanguage(mode: ModeConfig): ModeConfig {
  const setLanguage = (text: string, requirement: string) =>
    `${text.replace(/\s*LANGUAGE REQUIREMENTS:[^\n]*/g, '')}\n\n${requirement}`;
  return {
    ...mode,
    prompts: {
      ...mode.prompts,
      footer: setLanguage(mode.prompts.footer, CUSTOM_OBSERVATION_LANGUAGE),
      continuation_instruction: setLanguage(mode.prompts.continuation_instruction, CUSTOM_OBSERVATION_LANGUAGE),
      summary_footer: setLanguage(mode.prompts.summary_footer, CUSTOM_SUMMARY_LANGUAGE),
      language_instruction: CUSTOM_OBSERVATION_LANGUAGE,
    },
  };
}

/**
 * Build full API URL from base URL based on protocol
 * - OpenAI: {baseUrl}/v1/chat/completions
 * - Gemini: {baseUrl}/v1beta/models/{model}:generateContent or :streamGenerateContent?alt=sse
 * - Codex: {baseUrl}/v1/responses
 */
export function buildApiUrl(baseUrl: string, protocol: CustomProtocol, model: string, streaming: boolean = false): string {
  // Remove trailing slash if present
  const cleanBaseUrl = baseUrl.replace(/\/+$/, '');

  if (protocol === 'gemini') {
    // Accept both base URLs (https://host) and partially qualified Gemini paths
    // (https://host/v1beta, https://host/v1beta/models) without duplicating segments.
    const normalizedBase = cleanBaseUrl
      .replace(/\/v1beta\/models$/i, '')
      .replace(/\/v1beta$/i, '');

    // Normalize model name (avoid "models/models/..." if user included prefix)
    const cleanModel = model.replace(/^models\//, '');
    const action = streaming ? 'streamGenerateContent' : 'generateContent';
    // Add alt=sse for streaming to ensure SSE format (data: prefix on each message)
    const sseParam = streaming ? '?alt=sse' : '';
    return `${normalizedBase}/v1beta/models/${cleanModel}:${action}${sseParam}`;
  } else if (protocol === 'codex') {
    // Allow apiUrl to be either:
    // - Base URL (https://host) -> append /v1/responses
    // - Codex-compatible base (https://host/v1) -> append /responses
    // - Full endpoint (https://host/v1/responses) -> use as-is
    if (cleanBaseUrl.endsWith('/responses')) {
      return cleanBaseUrl;
    }
    if (cleanBaseUrl.endsWith('/v1')) {
      return `${cleanBaseUrl}/responses`;
    }
    return `${cleanBaseUrl}/v1/responses`;
  } else {
    // Allow apiUrl to be either:
    // - Base URL (https://host) -> append /v1/chat/completions
    // - OpenAI compatible base (https://host/v1) -> append /chat/completions
    // - Full endpoint (https://host/v1/chat/completions) -> use as-is
    if (cleanBaseUrl.endsWith('/chat/completions')) {
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
  modelVersion?: string;
  error?: { code?: string | number; message?: string; status?: string };
  candidates?: Array<{
    finishReason?: string;
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
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

// OpenAI response types
interface OpenAIResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string;
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
  error?: {
    code?: string | number;
    message?: string;
    type?: string;
  };
}

// Codex responses API types
interface CodexResponse {
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    code?: string | number;
    message?: string;
    type?: string;
  };
}

function formatOpenAIError(errorPayload: unknown): string | null {
  if (!errorPayload) {
    return null;
  }

  if (typeof errorPayload === 'string') {
    return errorPayload;
  }

  if (typeof errorPayload !== 'object') {
    return String(errorPayload);
  }

  const errorObject = errorPayload as {
    code?: unknown;
    message?: unknown;
    type?: unknown;
  };

  const code = typeof errorObject.code === 'string' || typeof errorObject.code === 'number'
    ? String(errorObject.code)
    : 'unknown';
  const type = typeof errorObject.type === 'string' && errorObject.type
    ? ` (${errorObject.type})`
    : '';
  const message = typeof errorObject.message === 'string' && errorObject.message
    ? errorObject.message
    : 'Unknown OpenAI API error';

  return `${code}${type} - ${message}`;
}

function extractCodexResponseText(data: CodexResponse): string {
  if (typeof data.output_text === 'string' && data.output_text) {
    return data.output_text;
  }

  const parts: string[] = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string' && content.text) {
        parts.push(content.text);
      }
    }
  }

  return parts.join('');
}

/**
 * Extract non-thinking text from Gemini response parts
 * Gemini 2.5+ models may return thinking parts with thought=true flag.
 * Gemini marks internal reasoning with thought=true. A thoughtSignature is only
 * metadata and may share the same part as visible text in non-stream responses.
 */
function extractResponseText(parts: Array<{ text?: string; thought?: boolean; thoughtSignature?: string }> | undefined): string {
  if (!parts || parts.length === 0) return '';

  const nonThinkingParts = parts.filter(p => !p.thought && p.text);
  return nonThinkingParts.map(p => p.text).join('');
}

function getModelIdTail(model: string): string {
  const normalized = model.trim().toLowerCase().replace(/^models\//, '');
  const segments = normalized.split('/').filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function isGemini3Model(model: string): boolean {
  return getModelIdTail(model).startsWith('gemini-3');
}

function isGemini25FlashModel(model: string): boolean {
  return getModelIdTail(model).startsWith('gemini-2.5-flash');
}

/**
 * Build Gemini generation config with optional JSON mode
 * For Gemini 3 models, thinkingLevel: 'low' speeds up responses ('minimal' is rejected by 3.7+ Flash and Pro).
 */
function buildGeminiGenerationConfig(model: string, jsonMode: boolean, reasoningOff: boolean, maxOutputTokens: number | undefined): Record<string, unknown> {
  const config: Record<string, unknown> = {
    temperature: 0.3,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };

  if (jsonMode) {
    config.responseMimeType = 'application/json';
  }

  // Lowest level supported by every Gemini 3.x model
  if (reasoningOff && isGemini3Model(model)) {
    config.thinkingConfig = {
      thinkingLevel: 'low',
    };
  } else if (reasoningOff && isGemini25FlashModel(model)) {
    config.thinkingConfig = {
      thinkingBudget: 0,
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
function parseOpenAISseStream(responseText: string): { content: string; tokensUsed?: number; error?: string } {
  const lines = responseText.split(/\r?\n/);
  let content = '';
  let tokensUsed: number | undefined;
  let apiError: string | undefined;

  const currentEventData: string[] = [];
  const flushEvent = () => {
    if (currentEventData.length === 0) return;

    const payload = currentEventData.join('\n').trim();
    currentEventData.length = 0;
    if (!payload || payload === '[DONE]') return;

    try {
      const data = JSON.parse(payload) as OpenAIResponse;
      const errorMessage = formatOpenAIError(data.error);
      if (errorMessage) {
        apiError = errorMessage;
        return;
      }

      const streamedContent = data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content;
      if (streamedContent) {
        content += streamedContent;
      }
      if (data.usage?.total_tokens) {
        tokensUsed = data.usage.total_tokens;
      }
    } catch {
      // Skip invalid JSON events
    }
  };

  for (const line of lines) {
    const trimmedLine = line.trimEnd();
    if (trimmedLine === '') {
      flushEvent();
      continue;
    }

    if (!trimmedLine.startsWith('data:')) continue;

    currentEventData.push(trimmedLine.slice(5).replace(/^\s*/, ''));
  }

  flushEvent();

  // Fallback: some providers ignore stream mode and return a single JSON object.
  if (!content) {
    const trimmed = responseText.trim();
    if (trimmed.startsWith('{')) {
      try {
        const data = JSON.parse(trimmed) as OpenAIResponse;
        const errorMessage = formatOpenAIError(data.error);
        if (errorMessage) {
          apiError = errorMessage;
        }

        content = data.choices?.[0]?.message?.content || '';
        if (data.usage?.total_tokens) {
          tokensUsed = data.usage.total_tokens;
        }
      } catch {
        // ignore fallback parse errors
      }
    }
  }

  return { content, tokensUsed, error: apiError };
}

/**
 * OpenAI content message format
 */
interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

function buildOpenAIJsonRequestBody(
  model: string,
  messages: OpenAIMessage[],
  streaming: boolean,
  sessionId?: string
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    temperature: 0.3,
    max_tokens: resolveObserverMaxOutputTokens(),
    response_format: { type: 'json_object' },
  };

  if (model.startsWith('gpt-')) {
    body.reasoning_effort = 'low';
  }

  if (isGemini3Model(model)) {
    body.thinkingConfig = {
      thinkingLevel: 'low',
    };
  }

  if (model.trim().toLowerCase().startsWith('mimo')) {
    body.thinking = { type: 'disabled' };
  }

  if (streaming) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  if (sessionId && sessionId.trim()) {
    body.prompt_cache_key = sessionId.trim();
  }

  body.messages = messages;

  return body;
}

function buildBearerJsonHeaders(apiKey: string, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    'Content-Type': 'application/json',
  };

  if (sessionId && sessionId.trim()) {
    headers.Session_id = sessionId.trim();
  }

  return headers;
}

function buildGeminiJsonHeaders(apiKey: string, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
  };

  if (sessionId && sessionId.trim()) {
    headers.Session_id = sessionId.trim();
  }

  return headers;
}

function buildCodexJsonRequestBody(
  model: string,
  messages: OpenAIMessage[],
  streaming: boolean,
  sessionId?: string
): Record<string, unknown> {
  const input = messages.map(message => ({
    type: 'message' as const,
    role: message.role,
    content: [{
      type: message.role === 'assistant' ? 'output_text' as const : 'input_text' as const,
      text: message.content
    }]
  }));

  const body: Record<string, unknown> = {
    model,
    instructions: 'You are GPT-5.4 running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI. You are expected to be precise, safe, and helpful.\n\n',
    input,
    max_output_tokens: resolveObserverMaxOutputTokens(),
    text: {
      format: { type: 'json_object' }
    }
  };

  if (model.startsWith('gpt-')) {
    body.reasoning = { effort: 'low' };
  }

  if (streaming) {
    body.stream = true;
  }

  if (sessionId && sessionId.trim()) {
    body.prompt_cache_key = sessionId.trim();
  }

  return body;
}

const CUSTOM_PROTOCOLS: ReadonlyArray<CustomProtocol> = ['openai', 'gemini', 'codex'];

function parseCustomProtocol(rawProtocol: unknown): CustomProtocol {
  if (typeof rawProtocol === 'string') {
    const normalized = rawProtocol.trim().toLowerCase();
    if ((CUSTOM_PROTOCOLS as ReadonlyArray<string>).includes(normalized)) {
      return normalized as CustomProtocol;
    }
  }

  logger.warn('SDK', 'Invalid custom protocol configured, falling back to openai', {
    configured: rawProtocol,
    validProtocols: CUSTOM_PROTOCOLS
  });

  return 'openai';
}

function parseOptionalPositiveInt(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function resolveRequestSessionId(contentSessionId: string): { sessionId: string; generated: boolean } {
  const normalizedContentSessionId = contentSessionId.trim();
  if (normalizedContentSessionId) {
    return { sessionId: normalizedContentSessionId, generated: false };
  }

  return {
    sessionId: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    generated: true
  };
}

export class CustomAgent extends OpenAICompatibleProvider<CustomAgentConfig> {
  protected readonly providerName = 'Custom';
  protected readonly syntheticIdPrefix = 'custom';
  protected readonly outputFormat = 'json' as const;
  protected readonly humanCopyLanguage = '中文';
  protected readonly forwardEmptyMessageResponse = true;
  protected readonly rejectAbortedObservation = true;
  private tailStartIndex = new WeakMap<ActiveSession, number>();

  protected getMode(): ModeConfig {
    return withCustomLanguage(ModeManager.getInstance().getActiveMode());
  }

  protected getConfig(): CustomAgentConfig {
    return resolveCustomConfig();
  }

  protected missingApiKeyError(): Error {
    return new ClassifiedProviderError('Custom provider not configured. Set CLAUDE_MEM_CUSTOM_API_URL and CLAUDE_MEM_CUSTOM_API_KEY (or CUSTOM_API_KEY) for hosted endpoints.', {
      kind: 'setup_required', cause: new Error('missing custom endpoint or credential'),
    });
  }

  protected requiresApiKey(config: CustomAgentConfig): boolean {
    return !isLocalEndpointUrl(config.apiUrl);
  }

  protected querySignal(session: ActiveSession): AbortSignal {
    return session.abortController.signal;
  }

  protected prepareSessionExtras(session: ActiveSession): void {
    session.endpointClass = 'custom';
  }

  protected prepareQueryHistory(history: ConversationMessage[], config: CustomAgentConfig, session: ActiveSession): ConversationMessage[] {
    return this.truncateHistory(history, config, session);
  }

  protected resolveContextWindow(config: CustomAgentConfig): Promise<number> {
    return resolveContextWindowTokens(config.protocol === 'gemini' ? 'gemini' : 'openrouter', config.model.replace(/^models\//, ''), config.apiUrl);
  }

  protected estimateTokens(text: string): number {
    return estimateTokenCount(text);
  }

  protected buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'] {
    return typeof result.inputTokens === 'number' && typeof result.outputTokens === 'number'
      ? { input: result.inputTokens, output: result.outputTokens }
      : null;
  }

  /** One read-only question from My Work's automatic refresh (refresh-task.ts), answered as text the
   * refresh parses. Careful steps ask for `$TIER:summary`, resolved like session summaries; the rest use the Custom model. */
  async askRefresh(prompt: string, models: StepModels): Promise<string> {
    const config = this.getConfig();
    if (!config.apiKey && this.requiresApiKey(config)) throw this.missingApiKeyError();
    const model = models.custom?.model === '$TIER:summary'
      ? resolveSummaryTierModel(config.model, SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH))
      : config.model;
    const sessionId = anonymousSessionId(`work-view-refresh:${prompt}`);
    // One long background answer: the observer's output cap and first-token/total timeouts do not apply, only its own deadline.
    const result = await this.query(
      [{ role: 'user', content: prompt }], { ...config, model, uncappedOutput: true, firstTokenTimeoutSeconds: 0, totalTimeoutSeconds: 0 },
      undefined, WORK_VIEW_REFRESH_TIMEOUT_MS, undefined,
      { kind: 'work_view_refresh', sessionId, contentSessionId: `work-view-refresh-${sessionId}` },
    );
    if (!result.content?.trim()) throw new Error(`${this.providerName} returned no text for the My Work refresh (finish reason: ${result.finishReason ?? 'unknown'})`);
    return result.content;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    // The persisted id is the FK target even when a fallback left another id in memory.
    const persisted = this.dbManager.getSessionStore().getSessionById(session.sessionDbId)?.memory_session_id;
    if (persisted) session.memorySessionId = persisted;
    else if (!session.memorySessionId) {
      session.memorySessionId = `custom-${session.contentSessionId}-${Date.now()}`;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, session.memorySessionId);
    }
    return super.startSession(session, worker);
  }

  private buildLatestUserFallback(
    history: ConversationMessage[],
    maxTokens: number
  ): { message: ConversationMessage; wasTruncated: boolean; originalTokens: number; fallbackTokens: number } {
    const latestUserMessage = [...history].reverse().find(msg => msg.role === 'user');
    const originalContent = latestUserMessage?.content || '';
    const originalTokens = this.estimateTokens(originalContent);

    if (!originalContent || maxTokens <= 0 || originalTokens <= maxTokens) {
      return {
        message: { role: 'user', content: originalContent },
        wasTruncated: false,
        originalTokens,
        fallbackTokens: originalTokens
      };
    }

    const truncatedContent = truncateToTokenLimit(originalContent, maxTokens);
    const fallbackTokens = this.estimateTokens(truncatedContent);

    return {
      message: { role: 'user', content: truncatedContent },
      wasTruncated: true,
      originalTokens,
      fallbackTokens
    };
  }

  /**
   * Truncate conversation history for prompt-cache-friendly context management.
   *
   * Two strategies:
   * 1. Hysteresis batched reset (when `session` provided and maxContextMessages > 0):
   *    - Within reset interval (history.length ≤ max): no truncation.
   *    - On first overflow: fix tail start index at `history.length - K`
   *      (K = max/3). Persist index on session — subsequent turns only append,
   *      so prefix `[head, ...history.slice(startIdx)]` is byte-identical across
   *      turns, letting prompt cache hit on the full prefix.
   *    - When tail grows back to max: clear index so next turn resets.
   * 2. Anchored head + sliding tail (fallback when hysteresis not applicable):
   *    - Keep head[0] stable, slide tail by tokens only.
   *
   * Head anchor + alternation alignment are common to both paths.
   * Only active when maxContextMessages or maxTokens > 0.
   */
  private truncateHistory(
    history: ConversationMessage[],
    config: CustomAgentConfig,
    session?: ActiveSession
  ): ConversationMessage[] {
    const { maxContextMessages, maxTokens } = config;

    if (maxContextMessages <= 0 && maxTokens <= 0) {
      return history;
    }
    if (history.length === 0) {
      return history;
    }

    const head = history[0];
    const useHysteresis = session !== undefined && maxContextMessages > 0;

    // === Hysteresis batched reset path ===
    if (useHysteresis) {
      const activeSession = session as ActiveSession;

      // Within reset interval: no truncation, clear any stale buffer state.
      if (history.length <= maxContextMessages) {
        this.tailStartIndex.delete(activeSession);
        return this.enforceTokenLimit(history, head, maxTokens);
      }

      // Exceeded threshold — fix tail start index on first hit.
      const K = Math.max(1, Math.floor(maxContextMessages / 3));
      let startIdx = this.tailStartIndex.get(activeSession);
      if (startIdx === undefined) {
        startIdx = history.length - K;
      }

      // Alignment: tail must start with the role opposite to head (assistant).
      // Advance past leading same-role messages to preserve strict alternation.
      while (startIdx < history.length && history[startIdx].role === head.role) {
        startIdx++;
      }
      this.tailStartIndex.set(activeSession, startIdx);

      const tail = history.slice(startIdx);

      // Tail has grown back to the threshold — clear index so next turn resets.
      // Current turn still returns the full tail; the reset kicks in next call.
      if (tail.length >= maxContextMessages) {
        this.tailStartIndex.delete(activeSession);
      }

      if (tail.length === 0) {
        const fallback = this.buildLatestUserFallback(history, maxTokens);
        logger.warn('SDK', 'Hysteresis tail empty after alignment, falling back to latest user only', {
          originalMessages: history.length,
          startIdx,
          messageLimit: maxContextMessages,
          fallbackOriginalTokens: fallback.originalTokens,
          fallbackTokens: fallback.fallbackTokens,
          fallbackWasTruncated: fallback.wasTruncated
        });
        return [fallback.message];
      }

      logger.debug('SDK', 'Hysteresis window active with head anchored for cache stability', {
        originalMessages: history.length,
        keptMessages: 1 + tail.length,
        startIdx,
        tailResetAtMax: tail.length >= maxContextMessages
      });

      return this.enforceTokenLimit([head, ...tail], head, maxTokens);
    }

    // === Anchored head + sliding tail path (no hysteresis available) ===
    let rest = history.slice(1);
    const maxTailMessages = maxContextMessages > 0
      ? Math.max(0, maxContextMessages - 1)
      : Number.POSITIVE_INFINITY;
    const messageLimitApplied = Number.isFinite(maxTailMessages) && rest.length > maxTailMessages;

    if (messageLimitApplied) {
      rest = maxTailMessages === 0 ? [] : rest.slice(-maxTailMessages);

      while (rest.length > 0 && rest[0].role === head.role) {
        rest.shift();
      }

      if (rest.length === 0) {
        if (head.role === 'user') {
          return this.enforceTokenLimit([head], head, maxTokens);
        }

        const fallback = this.buildLatestUserFallback(history, maxTokens);
        logger.warn('SDK', 'Sliding tail empty after message-limit alignment, falling back to latest user input only', {
          originalMessages: history.length,
          messageLimit: maxContextMessages,
          fallbackOriginalTokens: fallback.originalTokens,
          fallbackTokens: fallback.fallbackTokens,
          fallbackWasTruncated: fallback.wasTruncated
        });
        return [fallback.message];
      }
    }

    const headTokens = this.estimateTokens(head.content);
    const tokenBudget = maxTokens > 0 ? maxTokens - headTokens : Number.POSITIVE_INFINITY;

    if (tokenBudget <= 0) {
      const fallback = this.buildLatestUserFallback(history, maxTokens);
      logger.warn('SDK', 'Head prompt exceeds token budget, falling back to latest user input only', {
        headTokens,
        tokenLimit: maxTokens,
        fallbackOriginalTokens: fallback.originalTokens,
        fallbackTokens: fallback.fallbackTokens,
        fallbackWasTruncated: fallback.wasTruncated
      });
      return [fallback.message];
    }

    const restTokens = rest.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
    if (restTokens <= tokenBudget) {
      return [head, ...rest];
    }

    const tail: ConversationMessage[] = [];
    let tailTokens = 0;
    for (let i = rest.length - 1; i >= 0; i--) {
      const msgTokens = this.estimateTokens(rest[i].content);
      if (tailTokens + msgTokens > tokenBudget) {
        break;
      }
      tail.unshift(rest[i]);
      tailTokens += msgTokens;
    }

    while (tail.length > 0 && tail[0].role === head.role) {
      tail.shift();
    }

    if (tail.length === 0) {
      const fallback = this.buildLatestUserFallback(history, maxTokens);
      logger.warn('SDK', 'Sliding tail empty after alignment, falling back to latest user input only', {
        originalMessages: history.length,
        tokenLimit: maxTokens,
        headTokens,
        fallbackOriginalTokens: fallback.originalTokens,
        fallbackTokens: fallback.fallbackTokens,
        fallbackWasTruncated: fallback.wasTruncated
      });
      return [fallback.message];
    }

    return [head, ...tail];
  }

  /**
   * Enforce maxTokens as a secondary constraint on an already-selected message set.
   * Preserves head; trims tail from the oldest end if total tokens exceed budget.
   */
  private enforceTokenLimit(
    messages: ConversationMessage[],
    head: ConversationMessage,
    maxTokens: number
  ): ConversationMessage[] {
    if (maxTokens <= 0 || messages.length === 0) {
      return messages;
    }

    const totalTokens = messages.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
    if (totalTokens <= maxTokens) {
      return messages;
    }

    const headTokens = this.estimateTokens(head.content);
    if (headTokens >= maxTokens) {
      const fallback = this.buildLatestUserFallback(messages, maxTokens);
      logger.warn('SDK', 'Head alone exceeds token budget, degrading to latest user fallback', {
        headTokens,
        tokenLimit: maxTokens
      });
      return [fallback.message];
    }

    const budget = maxTokens - headTokens;
    const rest = messages[0] === head ? messages.slice(1) : messages;
    const kept: ConversationMessage[] = [];
    let tokenCount = 0;
    for (let i = rest.length - 1; i >= 0; i--) {
      const t = this.estimateTokens(rest[i].content);
      if (tokenCount + t > budget) {
        break;
      }
      kept.unshift(rest[i]);
      tokenCount += t;
    }

    while (kept.length > 0 && kept[0].role === head.role) {
      kept.shift();
    }

    if (kept.length === 0) {
      const fallback = this.buildLatestUserFallback(messages, maxTokens);
      logger.warn('SDK', 'Token enforcement left tail empty, falling back to latest user only', {
        tokenLimit: maxTokens,
        headTokens
      });
      return [fallback.message];
    }

    logger.debug('SDK', 'Token limit enforced; head preserved for cache stability', {
      originalMessages: messages.length,
      keptMessages: 1 + kept.length,
      tokenLimit: maxTokens,
      headTokens,
      tailTokens: tokenCount
    });

    return [head, ...kept];
  }

  protected async query(
    history: ConversationMessage[],
    config: CustomAgentConfig,
    signal?: AbortSignal,
    perAttemptTimeoutMs?: number,
    paidSendBudget?: PaidSendBudget,
    label?: ObserverRequestLabel,
  ): Promise<ProviderQueryResult> {
    if (!config.apiUrl || !config.model) throw this.missingApiKeyError();
    const url = buildApiUrl(config.apiUrl, config.protocol, config.model, config.streaming);
    const sessionId = label?.contentSessionId !== undefined
      ? (label.contentSessionId.trim() || (label.generationId ? `custom-${label.generationId}` : resolveRequestSessionId('').sessionId))
      : undefined;
    const messages = this.conversationToOpenAIMessages(history, config.systemPrompt);
    const plainText = config.plainText || label?.kind === 'field_compression' || label?.kind === 'telegram_wrapup';
    const maxOutputTokens = config.uncappedOutput ? undefined : resolveObserverMaxOutputTokens();
    const reasoningOff = resolveOpenAICompatReasoning(config.reasoning) !== 'on';
    const clientAttemptId = paidSendBudget?.clientAttemptId ?? randomUUID();
    const timeoutMs = config.totalTimeoutSeconds > 0
      ? Math.min(perAttemptTimeoutMs ?? Infinity, config.totalTimeoutSeconds * 1000)
      : perAttemptTimeoutMs;
    const streamed = config.protocol === 'openai' && config.streaming && streamsChatCompletion(url);
    const liveness = {
      ...resolveStreamLiveness(timeoutMs ?? (streamed ? undefined : resolveLlmTimeoutMs()), resolveStreamIdleTimeoutMs()),
      ...(config.firstTokenTimeoutSeconds > 0 ? { firstChunkTimeoutMs: config.firstTokenTimeoutSeconds * 1000 } : {}),
    };

    return withKeyPool({ poolId: 'custom', keys: resolvePoolKeys(config), label: `Custom/${config.protocol}`, rateLimitUntilNextKey }, ({ key, poolSize }) =>
      withRetry(async attemptSignal => {
        if (config.protocol !== 'openai') {
          const body = config.protocol === 'gemini'
            ? {
              generationConfig: buildGeminiGenerationConfig(config.model, !plainText, reasoningOff, maxOutputTokens),
              ...(messages.some(message => message.role === 'system') ? {
                systemInstruction: { parts: messages.filter(message => message.role === 'system').map(message => ({ text: message.content })) },
              } : {}),
              contents: messages.filter(message => message.role !== 'system').map(message => ({
                role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }],
              })),
            }
            : buildCodexJsonRequestBody(config.model, messages, config.streaming, sessionId);
          if (config.protocol === 'codex') {
            if (plainText) delete body.text;
            if (!reasoningOff) delete body.reasoning;
            if (maxOutputTokens === undefined) delete body.max_output_tokens;
          }
          return this.queryNative(url, body, config, key, attemptSignal, sessionId, clientAttemptId);
        }

        const body = buildOpenAIJsonRequestBody(config.model, messages, streamed, sessionId);
        delete body.max_tokens;
        if (plainText) delete body.response_format;
        if (!reasoningOff) {
          delete body.reasoning_effort;
          delete body.thinkingConfig;
          delete body.thinking;
        }
        const send = async (reasoning: boolean) => {
          const exchange = await sendChatCompletion({
            url,
            headers: { ...buildBearerJsonHeaders(key, sessionId), 'x-client-request-id': clientAttemptId },
            body: { ...body, ...(reasoning ? { reasoning: REASONING_DISABLED } : {}) },
            requestCompression: config.requestCompression,
            maxOutputTokens,
            signal: attemptSignal,
            liveness,
            stream: streamed,
            nonStreamTimeoutMs: timeoutMs ?? resolveLlmTimeoutMs(),
            label: 'Custom/OpenAI',
            classify: input => classifyOpenAICompatError({ ...input, endpointLabel: 'Custom/OpenAI', requestUrl: url }),
          });
          const data = exchange.body as OpenAIResponse;
          if (data.error) throw classifyOpenAICompatError({
            status: exchange.status, bodyText: JSON.stringify(data), headers: exchange.headers,
            cause: new Error(formatOpenAIError(data.error) ?? 'Custom/OpenAI error'), endpointLabel: 'Custom/OpenAI', requestUrl: url,
          });
          return data;
        };
        let data: OpenAIResponse;
        const includeReasoning = reasoningOff && !endpointRejectsReasoningField(url);
        try {
          data = await send(includeReasoning);
        } catch (error) {
          const detail = error instanceof Error ? `${error.message}\n${error.cause instanceof Error ? error.cause.message : ''}` : String(error);
          if (!includeReasoning || !isClassified(error) || error.kind !== 'unrecoverable' || !isUnknownReasoningParameter(detail)) throw error;
          rememberEndpointRejectsReasoningField(url);
          data = await send(false);
        }
        let choice = data.choices?.[0];
        const firstContent = stripLeadingThinkBlock(assistantText(choice?.message?.content));
        if (isLengthTruncatedEmptyReply(firstContent, choice?.finish_reason) && !reasoningOff && !endpointRejectsReasoningField(url)
          && (!paidSendBudget || paidSendBudget.spentPaidSends + 1 < paidSendBudget.maxPaidSends)
          && claimReasoningBudgetRetry(paidSendBudget)) {
          const firstUsage = data.usage;
          // Only the known empty-reasoning failure buys one extra send, under the same budget/deadline.
          try {
            data = await send(true);
            const combined = combineBilledChatUsage(
              { promptTokens: firstUsage?.prompt_tokens, completionTokens: firstUsage?.completion_tokens, totalTokens: firstUsage?.total_tokens },
              { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens, totalTokens: data.usage?.total_tokens },
            );
            data.usage = { prompt_tokens: combined.promptTokens, completion_tokens: combined.completionTokens, total_tokens: combined.totalTokens };
            choice = data.choices?.[0];
          } catch (error) {
            if (signal?.aborted) throw error;
            logger.warn('SDK', 'Custom/OpenAI reasoning retry failed; keeping the billed empty reply', {}, error as Error);
          }
        }
        return {
          content: stripLeadingThinkBlock(assistantText(choice?.message?.content)),
          inputTokens: data.usage?.prompt_tokens,
          outputTokens: data.usage?.completion_tokens,
          tokensUsed: data.usage?.total_tokens,
          servedModel: data.model,
          finishReason: choice?.finish_reason,
        };
      }, {
        label: `Custom/${config.protocol} ${config.model}`,
        abortSignal: signal,
        perAttemptTimeoutMs: timeoutMs,
        paidSendBudget,
        clientAttemptId,
        ...(config.protocol === 'openai' ? { attemptDeadlineOwnedByCaller: true, ...(streamed ? { retryBeforeOutput: true } : {}) } : {}),
        // Condensation has its own outer deadline and cannot start a retry after it.
        ...(label?.kind === 'field_compression' ? { maxRetries: 0 } : {}),
        ...retryPolicyForPool(poolSize),
      }),
    );
  }

  /** Native Gemini and Responses share framing, cancellation and failure accounting. */
  private async queryNative(
    url: string,
    body: Record<string, unknown>,
    config: CustomAgentConfig,
    apiKey: string,
    signal: AbortSignal,
    sessionId: string | undefined,
    clientAttemptId: string,
  ): Promise<ProviderQueryResult> {
    const controller = new AbortController();
    let firstTokenTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let response: Response | undefined;
    let outputStarted = false;
    let bodyStarted = false;
    let terminal = false;
    let content = '';
    let completedText = '';
    let result: ProviderQueryResult = { content: '' };
    const label = `Custom/${config.protocol === 'gemini' ? 'Gemini' : 'Codex'}`;
    const classify = (cause: unknown, status?: number, bodyText?: string, headers?: Headers) => {
      if (config.protocol === 'gemini') {
        // Native Gemini has structured quota windows, retry hints and 400 auth failures.
        if (status !== undefined && status >= 200 && status < 300 && bodyText) {
          try {
            const code = Number(JSON.parse(bodyText)?.error?.code);
            if (Number.isInteger(code) && code >= 400 && code < 600) status = code;
          } catch { /* The output parser reports malformed response bodies. */ }
        }
        return classifyGeminiError({ cause, status, bodyText, headers });
      }
      return classifyOpenAICompatError({ cause, status, bodyText, headers, endpointLabel: label, requestUrl: url });
    };
    const abort = () => controller.abort(signal.reason);
    const timeout = () => controller.abort(new Error(`${label} request timeout`));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    if (config.firstTokenTimeoutSeconds > 0) firstTokenTimer = setTimeout(timeout, config.firstTokenTimeoutSeconds * 1000);
    if (config.totalTimeoutSeconds > 0) totalTimer = setTimeout(timeout, config.totalTimeoutSeconds * 1000);

    const apply = (data: GeminiResponse & CodexResponse & { type?: string; delta?: string; text?: string; response?: CodexResponse }) => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('response is not a JSON object');
      const nested = data.response;
      if (data.error || nested?.error) {
        throw classify(new Error(formatOpenAIError(data.error ?? nested?.error) ?? 'API error'), response?.status,
          JSON.stringify({ error: data.error ?? nested?.error }), response?.headers);
      }
      if (config.protocol === 'gemini') {
        const candidate = data.candidates?.[0];
        const parts = candidate?.content?.parts;
        if (parts?.some(part => !!part.text)) outputStarted = true;
        content += extractResponseText(parts);
        if (candidate?.finishReason) { terminal = true; result.finishReason = candidate.finishReason; }
        if (data.modelVersion) result.servedModel = data.modelVersion;
        if (data.usageMetadata) {
          result.inputTokens = data.usageMetadata.promptTokenCount;
          const candidates = data.usageMetadata.candidatesTokenCount;
          const thoughts = data.usageMetadata.thoughtsTokenCount;
          result.outputTokens = candidates === undefined && thoughts === undefined ? undefined : (candidates ?? 0) + (thoughts ?? 0);
          result.tokensUsed = data.usageMetadata.totalTokenCount;
        }
        return;
      }
      if (data.type === 'response.output_text.delta' && typeof data.delta === 'string') {
        content += data.delta;
        outputStarted ||= !!data.delta;
      } else if (data.type === 'response.output_text.done' && typeof data.text === 'string') {
        // Multiple output parts each emit done: their full text must not replace earlier parts.
        if (!content) completedText += data.text;
        outputStarted ||= !!data.text;
      } else if (data.type?.includes('reasoning') && (data.delta || data.text)) {
        outputStarted = true;
      }
      const payload = nested ?? data;
      const fullText = extractCodexResponseText(payload);
      if (fullText) { completedText = fullText; outputStarted = true; }
      if (payload.model) result.servedModel = payload.model;
      if (payload.usage) {
        result.inputTokens = payload.usage.input_tokens;
        result.outputTokens = payload.usage.output_tokens;
        result.tokensUsed = payload.usage.total_tokens;
      }
      if (payload.status === 'failed' || data.type === 'response.failed' || data.type === 'error') {
        throw new Error(`${label} response failed`);
      }
      if (payload.status === 'incomplete' || data.type === 'response.incomplete') {
        terminal = true;
        result.finishReason = payload.incomplete_details?.reason === 'max_output_tokens' ? 'length' : payload.incomplete_details?.reason ?? 'incomplete';
      } else if (payload.status === 'completed' || data.type === 'response.completed') {
        terminal = true;
        result.finishReason = 'stop';
      }
    };

    try {
      const encoded = await encodeJsonRequestBody(body, config.requestCompression);
      response = await fetch(url, {
        method: 'POST',
        headers: {
          ...(config.protocol === 'gemini' ? buildGeminiJsonHeaders(apiKey, sessionId) : buildBearerJsonHeaders(apiKey, sessionId)),
          'x-client-request-id': clientAttemptId,
          ...encoded.headers,
        },
        body: encoded.body, signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw classify(new Error(`${label} HTTP ${response.status}`), response.status, text, response.headers);
      }
      const read = async () => {
        const chunks = (async function* () {
          if (!response!.body) return;
          for await (const chunk of iterateByteStream(response!.body)) {
            if (chunk.byteLength) bodyStarted = true;
            if (chunk.byteLength && firstTokenTimer) { clearTimeout(firstTokenTimer); firstTokenTimer = undefined; }
            yield chunk;
          }
        })();
        // Sniff framing as well as Content-Type: gateways sometimes preserve neither stream flag nor header.
        const iterator = chunks[Symbol.asyncIterator]();
        const leading: Uint8Array[] = [];
        let prefix = '';
        let done = false;
        while (prefix.trim().length < 6) {
          const part = await iterator.next();
          if (part.done) { done = true; break; }
          leading.push(part.value);
          prefix += new TextDecoder().decode(part.value);
        }
        const source = (async function* () {
          try {
            yield* leading;
            if (!done) while (true) {
              const part = await iterator.next();
              if (part.done) break;
              yield part.value;
            }
          } finally { await iterator.return?.(); }
        })();
        const sse = (response!.headers.get('content-type') ?? '').includes('text/event-stream') || /^\s*(?:data:|event:|id:|retry:|:)/.test(prefix);
        if (sse) {
          for await (const event of readSseEvents(source)) {
            if (event.data === '[DONE]') { terminal = true; break; }
            if (event.data) apply(JSON.parse(event.data));
          }
          if (!terminal) throw new Error('stream ended before the reply finished');
        } else {
          const decoder = new TextDecoder();
          let text = '';
          for await (const chunk of source) text += decoder.decode(chunk, { stream: true });
          apply(JSON.parse(text + decoder.decode()));
        }
      };
      let rejectAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(controller.signal.reason ?? new DOMException('Aborted', 'AbortError'));
        if (controller.signal.aborted) rejectAbort();
        else controller.signal.addEventListener('abort', rejectAbort, { once: true });
      });
      try { await Promise.race([read(), aborted]); }
      finally { if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort); }
      return { ...result, content: completedText || content };
    } catch (error) {
      if (signal.aborted) throw error;
      if (isClassified(error) && !outputStarted) throw error;
      if (outputStarted || (bodyStarted && response?.ok)) throw new ClassifiedProviderError(`${label} response could not be read: ${error instanceof Error ? error.message : String(error)}`, {
        kind: 'unrecoverable', paidSendOutcome: 'output_failure', cause: error,
      });
      throw classify(error);
    } finally {
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      if (totalTimer) clearTimeout(totalTimer);
      signal.removeEventListener('abort', abort);
      controller.abort();
    }
  }
}

export function resolveCustomConfig(settingsPath: string = USER_SETTINGS_PATH): CustomAgentConfig {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const apiUrl = (settings.CLAUDE_MEM_CUSTOM_API_URL || '').trim();
  const apiKeys = keysForEndpoint(apiUrl, buildKeyPool(
    settings.CLAUDE_MEM_CUSTOM_API_KEY || getCredential('CUSTOM_API_KEY') || '',
    settings.CLAUDE_MEM_CUSTOM_API_KEYS || getCredential('CUSTOM_API_KEYS') || '',
  ));
  return {
    apiUrl, apiKey: apiKeys[0] ?? '', apiKeys,
    model: (settings.CLAUDE_MEM_CUSTOM_MODEL || 'gpt-4o').trim(),
    protocol: parseCustomProtocol(settings.CLAUDE_MEM_CUSTOM_PROTOCOL),
    streaming: settings.CLAUDE_MEM_CUSTOM_STREAMING !== 'false',
    requestCompression: parseRequestCompression(settings.CLAUDE_MEM_CUSTOM_REQUEST_COMPRESSION),
    reasoning: settings.CLAUDE_MEM_CUSTOM_REASONING,
    maxContextMessages: parseOptionalPositiveInt(settings.CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES),
    maxTokens: parseOptionalPositiveInt(settings.CLAUDE_MEM_CUSTOM_MAX_TOKENS),
    firstTokenTimeoutSeconds: parseOptionalPositiveInt(settings.CLAUDE_MEM_CUSTOM_FIRST_TOKEN_TIMEOUT),
    totalTimeoutSeconds: parseOptionalPositiveInt(settings.CLAUDE_MEM_CUSTOM_TOTAL_TIMEOUT),
  };
}

export function isCustomAvailable(settingsPath: string = USER_SETTINGS_PATH): boolean {
  const config = resolveCustomConfig(settingsPath);
  return !!(config.apiUrl && config.model && (config.apiKeys?.length || isLocalEndpointUrl(config.apiUrl)));
}

export function isCustomSelected(): boolean {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_PROVIDER === 'custom';
}

export const __testOnly = { parseOpenAISseStream, parseCustomProtocol, parseOptionalPositiveInt };

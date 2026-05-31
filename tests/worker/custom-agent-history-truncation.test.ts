import { describe, it, expect } from 'bun:test';

import { CustomAgent } from '../../src/services/worker/CustomAgent.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';

describe('CustomAgent history truncation', () => {
  it('estimates token counts with tiktoken instead of character division', () => {
    const agent = new CustomAgent({} as any, {} as any);
    const estimateTokens = (agent as any).estimateTokens.bind(agent) as (text: string) => number;

    expect(estimateTokens('hello world')).toBe(2);
  });

  it('keeps most recent messages when truncating by message count', () => {
    const agent = new CustomAgent({} as any, {} as any);
    const truncateHistory = (agent as any).truncateHistory.bind(agent) as (
      history: ConversationMessage[],
      config: { maxContextMessages: number; maxTokens: number }
    ) => ConversationMessage[];

    const history: ConversationMessage[] = [
      { role: 'user', content: 'INIT_PROMPT' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'U2' },
      { role: 'assistant', content: 'A2' },
      { role: 'user', content: 'U3' },
      { role: 'assistant', content: 'A3' },
      { role: 'user', content: 'U4' },
    ];

    const truncated = truncateHistory(history, { maxContextMessages: 4, maxTokens: 0 });

    // Head stays anchored for prompt-cache stability. The tail is sliced and
    // aligned so it starts with the opposite role.
    expect(truncated).toHaveLength(3);
    expect(truncated[0]).toEqual({ role: 'user', content: 'INIT_PROMPT' });
    expect(truncated[1]).toEqual({ role: 'assistant', content: 'A3' });
    expect(truncated[2]).toEqual({ role: 'user', content: 'U4' });
  });

  it('keeps only messages that fit within token limit', () => {
    const agent = new CustomAgent({} as any, {} as any);
    const truncateHistory = (agent as any).truncateHistory.bind(agent) as (
      history: ConversationMessage[],
      config: { maxContextMessages: number; maxTokens: number }
    ) => ConversationMessage[];

    const history: ConversationMessage[] = [
      { role: 'user', content: 'X'.repeat(120) },  // ~30 tokens
      { role: 'assistant', content: 'A1' },        // ~1 token
      { role: 'user', content: 'LATEST_USER' },    // ~3 tokens
    ];

    // Token limit of 3 should only fit LATEST_USER
    const truncated = truncateHistory(history, { maxContextMessages: 10, maxTokens: 3 });

    expect(truncated).toEqual([{ role: 'user', content: 'LATEST_USER' }]);
  });

  it('never returns assistant-first history', () => {
    const agent = new CustomAgent({} as any, {} as any);
    const truncateHistory = (agent as any).truncateHistory.bind(agent) as (
      history: ConversationMessage[],
      config: { maxContextMessages: number; maxTokens: number }
    ) => ConversationMessage[];

    const history: ConversationMessage[] = [
      { role: 'assistant', content: 'A0' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'U1' },
      { role: 'assistant', content: 'A2' },
    ];

    // With an assistant head, message-limit alignment must not return an
    // assistant-first request to OpenAI-compatible providers.
    const truncated = truncateHistory(history, { maxContextMessages: 2, maxTokens: 0 });

    expect(truncated).toEqual([{ role: 'user', content: 'U1' }]);
  });

  it('returns latest user message when token limit excludes all messages', () => {
    const agent = new CustomAgent({} as any, {} as any);
    const truncateHistory = (agent as any).truncateHistory.bind(agent) as (
      history: ConversationMessage[],
      config: { maxContextMessages: number; maxTokens: number }
    ) => ConversationMessage[];

    const history: ConversationMessage[] = [
      { role: 'assistant', content: 'A0' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'LATEST_USER' },
      { role: 'assistant', content: 'A2' },
    ];

    // Token limit of 1 excludes even LATEST_USER, fallback kicks in.
    // Fallback must trim oversized user content so we never bypass configured limits.
    const truncated = truncateHistory(history, { maxContextMessages: 10, maxTokens: 1 });

    expect(truncated).toEqual([{ role: 'user', content: 'LATEST' }]);
  });

  it('returns history unchanged when within limits', () => {
    const agent = new CustomAgent({} as any, {} as any);
    const truncateHistory = (agent as any).truncateHistory.bind(agent) as (
      history: ConversationMessage[],
      config: { maxContextMessages: number; maxTokens: number }
    ) => ConversationMessage[];

    const history: ConversationMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];

    const truncated = truncateHistory(history, { maxContextMessages: 10, maxTokens: 1000 });

    expect(truncated).toEqual(history);
  });

  it('does nothing when limits are disabled (0)', () => {
    const agent = new CustomAgent({} as any, {} as any);
    const truncateHistory = (agent as any).truncateHistory.bind(agent) as (
      history: ConversationMessage[],
      config: { maxContextMessages: number; maxTokens: number }
    ) => ConversationMessage[];

    const history: ConversationMessage[] = [
      { role: 'user', content: 'A'.repeat(10000) },
      { role: 'assistant', content: 'B'.repeat(10000) },
    ];

    const truncated = truncateHistory(history, { maxContextMessages: 0, maxTokens: 0 });

    expect(truncated).toEqual(history);
  });
});

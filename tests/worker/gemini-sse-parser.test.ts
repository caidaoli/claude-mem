import { describe, it, expect } from 'bun:test';

import { parseGeminiSseStream } from '../../src/services/worker/CustomAgent.js';

describe('parseGeminiSseStream', () => {
  it('parses multi-line SSE events (data: ... split across lines)', () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"THINK"}]}}]}',
      '',
      'data: {',
      'data: "candidates":[{"content":{"parts":[{"text":"{\\"type\\":\\"ok\\"}"}]}}],',
      'data: "usageMetadata":{"totalTokenCount":123}',
      'data: }',
      '',
    ].join('\n');

    const { parts, tokensUsed } = parseGeminiSseStream(sse);

    expect(parts.length).toBe(2);
    expect(parts[0]).toEqual({ thought: true, text: 'THINK' });
    expect(parts[1]).toEqual({ text: '{"type":"ok"}' });
    expect(tokensUsed).toBe(123);
  });

  it('falls back to parsing a single JSON object when SSE framing is missing', () => {
    const json = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: { totalTokenCount: 7 },
    });

    const { parts, tokensUsed } = parseGeminiSseStream(json);

    expect(parts).toEqual([{ text: 'hi' }]);
    expect(tokensUsed).toBe(7);
  });
});


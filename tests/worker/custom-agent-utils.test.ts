import { describe, it, expect, spyOn } from 'bun:test';

import { buildApiUrl, isCustomAvailable, __testOnly } from '../../src/services/worker/CustomAgent.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import * as EnvManager from '../../src/shared/EnvManager.js';

describe('CustomAgent helper utilities', () => {
  describe('buildApiUrl', () => {
    it('normalizes Gemini base URL variants without duplicating v1beta/models', () => {
      const model = 'gemini-2.5-flash';

      const fromRoot = buildApiUrl('https://api.example.com', 'gemini', model, false);
      const fromV1beta = buildApiUrl('https://api.example.com/v1beta', 'gemini', model, false);
      const fromModels = buildApiUrl('https://api.example.com/v1beta/models', 'gemini', model, false);

      expect(fromRoot).toBe('https://api.example.com/v1beta/models/gemini-2.5-flash:generateContent');
      expect(fromV1beta).toBe('https://api.example.com/v1beta/models/gemini-2.5-flash:generateContent');
      expect(fromModels).toBe('https://api.example.com/v1beta/models/gemini-2.5-flash:generateContent');
    });

    it('keeps full OpenAI completions endpoint unchanged', () => {
      const fullEndpoint = 'https://openai-compatible.example.com/v1/chat/completions';
      expect(buildApiUrl(fullEndpoint, 'openai', 'gpt-4o', false)).toBe(fullEndpoint);
    });
  });

  describe('parseOpenAISseStream', () => {
    it('parses multi-line SSE event payloads and token usage', () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"hel"}}]}',
        '',
        'data: {',
        'data:   "choices": [{"delta": {"content": "lo"}}],',
        'data:   "usage": {"total_tokens": 42}',
        'data: }',
        '',
        'data: [DONE]',
        ''
      ].join('\n');

      const { content, tokensUsed } = __testOnly.parseOpenAISseStream(sse);

      expect(content).toBe('hello');
      expect(tokensUsed).toBe(42);
    });

    it('falls back to non-stream JSON payloads when provider ignores stream mode', () => {
      const json = JSON.stringify({
        choices: [{ message: { content: '{"type":"discovery"}' } }],
        usage: { total_tokens: 7 }
      });

      const { content, tokensUsed } = __testOnly.parseOpenAISseStream(json);

      expect(content).toBe('{"type":"discovery"}');
      expect(tokensUsed).toBe(7);
    });

    it('extracts API errors from stream payloads', () => {
      const sse = [
        'data: {"error":{"code":"rate_limit","message":"Too many requests"}}',
        '',
        'data: [DONE]',
        ''
      ].join('\n');

      const { content, error } = __testOnly.parseOpenAISseStream(sse);

      expect(content).toBe('');
      expect(error).toBe('rate_limit - Too many requests');
    });
  });

  describe('config parsers', () => {
    it('falls back to openai for invalid protocol', () => {
      expect(__testOnly.parseCustomProtocol('invalid')).toBe('openai');
      expect(__testOnly.parseCustomProtocol(' GEMINI ')).toBe('gemini');
    });

    it('normalizes optional positive integers', () => {
      expect(__testOnly.parseOptionalPositiveInt('120')).toBe(120);
      expect(__testOnly.parseOptionalPositiveInt('0')).toBe(0);
      expect(__testOnly.parseOptionalPositiveInt('-9')).toBe(0);
      expect(__testOnly.parseOptionalPositiveInt('abc')).toBe(0);
    });
  });

  describe('availability checks', () => {
    it('uses CUSTOM_API_KEY credential fallback for availability detection', () => {
      const loadSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
        ...SettingsDefaultsManager.getAllDefaults(),
        CLAUDE_MEM_CUSTOM_API_URL: 'https://custom.example.com',
        CLAUDE_MEM_CUSTOM_API_KEY: ''
      }));

      const credentialSpy = spyOn(EnvManager, 'getCredential').mockImplementation((key: any) =>
        key === 'CUSTOM_API_KEY' ? 'fallback-custom-key' : undefined
      );

      expect(isCustomAvailable()).toBe(true);

      credentialSpy.mockRestore();
      loadSpy.mockRestore();
    });
  });
});

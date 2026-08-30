import { afterAll, describe, expect, it, mock } from 'bun:test';

import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realOauthToken from '../../../src/shared/oauth-token.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

const calls: unknown[][] = [];
const NON_REPO_CWD = '/tmp/claude-mem-context-session-start-nonrepo';
const NON_REPO_PROJECT = 'claude-mem-context-session-start-nonrepo';

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false' }),
}));

mock.module('../../../src/shared/oauth-token.js', () => ({ readStaleMarker: () => null }));


mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (...args: unknown[]) => {
    calls.push(args);
    return 'context from worker';
  },
  getWorkerPort: () => 37777,
  isWorkerFallback: () => false,
}));

afterAll(() => {
  mock.module('../../../src/shared/hook-settings.js', () => ({ ...realHookSettings }));
  mock.module('../../../src/shared/oauth-token.js', () => ({ ...realOauthToken }));
  mock.module('../../../src/shared/worker-utils.js', () => ({ ...realWorkerUtils }));
});

describe('contextHandler SessionStart path', () => {
  it('injects Codex context with one bounded worker startup and request', async () => {
    calls.length = 0;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-context',
      cwd: NON_REPO_CWD,
      platform: 'codex',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
    expect(calls).toEqual([[
      `/api/context/inject?projects=${NON_REPO_PROJECT}&platformSource=codex`,
      'GET',
      undefined,
      { workerStartupTimeoutMs: 15_000, timeoutMs: 2_000 },
    ]]);
  });

  it('keeps the existing worker lifecycle behavior for Claude', async () => {
    calls.length = 0;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    await contextHandler.execute({
      sessionId: 'session-context-claude',
      cwd: NON_REPO_CWD,
      platform: 'claude-code',
    });

    expect(calls).toEqual([[
      `/api/context/inject?projects=${NON_REPO_PROJECT}&platformSource=claude`,
      'GET',
      undefined,
      undefined,
    ]]);
  });
});

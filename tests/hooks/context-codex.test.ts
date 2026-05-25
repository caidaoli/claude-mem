import { beforeEach, describe, expect, it, mock } from 'bun:test';

let workerResponses: string[] = [];

mock.module('../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async () => workerResponses.shift() ?? '',
  isWorkerFallback: (value: unknown) =>
    Boolean(value && typeof value === 'object' && (value as any).__workerFallback),
  getWorkerPort: () => 37701,
}));

mock.module('../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true',
  }),
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({
    primary: 'test-project',
    allProjects: ['test-project'],
  }),
}));

mock.module('../../src/shared/oauth-token.js', () => ({
  readStaleMarker: () => null,
}));

import { contextHandler } from '../../src/cli/handlers/context.js';

describe('contextHandler - Codex SessionStart output', () => {
  beforeEach(() => {
    workerResponses = ['memory context', 'terminal context'];
  });

  it('does not duplicate Codex context through systemMessage warnings', async () => {
    const result = await contextHandler.execute({
      sessionId: 'codex-session',
      cwd: '/tmp/project',
      platform: 'codex',
    });

    expect(result.hookSpecificOutput).toEqual({
      hookEventName: 'SessionStart',
      additionalContext: 'memory context',
    });
    expect(result.systemMessage).toBeUndefined();
  });

  it('keeps terminal systemMessage output for Claude Code', async () => {
    const result = await contextHandler.execute({
      sessionId: 'claude-session',
      cwd: '/tmp/project',
      platform: 'claude-code',
    });

    expect(result.systemMessage).toContain('terminal context');
    expect(result.systemMessage).toContain('View Observations Live @ http://localhost:37701');
  });
});

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { paths } from '../../../../src/shared/paths.js';

// Most settings are read once at worker startup, so a viewer save must
// restart the worker or the new values silently do nothing.
describe('POST /api/settings restarts the worker', () => {
  const settingsPath = paths.settings();
  let previousSettings: string | undefined;
  let postSettings: (req: Request, res: Response) => void;
  let restartWorker: ReturnType<typeof mock>;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    previousSettings = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
    restartWorker = mock(() => Promise.resolve());
    exitSpy = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const app = {
      get: mock(() => {}),
      post: mock((route: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
        if (route === '/api/settings') postSettings = handlers[handlers.length - 1];
      }),
    };
    new SettingsRoutes({} as any, restartWorker).setupRoutes(app as any);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    if (previousSettings === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, previousSettings, 'utf-8');
  });

  function post(body: Record<string, unknown>) {
    const listeners: Record<string, () => Promise<void>> = {};
    const json = mock(() => {});
    const status = mock(() => ({ json }));
    const res = {
      json,
      status,
      headersSent: false,
      on: (event: string, listener: () => Promise<void>) => { listeners[event] = listener; },
    } as unknown as Response;
    postSettings({ body, path: '/api/settings', params: {}, query: {} } as unknown as Request, res);
    return { json, status, finish: () => listeners.finish?.() };
  }

  it('saves, answers, then restarts once the response is flushed', async () => {
    const { json, finish } = post({ CLAUDE_MEM_CONTEXT_OBSERVATIONS: '42' });

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_CONTEXT_OBSERVATIONS).toBe('42');
    expect(restartWorker).not.toHaveBeenCalled();

    await finish();

    expect(restartWorker).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('does not restart when the save is rejected', async () => {
    const { status, finish } = post({ CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: 'sometimes' });
    await finish();

    expect(status).toHaveBeenCalledWith(400);
    expect(restartWorker).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

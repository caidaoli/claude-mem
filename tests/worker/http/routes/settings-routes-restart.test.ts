import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

import * as realFlushResponseThen from '../../../../src/services/server/flushResponseThen.js';
import * as realPaths from '../../../../src/shared/paths.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-settings-routes-'));
process.env.CLAUDE_MEM_DATA_DIR = dataDir;
const settingsPath = path.join(dataDir, 'settings.json');

const flushActions: Array<() => void | Promise<void>> = [];

mock.module('../../../../src/shared/paths.js', () => ({
  ...realPaths,
  DATA_DIR: dataDir,
  USER_SETTINGS_PATH: settingsPath,
  paths: {
    ...realPaths.paths,
    dataDir: () => dataDir,
    workerPid: () => path.join(dataDir, 'worker.pid'),
    settings: () => settingsPath,
  },
}));

mock.module('../../../../src/services/server/flushResponseThen.js', () => ({
  flushResponseThen: (_res: express.Response, payload: unknown, action: () => void | Promise<void>) => {
    flushActions.push(action);
    _res.json(payload);
  },
}));

const { SettingsRoutes } = await import('../../../../src/services/worker/http/routes/SettingsRoutes.js');

async function listen(app: express.Application): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        close: () => new Promise<void>((closeResolve, closeReject) => {
          server.close(error => error ? closeReject(error) : closeResolve());
        }),
      });
    });
  });
}

describe('SettingsRoutes restart behavior', () => {
  beforeEach(() => {
    flushActions.length = 0;
  });

  afterAll(() => {
    mock.module('../../../../src/shared/paths.js', () => realPaths);
    mock.module('../../../../src/services/server/flushResponseThen.js', () => realFlushResponseThen);
    delete process.env.CLAUDE_MEM_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('schedules a worker restart after settings are saved', async () => {
    const restartWorker = mock(() => Promise.resolve());
    const app = express();
    app.use(express.json());
    new (SettingsRoutes as any)({}, restartWorker).setupRoutes(app);

    const server = await listen(app);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          CLAUDE_MEM_WORKER_PORT: '45678',
          CLAUDE_MEM_PROVIDER: 'claude',
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        success: true,
        message: 'Settings updated. Worker is restarting; new values apply on next hook invocation.',
      });

      expect(flushActions).toHaveLength(1);
      await flushActions[0]();

      expect(restartWorker).toHaveBeenCalledTimes(1);
      expect(restartWorker.mock.calls[0][0]).toEqual({ port: 45678 });

      const savedSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(savedSettings.CLAUDE_MEM_WORKER_PORT).toBe('45678');
    } finally {
      await server.close();
    }
  });
});

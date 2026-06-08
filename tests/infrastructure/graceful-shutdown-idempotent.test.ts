import { afterAll, describe, expect, it, mock } from 'bun:test';
import type http from 'http';
import * as realSupervisor from '../../src/supervisor/index.js';

const realSupervisorSnapshot = { ...realSupervisor };
const supervisorStop = mock(async () => {});

mock.module('../../src/supervisor/index.js', () => ({
  ...realSupervisorSnapshot,
  getSupervisor: () => ({
    stop: supervisorStop,
  }),
}));

const { performGracefulShutdown } = await import('../../src/services/infrastructure/GracefulShutdown.js');

describe('performGracefulShutdown idempotency', () => {
  afterAll(() => {
    mock.module('../../src/supervisor/index.js', () => realSupervisorSnapshot);
  });

  it('treats an already-closed HTTP server as closed and continues shutdown', async () => {
    const serverAlreadyClosed = Object.assign(new Error('Server is not running.'), {
      code: 'ERR_SERVER_NOT_RUNNING',
    });

    const server = {
      closeAllConnections: mock(() => {}),
      close: mock((callback: (error?: Error) => void) => callback(serverAlreadyClosed)),
    } as unknown as http.Server;

    const sessionManager = {
      shutdownAll: mock(async () => {}),
    };

    await expect(performGracefulShutdown({ server, sessionManager })).resolves.toBeUndefined();

    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(sessionManager.shutdownAll).toHaveBeenCalledTimes(1);
    expect(supervisorStop).toHaveBeenCalledTimes(1);
  });
});

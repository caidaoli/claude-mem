import { describe, expect, it, spyOn } from 'bun:test';
import { loadServerBetaMode } from '../src/server/runtime/create-server-beta-service.js';
import { logger } from '../src/utils/logger.js';

describe('ModeManager path resolution from root-level test entrypoints', () => {
  it('loads bundled modes when process.argv[1] is at the repository root test depth', () => {
    const spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
    ];

    try {
      expect(() => loadServerBetaMode()).not.toThrow();
    } finally {
      spies.forEach(spy => spy.mockRestore());
    }
  });
});

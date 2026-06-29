import { describe, expect, it, spyOn } from 'bun:test';
import { loadServerMode } from '../src/server/runtime/create-server-service.js';
import { logger } from '../src/utils/logger.js';

describe('ModeManager path resolution from root-level test entrypoints', () => {
  it('loads bundled modes when process.argv[1] is at the repository root test depth', () => {
    const spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
    ];

    try {
      expect(() => loadServerMode()).not.toThrow();
    } finally {
      spies.forEach(spy => spy.mockRestore());
    }
  });
});

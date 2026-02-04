import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { logger } from '../src/utils/logger.js';

// parseObservationsJson depends on ModeManager for valid observation types.
// Mock it to keep tests fast and deterministic.
mock.module('../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {},
        observation_types: [{ id: 'discovery', description: 'Test type' }],
        observation_concepts: [],
      }),
    }),
  },
}));

import { parseObservationsJson } from '../src/sdk/parser.js';

let loggerSpies: Array<ReturnType<typeof spyOn>> = [];

describe('parseObservationsJson', () => {
  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    for (const spy of loggerSpies) {
      spy.mockRestore();
    }
    loggerSpies = [];
  });

  it('treats plain text responses as a skip (no JSON payload)', () => {
    const result = parseObservationsJson(
      'Empty status checks or requests without execution details are skipped.',
      'test-correlation-id'
    );
    expect(result).toEqual([]);
  });

  it('supports explicit JSON skip sentinel', () => {
    const result = parseObservationsJson('{"skip":true}', 'test-correlation-id');
    expect(result).toEqual([]);
  });

  it('logs raw response content on JSON parse failure', () => {
    const errorSpy = loggerSpies[1];

    const input = '```json\n{"type":}\n```';
    const result = parseObservationsJson(input, 'test-correlation-id');
    expect(result).toEqual([]);

    // Verify logger.error received data with rawText for debugging
    expect(errorSpy).toBeTruthy();
    expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
    const lastCall = errorSpy.mock.calls[errorSpy.mock.calls.length - 1];
    const dataArg = lastCall[3]; // logger.error(component, message, context, data)
    expect(dataArg).toBeTruthy();
    expect(dataArg.rawText).toBe(input);
  });
});

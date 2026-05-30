import { describe, it, expect, mock, spyOn, beforeEach, afterEach, afterAll } from 'bun:test';
import { logger } from '../src/utils/logger.js';
import * as realModeManager from '../src/services/domain/ModeManager.js';

const realModeManagerSnapshot = { ...realModeManager };

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

afterAll(() => {
  mock.module('../src/services/domain/ModeManager.js', () => realModeManagerSnapshot);
});

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

  it('parses valid JSON object when trailing garbage exists', () => {
    const input = '{"type":"discovery","title":"ok","facts":[],"files_read":[],"files_modified":[],"concepts":[]}\n"]}\n"]}"';

    const result = parseObservationsJson(input, 'test-correlation-id');

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('discovery');
    expect(result[0].title).toBe('ok');
  });

  it('skips malformed leading blob and parses later valid JSON object', () => {
    const badPrefix = '{"type":"discovery","title":"bad","files_read":["src/components/{"type":"oops"],"files_modified":[],"concepts":[]}';
    const goodObject = '{"type":"discovery","title":"good","facts":[],"files_read":[],"files_modified":[],"concepts":[]}';
    const input = `${badPrefix}\n${goodObject}\n[]}`;

    const result = parseObservationsJson(input, 'test-correlation-id');

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('good');
  });

  it('strips placeholder wrappers from JSON observation fields', () => {
    const input = JSON.stringify({
      type: 'discovery',
      title: '[**title**: Hello]',
      subtitle: '[World]',
      facts: ['[**fact**: f1]', '[f2]'],
      narrative: '[**narrative**: Text]',
      concepts: [],
      files_read: [],
      files_modified: []
    });

    const result = parseObservationsJson(input, 'test-correlation-id');

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Hello');
    expect(result[0].subtitle).toBe('World');
    expect(result[0].facts).toEqual(['f1', 'f2']);
    expect(result[0].narrative).toBe('Text');
  });
});

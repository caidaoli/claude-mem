// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';
import type { SettingsManager } from '../../src/services/worker/SettingsManager.js';

type SettingsValidator = {
  validateSettings(settings: Record<string, string>): { valid: boolean; error?: string };
};

describe('SettingsRoutes Custom reasoning validation', () => {
  it('accepts on and off and rejects other values', () => {
    const routes = new SettingsRoutes({} as SettingsManager) as unknown as SettingsValidator;
    for (const value of ['off', 'on']) {
      expect(routes.validateSettings({ CLAUDE_MEM_CUSTOM_REASONING: value }).valid).toBe(true);
    }
    for (const value of ['', 'auto', 'true']) {
      expect(routes.validateSettings({ CLAUDE_MEM_CUSTOM_REASONING: value })).toEqual({
        valid: false,
        error: 'CLAUDE_MEM_CUSTOM_REASONING must be "off" (default) or "on"',
      });
    }
  });
});

describe('SettingsRoutes observer capture validation', () => {
  const routes = () => new SettingsRoutes({} as SettingsManager) as unknown as SettingsValidator;

  it('accepts only explicit string booleans', () => {
    expect(routes().validateSettings({ CLAUDE_MEM_OBSERVER_ENABLED: 'true' }).valid).toBe(true);
    expect(routes().validateSettings({ CLAUDE_MEM_OBSERVER_ENABLED: 'false' }).valid).toBe(true);
    expect(routes().validateSettings({ CLAUDE_MEM_OBSERVER_ENABLED: 'False' })).toEqual({
      valid: false,
      error: 'CLAUDE_MEM_OBSERVER_ENABLED must be "true" or "false"',
    });
  });

  it('accepts only explicit string booleans for the "Keep images" switch', () => {
    expect(routes().validateSettings({ CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'true' }).valid).toBe(true);
    expect(routes().validateSettings({ CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false' }).valid).toBe(true);
    expect(routes().validateSettings({ CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'off' })).toEqual({
      valid: false,
      error: 'CLAUDE_MEM_MEDIA_CAPTURE_ENABLED must be "true" or "false"',
    });
  });
});

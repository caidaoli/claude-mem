import { describe, expect, test } from 'bun:test';
import { createRequire } from 'module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);
const { syncCodexPlugin } = require('../../scripts/sync-codex-plugin.cjs') as {
  syncCodexPlugin: (options: Record<string, unknown>) => void;
};

type SpawnCall = {
  command: string;
  args: string[];
};

function makePluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-codex-plugin-'));
  mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'claude-mem' }, null, 2)
  );
  writeFileSync(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: 'claude-mem-local',
      interface: { displayName: 'claude-mem (local)' },
      plugins: [
        {
          name: 'claude-mem',
          source: { source: 'local', path: './plugin' },
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
          category: 'Productivity',
        },
      ],
    }, null, 2)
  );
  return root;
}

describe('sync-codex-plugin', () => {
  test('registers the repository marketplace before installing the single derived selector', () => {
    const root = makePluginRoot();
    const calls: SpawnCall[] = [];
    const stdout: string[] = [];

    const spawnSync = (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args[0] === '--version') {
        return { status: 0 };
      }
      if (args.join(' ') === `plugin marketplace add ${root} --json`) {
        return {
          status: 0,
          stdout: '{"marketplaceName":"claude-mem-local","alreadyAdded":true}\n',
          stderr: '',
        };
      }
      if (args.join(' ') === 'plugin add claude-mem@claude-mem-local --json') {
        return {
          status: 0,
          stdout: '{"pluginId":"claude-mem@claude-mem-local"}\n',
          stderr: '',
        };
      }
      return { status: 1, stderr: `unexpected call: ${args.join(' ')}` };
    };

    syncCodexPlugin({
      rootDir: root,
      homeDir: mkdtempSync(join(tmpdir(), 'claude-mem-codex-home-')),
      env: {},
      spawnSync,
      log: () => {},
      stdout: { write: (chunk: string) => stdout.push(chunk) },
      stderr: { write: () => {} },
    });

    expect(calls).toEqual([
      { command: 'codex', args: ['--version'] },
      { command: 'codex', args: ['plugin', 'marketplace', 'add', root, '--json'] },
      { command: 'codex', args: ['plugin', 'add', 'claude-mem@claude-mem-local', '--json'] },
    ]);
    expect(stdout).toEqual(['{"pluginId":"claude-mem@claude-mem-local"}\n']);
  });

  test('skips all plugin work when Codex CLI is unavailable', () => {
    const root = makePluginRoot();
    const calls: SpawnCall[] = [];

    const spawnSync = (command: string, args: string[]) => {
      calls.push({ command, args });
      return {
        status: null,
        error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }),
      };
    };

    syncCodexPlugin({
      rootDir: root,
      homeDir: mkdtempSync(join(tmpdir(), 'claude-mem-codex-home-')),
      env: {},
      spawnSync,
      log: () => {},
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });

    expect(calls).toEqual([{ command: 'codex', args: ['--version'] }]);
  });

  test('refreshes every Codex home that enables the plugin, each under its own CODEX_HOME', () => {
    const root = makePluginRoot();
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-mem-codex-home-'));
    mkdirSync(join(homeDir, '.codex-cli'));
    writeFileSync(join(homeDir, '.codex-cli', 'config.toml'), '[plugins."claude-mem@claude-mem-local"]\nenabled = true\n');
    mkdirSync(join(homeDir, '.codex-other'));
    writeFileSync(join(homeDir, '.codex-other', 'config.toml'), '[plugins."pdf@openai"]\n');
    const installs: Array<string | undefined> = [];

    const spawnSync = (_command: string, args: string[], options?: { env?: Record<string, string> }) => {
      if (args[0] === 'plugin' && args[1] === 'add') installs.push(options?.env?.CODEX_HOME);
      return { status: 0, stdout: '', stderr: '' };
    };

    syncCodexPlugin({
      rootDir: root,
      homeDir,
      env: {},
      spawnSync,
      log: () => {},
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });

    expect(installs).toEqual([join(homeDir, '.codex'), join(homeDir, '.codex-cli')]);
  });
});

#!/usr/bin/env node

const { spawnSync } = require('child_process');

const PLUGIN_SELECTOR = 'claude-mem@claude-mem-local';

function isCodexAvailable() {
  const result = spawnSync('codex', ['--version'], { stdio: 'ignore' });

  if (result.error?.code === 'ENOENT') {
    return false;
  }

  if (result.error) {
    throw result.error;
  }

  return result.status === 0;
}

function syncCodexPlugin() {
  if (!isCodexAvailable()) {
    console.log('Codex CLI not found; skipping Codex plugin cache refresh.');
    return;
  }

  console.log(`Refreshing Codex plugin cache: ${PLUGIN_SELECTOR}`);
  const result = spawnSync('codex', ['plugin', 'add', PLUGIN_SELECTOR, '--json'], {
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`codex plugin add failed with exit code ${result.status ?? 'unknown'}`);
  }
}

try {
  syncCodexPlugin();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Codex plugin cache refresh failed: ${message}`);
  process.exit(1);
}

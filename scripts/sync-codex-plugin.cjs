#!/usr/bin/env node

const { spawnSync } = require('child_process');

const PLUGIN_SELECTORS = [
  'claude-mem@claude-mem-local',
  'claude-mem@thedotmack',
];

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

  const failures = [];
  for (const selector of PLUGIN_SELECTORS) {
    console.log(`Refreshing Codex plugin cache: ${selector}`);
    const result = spawnSync('codex', ['plugin', 'add', selector, '--json'], {
      encoding: 'utf-8',
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status === 0) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return;
    }

    failures.push({
      selector,
      status: result.status ?? 'unknown',
      stdout: result.stdout?.trim() ?? '',
      stderr: result.stderr?.trim() ?? '',
    });
  }

  const details = failures
    .map(failure => `${failure.selector}: exit ${failure.status}${failure.stderr ? `, stderr: ${failure.stderr}` : ''}${failure.stdout ? `, stdout: ${failure.stdout}` : ''}`)
    .join('; ');
  throw new Error(`codex plugin add failed for all selectors (${details})`);
}

try {
  syncCodexPlugin();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Codex plugin cache refresh failed: ${message}`);
  process.exit(1);
}

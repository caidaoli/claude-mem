#!/usr/bin/env node

const { spawnSync } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');

function readJson(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`missing required file: ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function readCodexSelector(root) {
  const packageJson = readJson(path.join(root, 'package.json'));
  const marketplace = readJson(path.join(root, '.agents', 'plugins', 'marketplace.json'));
  const pluginName = String(packageJson.name || '').trim();
  const marketplaceName = String(marketplace.name || '').trim();

  if (!pluginName) {
    throw new Error('package.json must define a plugin name');
  }
  if (!marketplaceName) {
    throw new Error('.agents/plugins/marketplace.json must define a marketplace name');
  }
  if (!Array.isArray(marketplace.plugins)) {
    throw new Error('.agents/plugins/marketplace.json must define plugins[]');
  }
  if (!marketplace.plugins.some(plugin => plugin?.name === pluginName)) {
    throw new Error(`plugin \`${pluginName}\` was not found in marketplace \`${marketplaceName}\``);
  }

  return {
    marketplaceName,
    pluginName,
    selector: `${pluginName}@${marketplaceName}`,
  };
}

function isCodexAvailable(spawn = spawnSync) {
  const result = spawn('codex', ['--version'], { stdio: 'ignore' });

  if (result.error?.code === 'ENOENT') {
    return false;
  }

  if (result.error) {
    throw result.error;
  }

  return result.status === 0;
}

function formatFailure(result) {
  return `exit ${result.status ?? 'unknown'}${result.stderr ? `, stderr: ${result.stderr.trim()}` : ''}${result.stdout ? `, stdout: ${result.stdout.trim()}` : ''}`;
}

function runCodex(args, spawn) {
  const result = spawn('codex', args, {
    encoding: 'utf-8',
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function ensureCodexMarketplace(root, marketplaceName, deps) {
  deps.log(`Ensuring Codex marketplace is configured: ${marketplaceName}`);
  const result = runCodex(['plugin', 'marketplace', 'add', root, '--json'], deps.spawn);

  if (result.status !== 0) {
    throw new Error(`codex plugin marketplace add failed for ${marketplaceName}: ${formatFailure(result)}`);
  }
}

function installCodexPlugin(selector, deps) {
  deps.log(`Refreshing Codex plugin cache: ${selector}`);
  const result = runCodex(['plugin', 'add', selector, '--json'], deps.spawn);

  if (result.status !== 0) {
    throw new Error(`codex plugin add failed for ${selector}: ${formatFailure(result)}`);
  }

  if (result.stdout) deps.stdout.write(result.stdout);
  if (result.stderr) deps.stderr.write(result.stderr);
}

function syncCodexPlugin(options = {}) {
  const deps = {
    spawn: options.spawnSync || spawnSync,
    log: options.log || console.log,
    stdout: options.stdout || process.stdout,
    stderr: options.stderr || process.stderr,
  };
  const root = options.rootDir || rootDir;

  if (!isCodexAvailable(deps.spawn)) {
    deps.log('Codex CLI not found; skipping Codex plugin cache refresh.');
    return;
  }

  const { marketplaceName, selector } = readCodexSelector(root);
  ensureCodexMarketplace(root, marketplaceName, deps);
  installCodexPlugin(selector, deps);
}

if (require.main === module) {
  try {
    syncCodexPlugin();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Codex plugin cache refresh failed: ${message}`);
    process.exit(1);
  }
}

module.exports = {
  syncCodexPlugin,
  readCodexSelector,
};

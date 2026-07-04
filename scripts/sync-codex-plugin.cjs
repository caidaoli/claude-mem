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

function readInstalledMarketplaceSelector(root, pluginName, primaryMarketplaceName) {
  const marketplacePath = path.join(root, '.claude-plugin', 'marketplace.json');
  if (!existsSync(marketplacePath)) return null;

  const marketplace = readJson(marketplacePath);
  const marketplaceName = String(marketplace.name || '').trim();
  if (!marketplaceName || marketplaceName === primaryMarketplaceName) return null;
  if (!Array.isArray(marketplace.plugins)) return null;
  if (!marketplace.plugins.some(plugin => plugin?.name === pluginName)) return null;

  return {
    marketplaceName,
    pluginName,
    selector: `${pluginName}@${marketplaceName}`,
  };
}

function readCodexSelectors(root) {
  const primary = readCodexSelector(root);
  const installed = readInstalledMarketplaceSelector(root, primary.pluginName, primary.marketplaceName);
  return installed ? [primary, installed] : [primary];
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

function tryInstallCodexPlugin(selector, deps) {
  deps.log(`Refreshing Codex plugin cache: ${selector}`);
  const result = runCodex(['plugin', 'add', selector, '--json'], deps.spawn);

  if (result.status !== 0) {
    return {
      ok: false,
      message: `codex plugin add failed for ${selector}: ${formatFailure(result)}`,
    };
  }

  if (result.stdout) deps.stdout.write(result.stdout);
  if (result.stderr) deps.stderr.write(result.stderr);
  return { ok: true };
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

  const selectors = readCodexSelectors(root);
  ensureCodexMarketplace(root, selectors[0].marketplaceName, deps);

  const failures = [];
  for (const candidate of selectors) {
    const result = tryInstallCodexPlugin(candidate.selector, deps);
    if (result.ok) return;
    failures.push(result.message);
  }

  throw new Error(failures.join('; '));
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
  readCodexSelectors,
};

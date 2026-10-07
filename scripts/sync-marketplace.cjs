#!/usr/bin/env node

const { execSync } = require('child_process');
const { existsSync, readFileSync, rmSync, writeFileSync } = require('fs');
const path = require('path');
const os = require('os');
const { syncClaudePluginRegistry } = require('./lib/claude-plugin-registry.cjs');
const { mirrorDirectory } = require('./mirror-dir.cjs');

const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const INSTALLED_PATH = path.join(CLAUDE_CONFIG_DIR, 'plugins', 'marketplaces', 'thedotmack');
const CACHE_BASE_PATH = path.join(CLAUDE_CONFIG_DIR, 'plugins', 'cache', 'thedotmack', 'claude-mem');

function parseWorkerPort(value) {
  const port = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

const BASE_EXCLUDES = [
  '.git',
  'bun.lock',
  'package-lock.json',
  'scripts/package.json',
  'scripts/node_modules',
  '/workers',
  '/.agents/',
  '/.claude/',
  '/.codegraph/',
];

function getCurrentBranch() {
  try {
    if (!existsSync(path.join(INSTALLED_PATH, '.git'))) {
      return null;
    }
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: INSTALLED_PATH,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return null;
  }
}

function getGitignoreExcludes(basePath) {
  const gitignorePath = path.join(basePath, '.gitignore');
  if (!existsSync(gitignorePath)) return [];

  const syncManagedFiles = new Set();

  const lines = readFileSync(gitignorePath, 'utf-8').split('\n');
  return lines
    .map(line => line.trim())
    .filter(line =>
      line &&
      !line.startsWith('#') &&
      !line.startsWith('!') &&
      !syncManagedFiles.has(line)
    );
}

function getMarketplaceExcludes(rootDir) {
  return [...BASE_EXCLUDES, ...getGitignoreExcludes(rootDir)];
}

function mirrorMarketplace(rootDir, installedPath) {
  const exclude = getMarketplaceExcludes(rootDir);
  const stats = mirrorDirectory(rootDir, installedPath, { exclude });
  // These release bundles are generated under ignored directories. Sync only
  // their explicit subtrees, keeping the rest of dist and ignored data excluded.
  for (const relativePath of ['dist/pi-extension', 'dsh/lib']) {
    const source = path.join(rootDir, relativePath);
    if (!existsSync(source)) continue;
    const bundle = mirrorDirectory(source, path.join(installedPath, relativePath), { exclude });
    for (const key of ['copied', 'metadata', 'deleted']) stats[key] += bundle[key];
  }
  return stats;
}

function getPluginVersion() {
  try {
    const pluginJsonPath = path.join(__dirname, '..', 'plugin', '.claude-plugin', 'plugin.json');
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return pluginJson.version;
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', 'Failed to read plugin version:', error.message);
    process.exit(1);
  }
}

function probeVersion(command) {
  try {
    return execSync(command, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
  } catch {
    return '';
  }
}

function writeInstallMarker(targetDir, version) {
  rmSync(path.join(targetDir, '.cli-installed'), { force: true });
  const marker = {
    version,
    bun: probeVersion('bun --version'),
    uv: probeVersion('uv --version'),
    installedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(targetDir, '.install-version'), JSON.stringify(marker));
}

function cleanPluginRuntime(targetDir) {
  for (const entry of ['package-lock.json', '.install-version', '.cli-installed']) {
    rmSync(path.join(targetDir, entry), { recursive: true, force: true });
  }
}

function installPluginRuntime(targetDir, label) {
  cleanPluginRuntime(targetDir);
  console.log(`Running bun install in ${label}...`);
  execSync('bun install', { cwd: targetDir, stdio: 'inherit' });
}

function getPluginRuntimeExcludes(pluginDir) {
  return [
    '.git',
    'node_modules/',
    'package-lock.json',
    'bun.lock',
    '.install-version',
    '.cli-installed',
    ...getGitignoreExcludes(pluginDir),
  ];
}

function detectInstalledVersion(buildVersion) {
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || path.join(os.homedir(), '.claude-mem');
  const settingsPath = path.join(dataDir, 'settings.json');
  let port = parseWorkerPort(process.env.CLAUDE_MEM_WORKER_PORT);
  if (!port && existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      port = parseWorkerPort(settings.CLAUDE_MEM_WORKER_PORT);
    } catch {}
  }
  if (!port) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 77;
    port = 37700 + (uid % 100);
  }

  let healthBody;
  try {
    healthBody = execSync(`curl -s --max-time 2 http://127.0.0.1:${port}/api/health`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return null;
  }
  if (!healthBody) return null;

  try {
    const health = JSON.parse(healthBody);
    if (!health.version || health.version === buildVersion) return null;
    return {
      installedVersion: health.version,
      installedPath: health.workerPath,
    };
  } catch {
    return null;
  }
}

function triggerWorkerRestart() {
  console.log('\n🔄 Triggering worker restart...');
  const http = require('http');
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || path.join(os.homedir(), '.claude-mem');
  const settingsPath = path.join(dataDir, 'settings.json');
  let settingsPort = null;
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      settingsPort = parseWorkerPort(settings.CLAUDE_MEM_WORKER_PORT);
    } catch {
      // fall through to env / default
    }
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 77;
  const defaultPort = 37700 + (uid % 100);
  const workerPort =
    parseWorkerPort(process.env.CLAUDE_MEM_WORKER_PORT) ??
    settingsPort ??
    defaultPort;
  const req = http.request({
    hostname: '127.0.0.1',
    port: workerPort,
    path: '/api/admin/restart',
    method: 'POST',
    timeout: 2000,
  }, (res) => {
    if (res.statusCode === 200) {
      console.log('\x1b[32m%s\x1b[0m', `✓ Worker restart triggered on port ${workerPort}`);
    } else {
      console.log('\x1b[33m%s\x1b[0m', `ℹ Worker restart on port ${workerPort} returned status ${res.statusCode}`);
    }
  });
  req.on('error', () => {
    console.log('\x1b[33m%s\x1b[0m', `ℹ No worker reachable on port ${workerPort}; the next worker:restart step will start one.`);
  });
  req.on('timeout', () => {
    req.destroy();
    console.log('\x1b[33m%s\x1b[0m', `ℹ Worker restart on port ${workerPort} timed out`);
  });
  req.end();
}

function logInstalledMismatch(installedMismatch, buildVersion) {
  if (!installedMismatch) return;
  console.log('');
  console.log('\x1b[33m%s\x1b[0m', 'Version mismatch detected:');
  console.log(`  Building:   ${buildVersion}`);
  console.log(`  Installed:  ${installedMismatch.installedVersion}`);
  if (installedMismatch.installedPath) console.log(`  Worker path: ${installedMismatch.installedPath}`);
  console.log('');
  console.log('Claude Code can keep pointing at its installed cache dir. Mirroring this');
  console.log('build into the installed-version cache and updating the plugin registry so');
  console.log('new sessions resolve the current version.');
  console.log('');
  console.log('\x1b[36m%s\x1b[0m', 'Restart Claude Code to refresh already-running plugin state.');
  console.log('');
}

function main() {
  const branch = getCurrentBranch();
  const isForce = process.argv.includes('--force');

  if (branch && branch !== 'main' && !isForce) {
    console.log('');
    console.log('\x1b[33m%s\x1b[0m', `WARNING: Installed plugin is on beta branch: ${branch}`);
    console.log('\x1b[33m%s\x1b[0m', 'Running sync would overwrite beta code.');
    console.log('');
    console.log('Options:');
    console.log('  1. Use the claude-mem UI on the configured worker port to update beta');
    console.log('  2. Switch to stable in UI first, then run sync');
    console.log('  3. Force sync: npm run sync-marketplace:force');
    console.log('');
    process.exit(1);
  }

  const rootDir = path.join(__dirname, '..');
  const version = getPluginVersion();
  const installedMismatch = detectInstalledVersion(version);
  logInstalledMismatch(installedMismatch, version);

  console.log('Syncing to marketplace...');
  try {
    const marketplace = mirrorMarketplace(rootDir, INSTALLED_PATH);
    console.log(`Marketplace: ${marketplace.copied} copied, ${marketplace.metadata} metadata reconciled, ${marketplace.deleted} stale removed`);

    const marketplacePluginPath = path.join(INSTALLED_PATH, 'plugin');
    installPluginRuntime(marketplacePluginPath, 'marketplace plugin');
    writeInstallMarker(marketplacePluginPath, version);

    const cacheVersionPath = path.join(CACHE_BASE_PATH, version);
    const pluginDir = path.join(rootDir, 'plugin');
    console.log(`Syncing to cache folder (version ${version})...`);
    const cache = mirrorDirectory(pluginDir, cacheVersionPath, {
      exclude: getPluginRuntimeExcludes(pluginDir),
    });
    console.log(`Cache: ${cache.copied} copied, ${cache.metadata} metadata reconciled, ${cache.deleted} stale removed`);

    installPluginRuntime(cacheVersionPath, `cache folder (version ${version})`);
    writeInstallMarker(cacheVersionPath, version);

    const registryResult = syncClaudePluginRegistry({
      claudeConfigDir: CLAUDE_CONFIG_DIR,
      version,
    });
    console.log(`Updated Claude plugin registry: claude-mem@thedotmack -> ${registryResult.cachePath}`);

    if (installedMismatch && installedMismatch.installedVersion !== version) {
      const installedCachePath = path.join(CACHE_BASE_PATH, installedMismatch.installedVersion);
      console.log(`Mirroring to installed-version cache (${installedMismatch.installedVersion}) for hot reload...`);
      const installedCache = mirrorDirectory(pluginDir, installedCachePath, {
        exclude: getPluginRuntimeExcludes(pluginDir),
      });
      console.log(`Installed-version cache: ${installedCache.copied} copied, ${installedCache.metadata} metadata reconciled, ${installedCache.deleted} stale removed`);
      writeInstallMarker(installedCachePath, version);
    }

    console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');
    triggerWorkerRestart();
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { getGitignoreExcludes, getMarketplaceExcludes, mirrorMarketplace, INSTALLED_PATH, CACHE_BASE_PATH };

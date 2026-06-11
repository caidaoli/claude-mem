#!/usr/bin/env node

const { execSync } = require('child_process');
const { existsSync, readFileSync, rmSync, writeFileSync } = require('fs');
const path = require('path');
const os = require('os');

const INSTALLED_PATH = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const CACHE_BASE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');
const INSTALL_MARKER_EXCLUDES = '--exclude=.install-version --exclude=.cli-installed';
const MARKETPLACE_PLUGIN_RUNTIME_EXCLUDES =
  '--exclude=plugin/node_modules --exclude=plugin/package-lock.json --exclude=plugin/bun.lock ' +
  '--exclude=plugin/.install-version --exclude=plugin/.cli-installed';

function parseWorkerPort(value) {
  const port = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

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
  if (!existsSync(gitignorePath)) return '';

  const syncManagedFiles = new Set();

  const lines = readFileSync(gitignorePath, 'utf-8').split('\n');
  return lines
    .map(line => line.trim())
    .filter(line =>
      line &&
      !line.startsWith('#') &&
      !line.startsWith('!') &&
      !syncManagedFiles.has(line)
    )
    .map(pattern => `--exclude=${JSON.stringify(pattern)}`)
    .join(' ');
}

const branch = getCurrentBranch();
const isForce = process.argv.includes('--force');

if (branch && branch !== 'main' && !isForce) {
  console.log('');
  console.log('\x1b[33m%s\x1b[0m', `WARNING: Installed plugin is on beta branch: ${branch}`);
  console.log('\x1b[33m%s\x1b[0m', 'Running rsync would overwrite beta code.');
  console.log('');
  console.log('Options:');
  console.log('  1. Use UI at http://localhost:37777 to update beta');
  console.log('  2. Switch to stable in UI first, then run sync');
  console.log('  3. Force rsync: npm run sync-marketplace:force');
  console.log('');
  process.exit(1);
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

function detectInstalledVersion(buildVersion) {
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || path.join(os.homedir(), '.claude-mem');
  const settingsPath = path.join(dataDir, 'settings.json');
  let port = parseWorkerPort(process.env.CLAUDE_MEM_WORKER_PORT);
  if (!port && existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
      const settingsPort = parseWorkerPort(s.CLAUDE_MEM_WORKER_PORT);
      if (settingsPort) port = settingsPort;
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
  let installedVersion;
  let installedPath;
  try {
    const j = JSON.parse(healthBody);
    installedVersion = j.version;
    installedPath = j.workerPath;
  } catch {
    return null;
  }
  if (!installedVersion || installedVersion === buildVersion) return null;
  return { installedVersion, installedPath };
}

const installedMismatch = detectInstalledVersion(getPluginVersion());
if (installedMismatch) {
  console.log('');
  console.log('\x1b[33m%s\x1b[0m', 'Version mismatch detected:');
  console.log(`  Building:   ${getPluginVersion()}`);
  console.log(`  Installed:  ${installedMismatch.installedVersion}`);
  if (installedMismatch.installedPath) console.log(`  Worker path: ${installedMismatch.installedPath}`);
  console.log('');
  console.log('Claude Code is pinned to the installed version, so the worker loads from');
  console.log(`its cache dir. Mirroring this build into the installed-version cache so the`);
  console.log('worker restart picks up new code without a Claude Code session restart.');
  console.log('');
  console.log('\x1b[36m%s\x1b[0m', `For a formal version bump, run \`claude plugin update thedotmack/claude-mem\``);
  console.log('\x1b[36m%s\x1b[0m', `and restart Claude Code so it loads the ${getPluginVersion()} cache dir.`);
  console.log('');
}


console.log('Syncing to marketplace...');
try {
  const rootDir = path.join(__dirname, '..');
  const gitignoreExcludes = getGitignoreExcludes(rootDir);

  // --include=plugin/*** must come before gitignoreExcludes because .gitignore
  // lists "plugin" (it's a build artifact), but marketplace needs it for hooks/scripts
  // Install markers are machine-local state, not source assets. Keep them out
  // before the broad plugin include, then write fresh markers after dependency install.
  // Runtime installs are target-local too: Codex copies ./plugin as the plugin
  // root, so stale source node_modules/package-lock files must never be copied.
  execSync(
    `rsync -av --delete --exclude=.git --exclude=/.mcp.json --exclude=bun.lock --exclude=package-lock.json --exclude=scripts/package.json --exclude=scripts/node_modules ${MARKETPLACE_PLUGIN_RUNTIME_EXCLUDES} --include=plugin/*** ${gitignoreExcludes} ./ ~/.claude/plugins/marketplaces/thedotmack/`,
    { stdio: 'inherit' }
  );

  console.log('Running bun install in marketplace...');
  execSync(
    'cd ~/.claude/plugins/marketplaces/thedotmack/ && bun install',
    { stdio: 'inherit' }
  );

  const version = getPluginVersion();
  const MARKETPLACE_PLUGIN_PATH = path.join(INSTALLED_PATH, 'plugin');
  installPluginRuntime(MARKETPLACE_PLUGIN_PATH, 'marketplace plugin');
  writeInstallMarker(MARKETPLACE_PLUGIN_PATH, version);

  const CACHE_VERSION_PATH = path.join(CACHE_BASE_PATH, version);

  console.log(`Syncing installed marketplace plugin to cache folder (version ${version})...`);
  execSync(
    `rsync -av --delete ${INSTALL_MARKER_EXCLUDES} "${MARKETPLACE_PLUGIN_PATH}/" "${CACHE_VERSION_PATH}/"`,
    { stdio: 'inherit' }
  );

  writeInstallMarker(CACHE_VERSION_PATH, version);

  if (installedMismatch && installedMismatch.installedVersion !== version) {
    const INSTALLED_CACHE_PATH = path.join(CACHE_BASE_PATH, installedMismatch.installedVersion);
    console.log(`Mirroring to installed-version cache (${installedMismatch.installedVersion}) for hot reload...`);
    execSync(
      `rsync -av --delete ${INSTALL_MARKER_EXCLUDES} "${MARKETPLACE_PLUGIN_PATH}/" "${INSTALLED_CACHE_PATH}/"`,
      { stdio: 'inherit' }
    );
    writeInstallMarker(INSTALLED_CACHE_PATH, version);
  }


  console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');

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
    timeout: 2000
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

} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
  process.exit(1);
}

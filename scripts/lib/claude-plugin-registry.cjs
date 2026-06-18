const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_ID = 'claude-mem@thedotmack';

function defaultClaudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function pluginsDirectory(claudeConfigDir) {
  return path.join(claudeConfigDir, 'plugins');
}

function marketplaceDirectory(claudeConfigDir = defaultClaudeConfigDir()) {
  return path.join(pluginsDirectory(claudeConfigDir), 'marketplaces', 'thedotmack');
}

function pluginCacheDirectory(version, claudeConfigDir = defaultClaudeConfigDir()) {
  return path.join(pluginsDirectory(claudeConfigDir), 'cache', 'thedotmack', 'claude-mem', version);
}

function readJsonSafe(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmpPath, filePath);
}

function syncClaudePluginRegistry(options = {}) {
  const claudeConfigDir = options.claudeConfigDir || defaultClaudeConfigDir();
  const version = String(options.version || '').trim();

  if (!version) {
    throw new Error('syncClaudePluginRegistry requires a plugin version');
  }

  const now = options.now || new Date().toISOString();
  const pluginsDir = pluginsDirectory(claudeConfigDir);
  const cachePath = options.cachePath || pluginCacheDirectory(version, claudeConfigDir);
  const installLocation = options.installLocation || marketplaceDirectory(claudeConfigDir);
  const installedPluginsPath = path.join(pluginsDir, 'installed_plugins.json');
  const knownMarketplacesPath = path.join(pluginsDir, 'known_marketplaces.json');

  mkdirSync(pluginsDir, { recursive: true });

  const installedPlugins = readJsonSafe(installedPluginsPath, {});
  const plugins =
    installedPlugins.plugins && typeof installedPlugins.plugins === 'object'
      ? installedPlugins.plugins
      : {};
  const previousEntry = Array.isArray(plugins[PLUGIN_ID])
    ? plugins[PLUGIN_ID].find(entry => entry?.scope === 'user') || plugins[PLUGIN_ID][0]
    : null;

  installedPlugins.version = installedPlugins.version || 2;
  installedPlugins.plugins = plugins;
  installedPlugins.plugins[PLUGIN_ID] = [
    {
      scope: 'user',
      installPath: cachePath,
      version,
      installedAt: previousEntry?.installedAt || now,
      lastUpdated: now,
    },
  ];
  writeJsonAtomic(installedPluginsPath, installedPlugins);

  const knownMarketplaces = readJsonSafe(knownMarketplacesPath, {});
  knownMarketplaces.thedotmack = {
    source: {
      source: 'github',
      repo: 'thedotmack/claude-mem',
    },
    installLocation,
    lastUpdated: now,
    autoUpdate: true,
  };
  writeJsonAtomic(knownMarketplacesPath, knownMarketplaces);

  return {
    cachePath,
    installLocation,
    installedPluginsPath,
    knownMarketplacesPath,
  };
}

module.exports = {
  PLUGIN_ID,
  marketplaceDirectory,
  pluginCacheDirectory,
  syncClaudePluginRegistry,
};

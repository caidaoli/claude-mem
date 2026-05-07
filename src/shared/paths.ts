import { join, dirname, basename, sep } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { logger } from '../utils/logger.js';

/**
 * Get the runtime script directory.
 *
 * When bundled by esbuild, `__dirname` gets inlined to the *source* path at build time,
 * not the runtime path. This breaks path resolution since we need paths relative to
 * where the script actually runs (e.g., ~/.claude/plugins/.../plugin/scripts/).
 *
 * Solution: Use process.argv[1] which always points to the actual running script.
 */
function getRuntimeScriptDir(): string {
  // process.argv[1] is the path to the script being executed
  // This works correctly even after bundling
  const scriptPath = process.argv[1];
  if (scriptPath) {
    return dirname(scriptPath);
  }
  // Fallback for edge cases (e.g., REPL)
  return process.cwd();
}

/**
 * Simple path configuration for claude-mem
 * Standard paths based on Claude Code conventions
 */

// Base directories
// Resolve DATA_DIR with full priority: env var > settings.json > default.
// SettingsDefaultsManager.get() handles env > default. For settings file
// support, we do a one-time synchronous read of the default settings path
// to check if the user configured a custom DATA_DIR there.
export function resolveDataDir(): string {
  if (process.env.CLAUDE_MEM_DATA_DIR) {
    return process.env.CLAUDE_MEM_DATA_DIR;
  }

  const defaultDataDir = join(homedir(), '.claude-mem');
  const settingsPath = join(defaultDataDir, 'settings.json');
  try {
    if (existsSync(settingsPath)) {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const settings = raw.env ?? raw; 
      if (settings.CLAUDE_MEM_DATA_DIR) {
        return settings.CLAUDE_MEM_DATA_DIR;
      }
    }
  } catch {
    // settings file missing or corrupt — fall through to default
  }

  return defaultDataDir;
}

export const DATA_DIR = resolveDataDir();
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

export const MARKETPLACE_ROOT = join(CLAUDE_CONFIG_DIR, 'plugins', 'marketplaces', 'thedotmack');

export const ARCHIVES_DIR = join(DATA_DIR, 'archives');
export const LOGS_DIR = join(DATA_DIR, 'logs');
export const TRASH_DIR = join(DATA_DIR, 'trash');
export const BACKUPS_DIR = join(DATA_DIR, 'backups');
export const MODES_DIR = join(DATA_DIR, 'modes');
export const USER_SETTINGS_PATH = join(DATA_DIR, 'settings.json');
export const DB_PATH = join(DATA_DIR, 'claude-mem.db');
export const VECTOR_DB_DIR = join(DATA_DIR, 'vector-db');

export const OBSERVER_SESSIONS_DIR = join(DATA_DIR, 'observer-sessions');

export const OBSERVER_SESSIONS_PROJECT = basename(OBSERVER_SESSIONS_DIR);

export const CLAUDE_SETTINGS_PATH = join(CLAUDE_CONFIG_DIR, 'settings.json');
export const CLAUDE_COMMANDS_DIR = join(CLAUDE_CONFIG_DIR, 'commands');
export const CLAUDE_MD_PATH = join(CLAUDE_CONFIG_DIR, 'CLAUDE.md');

export function getProjectArchiveDir(projectName: string): string {
  return join(ARCHIVES_DIR, projectName);
}

export function getWorkerSocketPath(sessionId: number): string {
  return join(DATA_DIR, `worker-${sessionId}.sock`);
}

export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

export function ensureAllDataDirs(): void {
  ensureDir(DATA_DIR);
  ensureDir(ARCHIVES_DIR);
  ensureDir(LOGS_DIR);
  ensureDir(TRASH_DIR);
  ensureDir(BACKUPS_DIR);
  ensureDir(MODES_DIR);
}

export function ensureModesDir(): void {
  ensureDir(MODES_DIR);
}

export function ensureAllClaudeDirs(): void {
  ensureDir(CLAUDE_CONFIG_DIR);
  ensureDir(CLAUDE_COMMANDS_DIR);
}

export function getCurrentProjectName(): string {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    }).trim();
    return basename(dirname(gitRoot)) + '/' + basename(gitRoot);
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Git root detection failed, using cwd basename', {
      cwd: process.cwd()
    }, error instanceof Error ? error : new Error(String(error)));
    const cwd = process.cwd();
    return basename(dirname(cwd)) + '/' + basename(cwd);
  }
}

export function getPackageRoot(): string {
  return join(getRuntimeScriptDir(), '..');
}

export function getPackageCommandsDir(): string {
  const packageRoot = getPackageRoot();
  return join(packageRoot, 'commands');
}

export function createBackupFilename(originalPath: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);

  return `${originalPath}.backup.${timestamp}`;
}

export const paths = {
  dataDir: () => DATA_DIR,
  workerPid: () => join(DATA_DIR, 'worker.pid'),
  settings: () => join(DATA_DIR, 'settings.json'),
  database: () => join(DATA_DIR, 'claude-mem.db'),
  chroma: () => join(DATA_DIR, 'chroma'),
  combinedCerts: () => join(DATA_DIR, 'combined_certs.pem'),
  transcriptsConfig: () => join(DATA_DIR, 'transcript-watch.json'),
  transcriptsState: () => join(DATA_DIR, 'transcript-watch-state.json'),
  corpora: () => join(DATA_DIR, 'corpora'),
  supervisorRegistry: () => join(DATA_DIR, 'supervisor.json'),
  envFile: () => join(DATA_DIR, '.env'),
  logsDir: () => LOGS_DIR,
  archives: () => ARCHIVES_DIR,
  trash: () => TRASH_DIR,
  backups: () => BACKUPS_DIR,
  modes: () => MODES_DIR,
  vectorDb: () => VECTOR_DB_DIR,
  observerSessions: () => OBSERVER_SESSIONS_DIR,
} as const;

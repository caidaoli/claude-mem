import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFileWithBom } from '../../shared/atomic-json.js';
import { isPidAlive } from '../../supervisor/process-registry.js';
import { settingsTarget } from '../../shared/settings-document.js';
import type { ProjectDatabaseSelection } from './database.js';

export function assertProjectDeletionOffline(dataDir: string): void {
  if (lstatSync(dataDir).isSymbolicLink()) throw new Error('Refusing a symlinked claude-mem data directory.');
  for (const name of ['worker.pid', '.server-beta.pid']) {
    const path = join(dataDir, name);
    if (!existsSync(path)) continue;
    const record = readJsonFileWithBom<{ pid: number }>(path);
    if (!Number.isInteger(record.pid) || record.pid <= 0) throw new Error(`Invalid process record: ${path}`);
    if (isPidAlive(record.pid)) {
      throw new Error('Stop claude-mem and close active agent sessions before deleting project memory (npm run worker:stop).');
    }
  }
}

export function assertCloudErasureAvailable(dataDir: string, selections: ProjectDatabaseSelection[]): void {
  const path = join(dataDir, 'settings.json');
  const settings = existsSync(path) ? settingsTarget(readJsonFileWithBom<Record<string, unknown>>(path)) : {};
  const value = (key: string) => process.env[key] ?? settings[key];
  if (['CLAUDE_MEM_CLOUD_SYNC_TOKEN', 'CLAUDE_MEM_CLOUD_SYNC_USER_ID', 'CLAUDE_MEM_CLOUD_SYNC_HUB_URL'].some(key => value(key))
    || selections.some(selection => selection.cloudEvidence.length > 0)) {
    throw new Error('Complete cloud erasure is unavailable: Sync Hub retains historical operation bodies and exposes no project erasure/backup-purge API. No project data was deleted. Obtain server-side erasure before using this offline tool.');
  }
  if (value('CLAUDE_MEM_CHROMA_MODE') === 'remote') {
    throw new Error('Complete erasure of a remote Chroma store and its backups cannot be verified by this offline tool. No project data was deleted.');
  }
}

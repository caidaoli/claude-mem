import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listProjectDatabaseInventory } from './database.js';

export interface ProjectDatabaseFile {
  path: string;
  db: Database;
  backup: boolean;
}

/** Open snapshots without SessionStore: deletion must not migrate old backups. */
export function openProjectDatabases(dataDir: string): ProjectDatabaseFile[] {
  const files: Array<{ path: string; backup: boolean }> = [];
  const live = join(dataDir, 'claude-mem.db');
  if (existsSync(live)) files.push({ path: live, backup: false });
  for (const name of readdirSync(dataDir)) {
    if (!/^claude-mem\.db\.restore-(staging|raw)-/.test(name)) continue;
    if (/\.live-(wal|shm)$/.test(name)) {
      throw new Error(`Interrupted restore has detached SQLite sidecars; resolve it before project deletion: ${join(dataDir, name)}`);
    }
    if (!/-(wal|shm|journal)$/.test(name)) files.push({ path: join(dataDir, name), backup: true });
  }
  const backups = join(dataDir, 'backups');
  function visit(directory: string): void {
    if (!existsSync(directory)) return;
    if (lstatSync(directory).isSymbolicLink()) throw new Error(`Refusing a symlinked backup directory: ${directory}`);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing a symlink in the backup directory: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (/\.db(?:\.partial)?$/.test(entry.name)) files.push({ path, backup: true });
    }
  }
  visit(backups);
  const opened: ProjectDatabaseFile[] = [];
  try {
    for (const file of files) {
      if (lstatSync(file.path).isSymbolicLink()) throw new Error(`Refusing a symlinked database: ${file.path}`);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        if (existsSync(file.path + suffix) && lstatSync(file.path + suffix).isSymbolicLink()) {
          throw new Error(`Refusing a symlinked SQLite sidecar: ${file.path + suffix}`);
        }
      }
      const db = new Database(file.path, { readwrite: true, create: false });
      opened.push({ ...file, db });
      db.exec('PRAGMA foreign_keys=ON');
      const check = db.query('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
      if (check.length !== 1 || check[0].quick_check !== 'ok') throw new Error(`Database integrity check failed: ${file.path}`);
      // Also validates the project's schema before any deletion starts.
      listProjectDatabaseInventory(db);
    }
    return opened;
  } catch (error) {
    for (const file of opened) file.db.close();
    throw error;
  }
}

export function compactProjectDatabase(file: ProjectDatabaseFile): void {
  file.db.exec('VACUUM');
  const result = file.db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
  if (result.busy !== 0) throw new Error(`Database is still in use; could not clear its WAL: ${file.path}`);
  const check = file.db.query('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
  if (check.length !== 1 || check[0].quick_check !== 'ok') throw new Error(`Database integrity check failed after deletion: ${file.path}`);
}

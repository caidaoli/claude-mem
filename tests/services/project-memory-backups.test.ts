import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProjectDatabases, compactProjectDatabase } from '../../src/services/project-memory/backups.js';
import { inspectProjectDatabase, listProjectDatabaseInventory, purgeProjectDatabase } from '../../src/services/project-memory/database.js';
import { assertCloudErasureAvailable, assertProjectDeletionOffline } from '../../src/services/project-memory/preflight.js';
import { runDeleteProjectCommand, type DeleteProjectInteraction } from '../../src/services/project-memory/cli.js';

describe('project deletion backups and preflight', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'project-purge-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  function snapshot(path: string) {
    const db = new Database(path);
    db.exec('CREATE TABLE work_state_entries(id INTEGER PRIMARY KEY, project TEXT NOT NULL, fields TEXT NOT NULL)');
    db.query('INSERT INTO work_state_entries VALUES(1, ?, ?)').run('alpha', 'private-project-record');
    db.query('INSERT INTO work_state_entries VALUES(2, ?, ?)').run('beta', 'keep');
    db.close();
  }

  it('purges current and historical schemas without migrating backups or removing other projects', () => {
    const backups = join(directory, 'backups', 'auto');
    mkdirSync(backups, { recursive: true });
    snapshot(join(directory, 'claude-mem.db'));
    snapshot(join(backups, 'claude-mem-2026-01-01.db'));
    snapshot(join(directory, 'backups', 'claude-mem-pre-12.4.3-2025.db'));
    const files = openProjectDatabases(directory);
    try {
      expect(files.length).toBe(3);
      for (const file of files) {
        purgeProjectDatabase(file.db, ['alpha']);
        compactProjectDatabase(file);
        expect(listProjectDatabaseInventory(file.db).map(row => row.project)).toEqual(['beta']);
        expect(file.db.query('SELECT fields FROM work_state_entries').all()).toEqual([{ fields: 'keep' }]);
        expect(file.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'work_state_entries' }]);
      }
    } finally { files.forEach(file => file.db.close()); }
  });

  it('discovers a project surviving only in a backup', () => {
    mkdirSync(join(directory, 'backups'));
    snapshot(join(directory, 'backups', 'claude-mem-old.db'));
    const files = openProjectDatabases(directory);
    try {
      expect(files.every(file => file.backup)).toBe(true);
      expect(listProjectDatabaseInventory(files[0].db).map(row => row.project)).toEqual(['alpha', 'beta']);
    } finally { files.forEach(file => file.db.close()); }
  });

  it('includes complete interrupted restore copies and refuses detached restore WALs', () => {
    snapshot(join(directory, 'claude-mem.db.restore-staging-2026-01-01'));
    snapshot(join(directory, 'claude-mem.db.restore-raw-2026-01-01'));
    const files = openProjectDatabases(directory);
    try {
      expect(files.length).toBe(2);
      for (const file of files) {
        purgeProjectDatabase(file.db, ['alpha']);
        compactProjectDatabase(file);
        expect(listProjectDatabaseInventory(file.db).map(row => row.project)).toEqual(['beta']);
      }
    } finally { files.forEach(file => file.db.close()); }
    writeFileSync(join(directory, 'claude-mem.db.restore-staging-2026-01-01.live-wal'), 'unattributable WAL');
    expect(() => openProjectDatabases(directory)).toThrow('detached SQLite sidecars');
  });

  it('rejects an escaping snapshot link before opening or changing it', () => {
    const outside = join(directory, 'outside.db');
    snapshot(outside);
    mkdirSync(join(directory, 'backups'));
    symlinkSync(outside, join(directory, 'backups', 'claude-mem-old.db'));
    expect(() => openProjectDatabases(directory)).toThrow('symlink');
    const db = new Database(outside, { readonly: true });
    expect(listProjectDatabaseInventory(db).length).toBe(2);
    db.close();
  });

  it('refuses to erase synchronized history without a cloud erasure API', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE work_state_entries(id INTEGER PRIMARY KEY, project TEXT, synced_at INTEGER)');
    db.exec("INSERT INTO work_state_entries VALUES(1, 'alpha', 123)");
    const selected = inspectProjectDatabase(db, ['alpha']);
    expect(() => assertCloudErasureAvailable(directory, [selected])).toThrow('Complete cloud erasure is unavailable');
    expect(db.query('SELECT COUNT(*) AS n FROM work_state_entries').get()).toEqual({ n: 1 });
    db.close();
  });

  it('recognizes nested cloud configuration and a live worker before any deletion', () => {
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ env: { CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://example.invalid' } }));
    expect(() => assertCloudErasureAvailable(directory, [])).toThrow('Complete cloud erasure');
    writeFileSync(join(directory, 'worker.pid'), JSON.stringify({ pid: process.pid }));
    expect(() => assertProjectDeletionOffline(directory)).toThrow('Stop claude-mem');
  });

  it('runs the complete confirmed command over current data, backup-only records, files and shared logs', async () => {
    const previous = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = directory;
    mkdirSync(join(directory, 'backups'));
    mkdirSync(join(directory, 'logs'));
    mkdirSync(join(directory, 'state', 'context-cache'), { recursive: true });
    snapshot(join(directory, 'claude-mem.db'));
    snapshot(join(directory, 'backups', 'claude-mem-old.db'));
    const backup = new Database(join(directory, 'backups', 'claude-mem-old.db'));
    backup.query('INSERT INTO work_state_entries VALUES(3, ?, ?)').run('archive-only', 'old secret');
    backup.close();
    const cache = join(directory, 'state', 'context-cache', 'alpha.json');
    writeFileSync(cache, JSON.stringify({ keys: { projects: ['alpha'] }, body: 'private cache' }));
    writeFileSync(join(directory, 'logs', 'claude-mem-old.log'), 'shared diagnostic content');
    const messages: string[] = [];
    const output = (message: string) => { messages.push(message); };
    const interaction: DeleteProjectInteraction = {
      intro: output, info: output, warn: output, success: output, cancel: output, outro: output,
      async selectProjects(options) {
        expect(options.map(option => option.project)).toContain('archive-only');
        return ['alpha', 'archive-only'];
      },
      async confirmDeletion() { return true; },
    };
    try {
      const result = await runDeleteProjectCommand([], { interaction });
      expect(messages.join('\n')).toContain('ALL shared claude-mem diagnostic logs');
      expect(result).toBe(0);
      expect(existsSync(cache)).toBe(false);
      expect(existsSync(join(directory, 'logs', 'claude-mem-old.log'))).toBe(false);
      expect(existsSync(join(directory, 'spawn.lock'))).toBe(false);
      expect(existsSync(join(directory, 'project-delete-pending.json'))).toBe(false);
      const files = openProjectDatabases(directory);
      try { for (const file of files) expect(listProjectDatabaseInventory(file.db).map(row => row.project)).toEqual(['beta']); }
      finally { files.forEach(file => file.db.close()); }
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
      else process.env.CLAUDE_MEM_DATA_DIR = previous;
    }
  });

  it('finishes an explicitly resumed deletion after the project rows are already gone', async () => {
    const previous = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = directory;
    const db = new Database(join(directory, 'claude-mem.db'));
    db.exec('CREATE TABLE work_state_entries(id INTEGER PRIMARY KEY, project TEXT, fields TEXT)');
    db.exec("INSERT INTO work_state_entries VALUES(1, 'beta', 'keep')");
    db.close();
    const receipt = join(directory, 'project-delete-pending.json');
    writeFileSync(receipt, JSON.stringify({ projects: ['alpha'] }));
    const messages: string[] = [];
    const output = (message: string) => { messages.push(message); };
    const interaction: DeleteProjectInteraction = {
      intro: output, info: output, warn: output, success: output, cancel: output, outro: output,
      async selectProjects(options) {
        expect(options.map(option => option.project)).toContain('alpha');
        return ['alpha'];
      },
      async confirmDeletion() { return true; },
    };
    try {
      expect(await runDeleteProjectCommand([], { interaction })).toBe(0);
      expect(existsSync(receipt)).toBe(false);
      const reopened = new Database(join(directory, 'claude-mem.db'));
      expect(reopened.query('SELECT fields FROM work_state_entries').all()).toEqual([{ fields: 'keep' }]);
      reopened.close();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
      else process.env.CLAUDE_MEM_DATA_DIR = previous;
    }
  });
});

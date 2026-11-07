import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProjectDatabases, compactProjectDatabase } from '../../src/services/project-memory/backups.js';
import { inspectProjectDatabase, listProjectDatabaseInventory, purgeProjectDatabase } from '../../src/services/project-memory/database.js';
import { assertCloudErasureAvailable, assertProjectDeletionOffline } from '../../src/services/project-memory/preflight.js';
import { runDeleteProjectCommand, type DeleteProjectInteraction } from '../../src/services/project-memory/cli.js';
import { acquireSpawnLock } from '../../src/shared/worker-spawn-gate.js';
import type { ShutdownResult } from '../../src/services/install/shutdown-helper.js';

const alreadyStopped = async (): Promise<ShutdownResult> => ({ stopped: true, workerWasRunning: false });

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

  it('does not treat unedited v47 launch-baseline rows as uploaded cloud history', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE observations(id INTEGER PRIMARY KEY, project TEXT, synced_at INTEGER, sync_rev INTEGER, origin_device_id TEXT, origin_local_id TEXT);
      CREATE TABLE sync_launch_exclusions(kind TEXT, origin_local_id TEXT, through_rev TEXT, PRIMARY KEY(kind, origin_local_id));
      CREATE TABLE sync_recovery_items(job_id TEXT, kind TEXT, origin_local_id TEXT, entity_id TEXT);
      INSERT INTO observations VALUES(1,'alpha',123,9,NULL,NULL),(2,'beta',123,10,NULL,NULL),(3,'gamma',123,9,NULL,NULL);
      INSERT INTO sync_launch_exclusions VALUES('observation','1','9'),('observation','2','9'),('observation','3','9');
      INSERT INTO sync_recovery_items VALUES('job','observation','3','entity-3')`);
    try {
      expect(inspectProjectDatabase(db, ['alpha']).cloudEvidence).toEqual([]);
      assertCloudErasureAvailable(directory, [inspectProjectDatabase(db, ['alpha'])]);
      expect(inspectProjectDatabase(db, ['beta']).cloudEvidence).toEqual(['observations: synchronized records']);
      expect(inspectProjectDatabase(db, ['gamma']).cloudEvidence).toEqual(['observations: synchronized records']);
    } finally { db.close(); }
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
      const result = await runDeleteProjectCommand([], { interaction, stopWorker: alreadyStopped });
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
      expect(await runDeleteProjectCommand([], { interaction, stopWorker: alreadyStopped })).toBe(0);
      expect(existsSync(receipt)).toBe(false);
      const reopened = new Database(join(directory, 'claude-mem.db'));
      expect(reopened.query('SELECT fields FROM work_state_entries').all()).toEqual([{ fields: 'keep' }]);
      reopened.close();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
      else process.env.CLAUDE_MEM_DATA_DIR = previous;
    }
  });

  describe('automatic worker shutdown', () => {
    let previousDataDir: string | undefined;
    let messages: string[];
    let interaction: DeleteProjectInteraction;
    let selected: boolean;
    let confirmed: boolean;

    beforeEach(() => {
      previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
      process.env.CLAUDE_MEM_DATA_DIR = directory;
      snapshot(join(directory, 'claude-mem.db'));
      writeFileSync(join(directory, 'settings.json'), JSON.stringify({ env: { CLAUDE_MEM_WORKER_PORT: '38888' } }));
      messages = [];
      selected = false;
      confirmed = false;
      const output = (message: string) => { messages.push(message); };
      interaction = {
        intro: output, info: output, warn: output, success: output, cancel: output, outro: output,
        async selectProjects() { selected = true; return ['alpha']; },
        async confirmDeletion() { confirmed = true; return false; },
      };
    });

    afterEach(() => {
      if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
      else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
    });

    function expectDataIntact() {
      const db = new Database(join(directory, 'claude-mem.db'), { readonly: true });
      try { expect(listProjectDatabaseInventory(db).map(row => row.project)).toEqual(['alpha', 'beta']); }
      finally { db.close(); }
      expect(existsSync(join(directory, 'spawn.lock'))).toBe(false);
      expect(existsSync(join(directory, 'project-delete-pending.json'))).toBe(false);
    }

    it('stops the configured worker while blocking respawn and still requires deletion confirmation', async () => {
      const pidPath = join(directory, 'worker.pid');
      writeFileSync(pidPath, JSON.stringify({ pid: process.pid }));
      let stopped = false;
      const result = await runDeleteProjectCommand([], {
        interaction,
        async stopWorker(port) {
          expect(port).toBe(38888);
          expect(acquireSpawnLock()).toBe(false);
          expect(selected).toBe(false);
          unlinkSync(pidPath);
          stopped = true;
          return { stopped: true, workerWasRunning: true };
        },
      });
      expect(result).toBe(0);
      expect(stopped).toBe(true);
      expect(confirmed).toBe(true);
      expectDataIntact();
    });

    it.each(['worker-still-running', 'port-rebound', 'port-held-by-other-process'] as const)(
      'aborts without deletion when shutdown reports %s', async (kind) => {
        const result = await runDeleteProjectCommand([], {
          interaction,
          async stopWorker() {
            return { stopped: false, workerWasRunning: true, blocker: { kind, pid: null, ownerPid: null } };
          },
        });
        expect(result).toBe(1);
        expect(selected).toBe(false);
        expect(messages.join('\n')).toContain(kind);
        expectDataIntact();
      },
    );

    it('verifies local processes are gone even when shutdown reports success', async () => {
      writeFileSync(join(directory, '.server-beta.pid'), JSON.stringify({ pid: process.pid }));
      expect(await runDeleteProjectCommand([], { interaction, stopWorker: alreadyStopped })).toBe(1);
      expect(selected).toBe(false);
      expect(messages.join('\n')).toContain('Stop claude-mem');
      expectDataIntact();
    });
  });
});

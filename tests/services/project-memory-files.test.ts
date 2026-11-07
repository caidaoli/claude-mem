import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cleanProjectDiagnosticLogs, cleanProjectMemoryFiles, inventoryProjectMemoryFiles, listFileProjects, type ProjectMemoryFileScope } from '../../src/services/project-memory/files.js';
import { loadWatchState } from '../../src/services/transcripts/state.js';

describe('project memory file cleanup', () => {
  let root: string;
  let scope: ProjectMemoryFileScope;
  const key = (id: string, platform = 'claude') => JSON.stringify(['conversation', platform, id]);
  const json = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  };
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'project-files-'));
    scope = { dataDir: root, projects: ['alpha'], sessions: [{ content_session_id: 'session-a', platform_source: 'claude', cwd: '/repos/alpha' }],
      deliverables: [], retainedDeliverablePaths: [] };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds explicit project keys when only file caches or spooled deliverables remain', () => {
    json(join(root, 'state/context-cache/a.json'), { keys: { projects: ['only-cache'] }, body: 'saved memory' });
    json(join(root, 'corpora/research.corpus.json'), { filter: {}, observations: [{ project: 'only-corpus' }] });
    json(join(root, 'work-view-backup/request-groups.json.bak'), { groups: { g: { projectRoot: 'only-ledger' } }, conversations: {} });
    json(join(root, 'state/hook-spool/expired/deliverables-a.json'), { kind: 'deliverables', payload: { project: 'only-deliverable' } });
    expect(listFileProjects(root)).toEqual(['only-cache', 'only-corpus', 'only-deliverable', 'only-ledger']);
  });

  it('removes only selected bucket copies and keeps another project sharing the sanitized folder', () => {
    const own = join(root, 'deliverables/owner-repo/own.txt');
    const shared = join(root, 'deliverables/owner-repo/shared.txt');
    const unrelated = join(root, 'deliverables/owner-repo/other.txt');
    for (const path of [own, shared, unrelated]) json(path, { evidence: path });
    scope.deliverables = [{ bucket_path: own }, { bucket_path: shared }];
    scope.retainedDeliverablePaths = [shared, unrelated];
    const inventory = inventoryProjectMemoryFiles(scope);
    expect(existsSync(own)).toBe(true);
    cleanProjectMemoryFiles(inventory);
    expect(existsSync(own)).toBe(false);
    expect(existsSync(shared)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('rejects bucket escapes and symlinks before deleting any file', () => {
    const outside = join(root, 'source.txt');
    json(outside, { keep: true });
    scope.deliverables = [{ bucket_path: outside }];
    expect(() => inventoryProjectMemoryFiles(scope)).toThrow('outside the deliverables');
    mkdirSync(join(root, 'deliverables'), { recursive: true });
    const link = join(root, 'deliverables/alpha');
    symlinkSync(root, link);
    scope.deliverables = [{ bucket_path: join(link, 'source.txt') }];
    expect(() => inventoryProjectMemoryFiles(scope)).toThrow('symbolic link');
    expect(read(outside)).toEqual({ keep: true });
  });

  it('invalidates matching context variants and corpora while preserving unrelated cached records', () => {
    const cache = join(root, 'state/context-cache');
    json(join(cache, 'mixed.json'), { keys: { projects: ['alpha', 'beta'] }, body: 'alpha memory' });
    json(join(cache, 'beta.json'), { keys: { projects: ['beta'] }, body: 'beta memory' });
    json(join(cache, 'variants.json'), { variants: [{ keys: { projects: ['alpha'] } }, { keys: { projects: ['beta'] } }] });
    const observation = (id: number, project: string) => ({ id, project, type: 'discovery', title: `${project} memory`, subtitle: null, narrative: null,
      facts: [], concepts: [], files_read: [], files_modified: [], created_at_epoch: 1000, created_at: new Date(1000).toISOString() });
    json(join(root, 'corpora/mixed.corpus.json'), { version: 1, name: 'mixed', description: 'Research', filter: {},
      observations: [observation(1, 'alpha'), observation(2, 'beta')], system_prompt: 'old alpha corpus', session_id: 'old' });
    json(join(root, 'corpora/beta.corpus.json'), { filter: { project: 'beta' }, observations: [{ id: 1, project: 'beta' }] });
    scope.observationIds = [1];
    cleanProjectMemoryFiles(inventoryProjectMemoryFiles(scope));
    expect(existsSync(join(cache, 'mixed.json'))).toBe(false);
    expect(read(join(cache, 'beta.json')).body).toBe('beta memory');
    expect(read(join(cache, 'variants.json')).variants).toEqual([{ keys: { projects: ['beta'] } }]);
    const mixed = read(join(root, 'corpora/mixed.corpus.json'));
    expect(mixed.observations).toEqual([observation(2, 'beta')]);
    expect(mixed.stats.observation_count).toBe(1);
    expect(mixed.stats.type_breakdown).toEqual({ discovery: 1 });
    expect(mixed.stats.token_estimate).toBeGreaterThan(0);
    expect(mixed.system_prompt).not.toContain('old alpha corpus');
    expect(mixed.session_id).toBeNull();
    expect(existsSync(join(root, 'corpora/beta.corpus.json'))).toBe(true);
  });

  it('clears selected ledger records, backups and reviews and invalidates cross-project derived text', () => {
    const own = 'g_111111111111', other = 'g_222222222222';
    const ownRequest = JSON.stringify(['overall-request', own]);
    const otherRequest = JSON.stringify(['overall-request', other]);
    const groups = { version: 1, groups: { [own]: { projectRoot: 'alpha', anchor: key('session-a'), anchorAsk: { text: 'alpha ask' } },
      [other]: { projectRoot: 'beta', anchor: key('session-b'), title: 'keep beta' } },
      conversations: { [key('session-a')]: own, [key('session-b')]: other }, ignored: { [key('session-a')]: 'alpha reason' }, suggestions: {} };
    const ledger = join(root, 'work-view');
    json(join(ledger, 'request-groups.json'), groups);
    json(join(root, 'backups/work-view-old/request-groups.json.bak'), groups);
    json(join(ledger, `progress/${own}.json`), { groupId: own, summary: 'alpha progress' });
    json(join(ledger, `progress/${other}.json`), { groupId: other, summary: 'beta progress' });
    json(join(ledger, 'human-copy.json'), { version: 1, entries: { [ownRequest]: { copy: 'alpha copy' }, [otherRequest]: { copy: 'beta copy' } } });
    writeFileSync(join(ledger, 'human-copy-usage.jsonl'), `${JSON.stringify({ requestId: ownRequest })}\n${JSON.stringify({ requestId: otherRequest })}\n`);
    json(join(ledger, 'agent-written-prompts.json'), { promptIds: [10, 20] });
    scope.promptIds = [10];
    for (const name of ['story.json', 'refresh.json', 'hosted-intent-pending.json', 'owner-goals/old/owner-prompts.md', 'agent-runs/old/input.json', 'failed-answers/old.txt']) {
      json(join(ledger, name), { text: 'mixed derived alpha evidence' });
    }
    const reviewPath = join(root, 'work-view-reviews.db');
    const db = new Database(reviewPath);
    db.exec('CREATE TABLE work_view_reviews(request_id TEXT PRIMARY KEY); CREATE TABLE work_view_review_overrides(request_id TEXT PRIMARY KEY)');
    for (const table of ['work_view_reviews', 'work_view_review_overrides']) for (const id of [ownRequest, otherRequest]) db.prepare(`INSERT INTO ${table} VALUES (?)`).run(id);
    db.close();
    const result = cleanProjectMemoryFiles(inventoryProjectMemoryFiles(scope));
    expect(result.removedReviews).toBe(2);
    expect(read(join(ledger, 'request-groups.json')).groups).toEqual({ [other]: groups.groups[other] });
    expect(read(join(root, 'backups/work-view-old/request-groups.json.bak')).conversations).toEqual({ [key('session-b')]: other });
    expect(existsSync(join(ledger, `progress/${own}.json`))).toBe(false);
    expect(read(join(ledger, `progress/${other}.json`)).summary).toBe('beta progress');
    expect(read(join(ledger, 'human-copy.json')).entries).toEqual({ [otherRequest]: { copy: 'beta copy' } });
    expect(readFileSync(join(ledger, 'human-copy-usage.jsonl'), 'utf8')).toBe(`${JSON.stringify({ requestId: otherRequest })}\n`);
    expect(read(join(ledger, 'agent-written-prompts.json')).promptIds).toEqual([20]);
    expect(existsSync(join(ledger, 'story.json'))).toBe(false);
    expect(existsSync(join(ledger, 'owner-goals/old/owner-prompts.md'))).toBe(false);
    const reviews = new Database(reviewPath, { readonly: true });
    expect(reviews.prepare('SELECT request_id FROM work_view_reviews').all()).toEqual([{ request_id: otherRequest }]);
    reviews.close();
  });

  it('retires matching spool evidence including expired, corrupt and legacy files without replay', () => {
    const spool = join(root, 'state/hook-spool');
    for (const folder of ['', 'expired', 'corrupt']) {
      json(join(spool, folder, 'alpha.json'), { kind: 'observation', payload: { contentSessionId: 'session-a', platformSource: 'claude', toolInput: 'alpha source' } });
    }
    json(join(spool, 'beta.json'), { kind: 'deliverables', payload: { project: 'beta', contentSessionId: 'session-b', platformSource: 'claude' } });
    json(join(spool, 'same-id-codex.json'), { kind: 'observation', payload: { contentSessionId: 'session-a', platformSource: 'codex' } });
    json(join(root, 'state/session-end-replay/alpha.json'), { contentSessionId: 'session-a', platformSource: 'claude' });
    writeFileSync(join(spool, 'corrupt/unattributed.json'), 'not json');
    const inventory = inventoryProjectMemoryFiles(scope);
    expect(inventory.unattributedPaths).toEqual([join(spool, 'corrupt/unattributed.json')]);
    cleanProjectMemoryFiles(inventory);
    for (const folder of ['', 'expired', 'corrupt']) expect(existsSync(join(spool, folder, 'alpha.json'))).toBe(false);
    expect(existsSync(join(root, 'state/session-end-replay/alpha.json'))).toBe(false);
    expect(existsSync(join(spool, 'beta.json'))).toBe(true);
    expect(existsSync(join(spool, 'same-id-codex.json'))).toBe(true);
  });

  it('erases watched source fragments but preserves checkpoint positions across reloads', () => {
    const transcript = '/original/rollout-session-a.jsonl.zstd';
    const other = '/original/rollout-session-b.jsonl';
    const path = join(root, 'transcript-watch-state.json');
    json(path, { offsets: { [transcript]: 100, [other]: 90 }, fileIdentities: { [transcript]: 'dev:ino' },
      checkpointFingerprints: { [transcript]: 'fingerprint' }, frameLines: { [transcript]: 8 },
      pendingTools: { [transcript]: { 'codex:session-a': { tool: { toolName: 'Write', toolInput: 'private source' } } }, [other]: { 'claude:session-b': {} } },
      partials: { [transcript]: 'private source prefix' }, partialBytes: { [transcript]: 'YQ==' }, cwds: { [transcript]: '/repos/alpha', [other]: '/repos/beta' } });
    const inventory = inventoryProjectMemoryFiles(scope);
    expect(inventory.preservedWatchCheckpoints).toEqual([transcript]);
    cleanProjectMemoryFiles(inventory);
    const state = loadWatchState(path);
    expect(state.offsets).toEqual({ [transcript]: 100, [other]: 90 });
    expect(state.frameLines?.[transcript]).toBe(8);
    expect(state.checkpointFingerprints?.[transcript]).toBe('fingerprint');
    expect(state.pendingTools?.[transcript]).toBeUndefined();
    expect(state.partials?.[transcript]).toBeUndefined();
    expect(state.partialBytes?.[transcript]).toBeUndefined();
    expect(state.cwds).toEqual({ [other]: '/repos/beta' });
    expect(readFileSync(path, 'utf8')).not.toContain('private source');
  });

  it('does not attribute another transcript by a substring of a session identifier', () => {
    const other = '/original/rollout-session-a-other.jsonl';
    const path = join(root, 'transcript-watch-state.json');
    json(path, { offsets: { [other]: 90 }, partials: { [other]: 'other project prefix' } });
    const inventory = inventoryProjectMemoryFiles(scope);
    expect(inventory.preservedWatchCheckpoints).toEqual([]);
    cleanProjectMemoryFiles(inventory);
    expect(read(path).partials).toEqual({ [other]: 'other project prefix' });
  });

  it('removes only unreferenced media directories and their staged variants', () => {
    const own = '11111111-1111-4111-8111-111111111111';
    const other = '22222222-2222-4222-8222-222222222222';
    json(join(root, `media-v1/${own}/viewer.webp`), 'selected pixels');
    json(join(root, `media-v1/.tmp/${own}-staging/llm.webp`), 'selected pixels');
    json(join(root, `media-v1/${other}/viewer.webp`), 'other pixels');
    scope.attachmentIds = [own];
    cleanProjectMemoryFiles(inventoryProjectMemoryFiles(scope));
    expect(existsSync(join(root, `media-v1/${own}`))).toBe(false);
    expect(existsSync(join(root, `media-v1/.tmp/${own}-staging`))).toBe(false);
    expect(existsSync(join(root, `media-v1/${other}/viewer.webp`))).toBe(true);
  });

  it('matches ASCII project names like SQLite NOCASE and clears only their Chroma watermarks', () => {
    json(join(root, 'state/context-cache/alpha.json'), { keys: { projects: ['ALPHA'] }, body: 'selected' });
    json(join(root, 'chroma-sync-state.json'), { ALPHA: { observations: 2 }, beta: { observations: 3 } });
    json(join(root, 'state/hook-spool/deliverables-a.json'), { kind: 'deliverables', payload: { project: 'Alpha' } });
    json(join(root, 'work-view/request-groups.json'), { groups: { g: { projectRoot: 'aLPHa' } }, conversations: {} });
    expect(listFileProjects(root)).toEqual(['alpha', 'beta']);
    cleanProjectMemoryFiles(inventoryProjectMemoryFiles(scope));
    expect(existsSync(join(root, 'state/context-cache/alpha.json'))).toBe(false);
    expect(existsSync(join(root, 'state/hook-spool/deliverables-a.json'))).toBe(false);
    expect(read(join(root, 'chroma-sync-state.json'))).toEqual({ beta: { observations: 3 } });
    expect(read(join(root, 'work-view/request-groups.json')).groups).toEqual({});
  });

  it('clears selected files known only by durable metadata and all authorized shared log rotations', () => {
    const copy = join(root, 'deliverables/alpha/report.txt');
    json(copy, { report: 'alpha source' });
    json(join(root, 'state/hook-spool/deliverables-a.json'), { kind: 'deliverables', payload: {
      project: 'alpha', contentSessionId: 'session-a', platformSource: 'claude', files: [{ bucketPath: copy, sourcePath: '/source/keep.txt' }] } });
    json(join(root, 'logs/claude-mem.log'), { diagnostic: 'mixed private source' });
    json(join(root, 'logs/rotated/claude-mem.log.1'), { diagnostic: 'mixed private source' });
    cleanProjectMemoryFiles(inventoryProjectMemoryFiles({ ...scope, sessions: [] }));
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(join(root, 'logs'))).toBe(false);
  });

  it('reports orphaned files in a selected sanitized bucket without guessing their ownership', () => {
    const orphan = join(root, 'deliverables/alpha/orphan.txt');
    json(orphan, { source: 'unattributed' });
    const inventory = inventoryProjectMemoryFiles(scope);
    expect(inventory.unattributedPaths).toEqual([orphan]);
    expect(existsSync(orphan)).toBe(true);
  });

  it('clears diagnostic files created after inventory during the final sweep', () => {
    inventoryProjectMemoryFiles(scope);
    json(join(root, 'logs/new.log'), { diagnostic: 'late diagnostic' });
    expect(cleanProjectDiagnosticLogs(root)).toBe(1);
    expect(existsSync(join(root, 'logs'))).toBe(false);
  });
});

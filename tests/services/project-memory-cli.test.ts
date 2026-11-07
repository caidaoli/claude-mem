import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { OBSERVER_SESSIONS_PROJECT } from '../../src/shared/paths.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { inspectProjectDatabase, listProjectDatabaseInventory, purgeProjectDatabase } from '../../src/services/project-memory/database.js';
import { publishSharedRecords, readSharedRecords } from '../../src/services/work-view/shared-record-store.mjs';
import {
  runDeleteProjectCommand,
  type DeleteProjectInteraction,
  type ProjectDeletionStats,
  type ProjectDeletionSummary,
} from '../../src/services/project-memory/cli.js';

class FakeInteraction implements DeleteProjectInteraction {
  public selectedProjects: string[] | null = null;
  public confirmResult = true;
  public events: string[] = [];
  public selectedOptions: ProjectDeletionStats[] = [];
  public confirmedSummary: ProjectDeletionSummary | null = null;

  intro(message: string): void {
    this.events.push(`intro:${message}`);
  }

  info(message: string): void {
    this.events.push(`info:${message}`);
  }

  warn(message: string): void {
    this.events.push(`warn:${message}`);
  }

  success(message: string): void {
    this.events.push(`success:${message}`);
  }

  cancel(message: string): void {
    this.events.push(`cancel:${message}`);
  }

  outro(message: string): void {
    this.events.push(`outro:${message}`);
  }

  async selectProjects(options: ProjectDeletionStats[]): Promise<string[] | null> {
    this.selectedOptions = options;
    return this.selectedProjects;
  }

  async confirmDeletion(summary: ProjectDeletionSummary): Promise<boolean> {
    this.confirmedSummary = summary;
    return this.confirmResult;
  }
}

function seedProject(store: SessionStore, project: string, suffix: string): void {
  const sessionDbId = store.createSDKSession(`content-${suffix}`, project, `prompt-${suffix}`);
  const memorySessionId = `memory-${suffix}`;
  store.updateMemorySessionId(sessionDbId, memorySessionId);
  store.saveUserPrompt(`content-${suffix}`, 1, `User prompt ${suffix}`);
  store.storeObservation(memorySessionId, project, {
    type: 'feature',
    title: `Feature ${suffix}`,
    subtitle: null,
    facts: [`Fact ${suffix}`],
    narrative: `Narrative ${suffix}`,
    concepts: ['cleanup'],
    files_read: [],
    files_modified: [],
  });
  store.storeSummary(memorySessionId, project, {
    request: `Request ${suffix}`,
    investigated: `Investigated ${suffix}`,
    learned: `Learned ${suffix}`,
    completed: `Completed ${suffix}`,
    next_steps: `Next ${suffix}`,
    notes: null,
  });
}

describe('project-memory CLI helpers', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('lists project deletion candidates with aggregated counts and excludes internal observer project', async () => {
    seedProject(store, 'alpha', 'alpha-1');
    seedProject(store, 'alpha', 'alpha-2');
    seedProject(store, 'beta', 'beta-1');
    store.createSDKSession('observer-content', OBSERVER_SESSIONS_PROJECT, 'internal prompt');

    const interaction = new FakeInteraction();
    expect(await runDeleteProjectCommand([], { store, interaction })).toBe(0);
    const projects = interaction.selectedOptions;

    expect(projects).toMatchObject([
      {
        project: 'alpha',
        sessionCount: 2,
        observationCount: 2,
        summaryCount: 2,
        promptCount: 2,
      },
      {
        project: 'beta',
        sessionCount: 1,
        observationCount: 1,
        summaryCount: 1,
        promptCount: 1,
      },
    ]);
  });

  it('deletes multiple projects and cascades to observations, summaries, and prompts', async () => {
    seedProject(store, 'alpha', 'alpha-1');
    seedProject(store, 'alpha', 'alpha-2');
    seedProject(store, 'beta', 'beta-1');
    seedProject(store, 'gamma', 'gamma-1');

    const interaction = new FakeInteraction();
    interaction.selectedProjects = ['alpha', 'beta'];
    expect(await runDeleteProjectCommand([], { store, interaction })).toBe(0);
    const deleted = interaction.confirmedSummary;

    expect(deleted).toMatchObject({
      projects: ['alpha', 'beta'],
      projectCount: 2,
      sessionCount: 3,
      observationCount: 3,
      summaryCount: 3,
      promptCount: 3,
    });

    const remainingSessions = store.db.prepare(
      'SELECT COUNT(*) AS count FROM sdk_sessions WHERE project = ?'
    ).get('alpha') as { count: number };
    const remainingObservations = store.db.prepare(
      'SELECT COUNT(*) AS count FROM observations WHERE project = ?'
    ).get('alpha') as { count: number };
    const remainingSummaries = store.db.prepare(
      'SELECT COUNT(*) AS count FROM session_summaries WHERE project = ?'
    ).get('alpha') as { count: number };
    const remainingPrompts = store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM user_prompts
      WHERE content_session_id IN (
        SELECT content_session_id FROM sdk_sessions WHERE project = ?
      )
    `).get('alpha') as { count: number };

    expect(remainingSessions.count).toBe(0);
    expect(remainingObservations.count).toBe(0);
    expect(remainingSummaries.count).toBe(0);
    expect(remainingPrompts.count).toBe(0);

    const betaSessions = store.db.prepare(
      'SELECT COUNT(*) AS count FROM sdk_sessions WHERE project = ?'
    ).get('beta') as { count: number };
    expect(betaSessions.count).toBe(0);

    const gammaSessions = store.db.prepare(
      'SELECT COUNT(*) AS count FROM sdk_sessions WHERE project = ?'
    ).get('gamma') as { count: number };
    expect(gammaSessions.count).toBe(1);
  });

  it('interactive command deletes the selected projects after confirmation', async () => {
    seedProject(store, 'alpha', 'alpha-1');
    seedProject(store, 'beta', 'beta-1');
    seedProject(store, 'gamma', 'gamma-1');
    const interaction = new FakeInteraction();
    interaction.selectedProjects = ['alpha', 'gamma'];
    interaction.confirmResult = true;

    const exitCode = await runDeleteProjectCommand([], {
      interaction,
      store,
    });

    expect(exitCode).toBe(0);
    expect(interaction.selectedOptions.map(option => option.project)).toEqual(['alpha', 'beta', 'gamma']);
    expect(interaction.confirmedSummary).toMatchObject({
      projects: ['alpha', 'gamma'],
      projectCount: 2,
      sessionCount: 2,
      observationCount: 2,
      summaryCount: 2,
      promptCount: 2,
    });
    expect(interaction.events.some(event => event.startsWith('success:Deleted 2 projects'))).toBe(true);

    const alphaSessions = store.db.prepare(
      'SELECT COUNT(*) AS count FROM sdk_sessions WHERE project = ?'
    ).get('alpha') as { count: number };
    expect(alphaSessions.count).toBe(0);

    const gammaSessions = store.db.prepare(
      'SELECT COUNT(*) AS count FROM sdk_sessions WHERE project = ?'
    ).get('gamma') as { count: number };
    expect(gammaSessions.count).toBe(0);

    const betaSessions = store.db.prepare(
      'SELECT COUNT(*) AS count FROM sdk_sessions WHERE project = ?'
    ).get('beta') as { count: number };
    expect(betaSessions.count).toBe(1);
  });

  it('interactive command leaves data untouched when confirmation is declined', async () => {
    seedProject(store, 'alpha', 'alpha-1');
    seedProject(store, 'beta', 'beta-1');
    const interaction = new FakeInteraction();
    interaction.selectedProjects = ['alpha', 'beta'];
    interaction.confirmResult = false;

    const exitCode = await runDeleteProjectCommand([], {
      interaction,
      store,
    });

    expect(exitCode).toBe(0);
    expect(interaction.events).toContain('cancel:Deletion cancelled.');

    const alphaSessions = store.db.prepare(
      'SELECT COUNT(*) AS count FROM sdk_sessions WHERE project = ?'
    ).get('alpha') as { count: number };
    expect(alphaSessions.count).toBe(1);

    const betaSessions = store.db.prepare(
      'SELECT COUNT(*) AS count FROM sdk_sessions WHERE project = ?'
    ).get('beta') as { count: number };
    expect(betaSessions.count).toBe(1);
  });
});

describe('complete local project database deletion', () => {
  it('discovers and deletes projects with only independent records in an old schema', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE work_state_entries(id INTEGER PRIMARY KEY, project TEXT, fields TEXT);
        CREATE TABLE token_df(project TEXT, token TEXT, df INTEGER);
        INSERT INTO work_state_entries VALUES(1,'Alpha','private state'),(2,'beta','keep state');
        INSERT INTO token_df VALUES('ALPHA','private-token',1),('beta','keep-token',1)`);
      expect(listProjectDatabaseInventory(db)).toMatchObject([
        { project: 'Alpha', workStateCount: 1, rowCounts: { work_state_entries: 1, token_df: 1 } },
        { project: 'beta', workStateCount: 1 },
      ]);
      const removed = purgeProjectDatabase(db, ['alpha']);
      expect(removed.workStateIds).toEqual([1]);
      expect(db.query('SELECT project, fields FROM work_state_entries').all()).toEqual([{ project: 'beta', fields: 'keep state' }]);
      expect(db.query('SELECT project, token FROM token_df').all()).toEqual([{ project: 'beta', token: 'keep-token' }]);
      expect(db.query('PRAGMA secure_delete').get()).toEqual({ secure_delete: 1 });
      expect(db.query("SELECT name FROM sqlite_master WHERE name='sdk_sessions'").get()).toBeNull();
    } finally { db.close(); }
  });

  it('deletes raw tools, session context gates, project auxiliaries and deliverable metadata without affecting another project', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`PRAGMA foreign_keys=ON;
        CREATE TABLE sdk_sessions(id INTEGER PRIMARY KEY, project TEXT, content_session_id TEXT, memory_session_id TEXT, platform_source TEXT);
        CREATE TABLE observations(id INTEGER PRIMARY KEY, project TEXT, memory_session_id TEXT REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE);
        CREATE UNIQUE INDEX sessions_memory ON sdk_sessions(memory_session_id);
        CREATE TABLE user_prompts(id INTEGER PRIMARY KEY, session_db_id INTEGER REFERENCES sdk_sessions(id) ON DELETE CASCADE, content_session_id TEXT, prompt_text TEXT);
        CREATE TABLE tool_uses(id INTEGER PRIMARY KEY, project TEXT, session_db_id INTEGER, content_session_id TEXT, tool_use_id TEXT, tool_input TEXT, tool_response TEXT);
        CREATE TABLE advisor_calls(id INTEGER PRIMARY KEY, project TEXT, session_db_id INTEGER, advice TEXT);
        CREATE TABLE file_context_injections(session_id TEXT, file_path TEXT);
        CREATE TABLE deliverables(project TEXT, bucket_path TEXT, source_path TEXT);
        CREATE TABLE dedup_meta(project TEXT, doc_count INTEGER);
        CREATE TABLE telegram_wrapups(project TEXT, content_session_id TEXT);
        INSERT INTO sdk_sessions VALUES(1,'alpha','a-content','a-memory','claude'),(2,'beta','b-content','b-memory','claude');
        INSERT INTO observations VALUES(11,'alpha','a-memory'),(12,'beta','b-memory');
        INSERT INTO user_prompts VALUES(21,1,'a-content','private prompt'),(22,2,'b-content','keep prompt');
        INSERT INTO tool_uses VALUES(31,'alpha',1,'a-content','a-tool','private input','private output'),(32,'beta',2,'b-content','b-tool','keep input','keep output');
        INSERT INTO advisor_calls VALUES(41,'alpha',1,'private advice'),(42,'beta',2,'keep advice');
        INSERT INTO file_context_injections VALUES('a-content','private.ts'),('b-content','keep.ts');
        INSERT INTO deliverables VALUES('alpha','/bucket/a','/source/a'),('beta','/bucket/b','/source/b');
        INSERT INTO dedup_meta VALUES('alpha',1),('beta',1);
        INSERT INTO telegram_wrapups VALUES('alpha','a-content'),('beta','b-content')`);
      const result = purgeProjectDatabase(db, ['ALPHA']);
      expect(result.observationIds).toEqual([11]);
      expect(result.promptIds).toEqual([21]);
      expect(result.deliverables).toMatchObject([{ project: 'alpha', bucket_path: '/bucket/a', source_path: '/source/a' }]);
      expect(result.retainedDeliverablePaths).toEqual(['/bucket/b']);
      for (const table of ['sdk_sessions', 'observations', 'tool_uses', 'advisor_calls', 'deliverables', 'dedup_meta', 'telegram_wrapups']) {
        expect(db.query(`SELECT project FROM ${table}`).all()).toEqual([{ project: 'beta' }]);
      }
      expect(db.query('SELECT prompt_text FROM user_prompts').all()).toEqual([{ prompt_text: 'keep prompt' }]);
      expect(db.query('SELECT file_path FROM file_context_injections').all()).toEqual([{ file_path: 'keep.ts' }]);
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('rejects sessions with records belonging to an unselected project and changes nothing', () => {
    for (const child of ['observations', 'session_summaries', 'tool_uses']) {
      const db = new Database(':memory:');
      try {
        db.exec(`CREATE TABLE sdk_sessions(id INTEGER PRIMARY KEY, project TEXT, content_session_id TEXT, memory_session_id TEXT);
          CREATE TABLE ${child}(id INTEGER PRIMARY KEY, project TEXT, session_db_id INTEGER, memory_session_id TEXT);
          INSERT INTO sdk_sessions VALUES(1,'alpha','a-content','a-memory');
          INSERT INTO ${child} VALUES(1,'beta',1,'a-memory')`);
        expect(() => purgeProjectDatabase(db, ['alpha'])).toThrow('select all related projects together');
        expect(db.query('SELECT COUNT(*) AS n FROM sdk_sessions').get()).toEqual({ n: 1 });
        expect(db.query(`SELECT COUNT(*) AS n FROM ${child}`).get()).toEqual({ n: 1 });
        purgeProjectDatabase(db, ['alpha', 'beta']);
        expect(db.query(`SELECT COUNT(*) AS n FROM ${child}`).get()).toEqual({ n: 0 });
      } finally { db.close(); }
    }
  });

  it('purges synchronization payloads and associated ledgers while preserving other projects and the global cursor', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE observations(id INTEGER PRIMARY KEY, project TEXT, synced_at INTEGER);
        CREATE TABLE sync_content_outbox(entity_id TEXT, kind TEXT, origin_local_id TEXT, body TEXT);
        CREATE TABLE sync_entity_heads(entity_id TEXT PRIMARY KEY, kind TEXT, origin_local_id TEXT, origin_device_id TEXT);
        CREATE TABLE sync_dead_letter(lane TEXT, queue_key TEXT, raw_body TEXT);
        CREATE TABLE sync_pull_quarantine(entity_id TEXT, raw_body TEXT);
        CREATE TABLE sync_recovery_jobs(id TEXT, scope_json TEXT);
        CREATE TABLE sync_recovery_items(job_id TEXT, entity_id TEXT);
        CREATE TABLE sync_recovery_receipts(job_id TEXT, entity_id TEXT);
        CREATE TABLE sync_conflict_body_versions(entity_id TEXT PRIMARY KEY, version INTEGER);
        CREATE TABLE sync_conflict_repairs(entity_id TEXT, evidence TEXT);
        CREATE TABLE sync_repair_reservations(entity_id TEXT);
        CREATE TABLE sync_launch_exclusions(kind TEXT, origin_local_id TEXT);
        CREATE TABLE sync_state(k TEXT, v TEXT);
        INSERT INTO observations VALUES(1,'alpha',-1),(2,'beta',NULL);
        INSERT INTO sync_content_outbox VALUES('a-entity','observation','1','{"id":"a-entity","payload":{"project":"alpha"}}'),('b-entity','observation','2','{"id":"b-entity","payload":{"project":"beta"}}');
        INSERT INTO sync_entity_heads VALUES('a-entity','observation','1','device-a'),('b-entity','observation','2','device-a');
        INSERT INTO sync_dead_letter VALUES('content','a-entity','{"error":"private failed payload"}'),('content','b-entity','{"error":"keep failed payload"}');
        INSERT INTO sync_pull_quarantine VALUES('a-entity','{"error":"private pulled payload"}'),('b-entity','{"error":"keep pulled payload"}');
        INSERT INTO sync_recovery_jobs VALUES('a-job','{"project":"alpha"}'),('b-job','{"project":"beta"}');
        INSERT INTO sync_recovery_items VALUES('a-job','a-entity'),('b-job','b-entity');
        INSERT INTO sync_recovery_receipts VALUES('a-job','a-entity'),('b-job','b-entity');
        INSERT INTO sync_conflict_body_versions VALUES('a-entity',1),('b-entity',1);
        CREATE TRIGGER version_delete AFTER DELETE ON sync_content_outbox BEGIN
          INSERT INTO sync_conflict_body_versions VALUES(OLD.entity_id,1) ON CONFLICT(entity_id) DO UPDATE SET version=version+1; END;
        INSERT INTO sync_conflict_repairs VALUES('a-entity','{"error":"private evidence"}'),('b-entity','{"error":"keep evidence"}');
        INSERT INTO sync_repair_reservations VALUES('a-entity'),('b-entity');
        INSERT INTO sync_launch_exclusions VALUES('observation','1'),('observation','2');
        INSERT INTO sync_state VALUES('cursor','100')`);
      const before = inspectProjectDatabase(db, ['alpha']);
      expect(before.cloudEvidence).not.toContain('observations: synchronized records');
      expect(before.cloudEvidence).toContain('sync_content_outbox: synchronization history');
      purgeProjectDatabase(db, ['alpha']);
      for (const table of ['sync_content_outbox', 'sync_entity_heads', 'sync_pull_quarantine', 'sync_recovery_items', 'sync_recovery_receipts', 'sync_conflict_body_versions', 'sync_conflict_repairs', 'sync_repair_reservations']) {
        expect(db.query(`SELECT entity_id FROM ${table}`).all()).toEqual([{ entity_id: 'b-entity' }]);
      }
      expect(db.query('SELECT raw_body FROM sync_dead_letter').all()).toEqual([{ raw_body: '{"error":"keep failed payload"}' }]);
      expect(db.query('SELECT id FROM sync_recovery_jobs').all()).toEqual([{ id: 'b-job' }]);
      expect(db.query('SELECT origin_local_id FROM sync_launch_exclusions').all()).toEqual([{ origin_local_id: '2' }]);
      expect(db.query('SELECT * FROM sync_state').all()).toEqual([{ k: 'cursor', v: '100' }]);
    } finally { db.close(); }
  });

  it('discovers synchronization-only leftovers after the original sessions were removed', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE sync_content_outbox(entity_id TEXT, body TEXT);
        INSERT INTO sync_content_outbox VALUES('orphan','{"payload":{"project":"old-project"}}')`);
      expect(listProjectDatabaseInventory(db)).toMatchObject([{ project: 'old-project', sessionCount: 0 }]);
      purgeProjectDatabase(db, ['old-project']);
      expect(db.query('SELECT * FROM sync_content_outbox').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('finds and clears orphaned repair evidence with nested canonical operation bodies', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE sync_conflict_repairs(entity_id TEXT,evidence TEXT)');
      db.query('INSERT INTO sync_conflict_repairs VALUES(?,?)').run('repair-only', JSON.stringify({ op: { body: JSON.stringify({ id: 'repair-only', kind: 'observation', payload: { project: 'alpha', narrative: 'private repair evidence' } }) } }));
      expect(listProjectDatabaseInventory(db)).toMatchObject([{ project: 'alpha' }]);
      expect(inspectProjectDatabase(db, ['alpha']).cloudEvidence).toContain('sync_conflict_repairs: synchronization history');
      purgeProjectDatabase(db, ['alpha']);
      expect(db.query('SELECT * FROM sync_conflict_repairs').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('rejects malformed or non-object stored payloads before deleting any project records', () => {
    for (const body of ['opaque malformed body', '42', '["unknown scope"]', 7]) {
      const db = new Database(':memory:');
      try {
        db.exec("CREATE TABLE work_state_entries(project TEXT,fields TEXT); INSERT INTO work_state_entries VALUES('alpha','private state'); CREATE TABLE sync_content_outbox(body)");
        db.query('INSERT INTO sync_content_outbox VALUES(?)').run(body);
        expect(() => listProjectDatabaseInventory(db)).toThrow();
        expect(() => purgeProjectDatabase(db, ['alpha'])).toThrow();
        expect(db.query('SELECT fields FROM work_state_entries').all()).toEqual([{ fields: 'private state' }]);
        expect(db.query('SELECT body FROM sync_content_outbox').get()).toEqual({ body });
      } finally { db.close(); }
    }
  });

  it('reports an opaque malformed ledger without entering project confirmation or claiming deletion', async () => {
    const store = new SessionStore(':memory:');
    try {
      seedProject(store, 'alpha', 'opaque-ledger');
      store.db.exec("INSERT INTO sync_content_outbox(entity_id,kind,origin_local_id,entity_rev,body,operation_sha256,created_at_epoch) VALUES('opaque','observation','1','1','opaque malformed body','hash',1)");
      const interaction = new FakeInteraction();
      interaction.selectedProjects = ['alpha'];
      expect(await runDeleteProjectCommand([], { store, interaction })).toBe(1);
      expect(interaction.confirmedSummary).toBeNull();
      expect(interaction.events.some(event => event.startsWith('success:'))).toBe(false);
      expect(store.db.query("SELECT COUNT(*) AS count FROM sdk_sessions WHERE project='alpha'").get()).toEqual({ count: 1 });
    } finally { store.close(); }
  });

  it('removes private media and retains attachments referenced by another project', () => {
    const store = new SessionStore(':memory:');
    try {
      seedProject(store, 'alpha', 'media-alpha');
      seedProject(store, 'beta', 'media-beta');
      const aSession = store.db.query("SELECT id FROM sdk_sessions WHERE project='alpha'").get() as { id: number };
      const bSession = store.db.query("SELECT id FROM sdk_sessions WHERE project='beta'").get() as { id: number };
      const aObservation = store.db.query("SELECT id FROM observations WHERE project='alpha'").get() as { id: number };
      const bObservation = store.db.query("SELECT id FROM observations WHERE project='beta'").get() as { id: number };
      store.db.query("INSERT INTO media_events(event_key,session_db_id,platform,event_identity,created_at) VALUES('a-event',?,'claude','a-source',1),('b-event',?,'claude','b-source',1)").run(aSession.id, bSession.id);
      for (const id of ['private', 'shared-event', 'shared-observation']) store.db.query("INSERT INTO media_attachments(id,replay_key,provenance,recipe,state,created_at) VALUES(?,?, '{}','photo-v1','ready',1)").run(id, `replay-${id}`);
      store.db.exec("INSERT INTO media_event_refs VALUES('a-event','private','private'),('a-event','shared-event','shared'),('b-event','shared-event','shared')");
      store.db.query("INSERT INTO observation_media_links(observation_id,attachment_id,event_key,label) VALUES(?,'shared-observation','a-event','shared'),(?,'shared-observation','b-event','shared')").run(aObservation.id, bObservation.id);
      const result = purgeProjectDatabase(store.db, ['alpha']);
      expect(result.attachmentIds).toEqual(['private']);
      expect(result.mediaDirectories).toEqual(['private']);
      expect(store.db.query('SELECT id FROM media_attachments ORDER BY id').all()).toEqual([{ id: 'shared-event' }, { id: 'shared-observation' }]);
      expect(store.db.query('SELECT event_key FROM media_events').all()).toEqual([{ event_key: 'b-event' }]);
      expect(store.db.query('SELECT event_key FROM media_event_refs').all()).toEqual([{ event_key: 'b-event' }]);
      expect(store.db.query('SELECT observation_id FROM observation_media_links').all()).toEqual([{ observation_id: bObservation.id }]);
      expect(store.db.query('SELECT * FROM media_cleanup_jobs').all()).toEqual([]);
      expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { store.close(); }
  });

  it('scrubs canonical shared history and pending materialization without invalidating another project in the same batch', () => {
    const store = new SessionStore(':memory:');
    try {
      const a = JSON.stringify(['conversation', 'claude', 'a']);
      const b = JSON.stringify(['conversation', 'claude', 'b']);
      const group = 'g_123456789abc';
      const provenance = (project: string, content: string) => ({ session: { project, platform_source: 'claude', content_session_id: content, user_prompt: `${project} opening` }, attributions: [], products: [], launches: [], activity: [] });
      publishSharedRecords(store.db, { deviceId: 'local-writer', project: '__my_work__', updates: [
        { kind: 'provenance', key: a, value: provenance('alpha', 'a') },
        { kind: 'provenance', key: b, value: provenance('beta', 'b') },
        { kind: 'group', key: group, value: { group: { title: 'alpha private aggregate', anchor: a, projectRoot: 'alpha' }, members: [a, b], suggestions: {} } },
        { kind: 'progress', key: group, value: { groupId: group, state: 'in-progress', percent: 50, summary: 'alpha private summary' } },
        { kind: 'story', key: 'current', value: { narrative: 'alpha private story', preferences: [] } },
      ] });
      publishSharedRecords(store.db, { deviceId: 'local-writer', project: '__my_work__', updates: [{ kind: 'provenance', key: a, value: { ...provenance('alpha', 'a'), session: { ...provenance('alpha', 'a').session, user_prompt: 'alpha private revised opening' } } }] });
      store.db.exec('CREATE TABLE my_work_file_state(name TEXT PRIMARY KEY, pending_json TEXT)');
      store.db.query('INSERT INTO my_work_file_state VALUES(?,?),(?,?)').run('request-groups.json', JSON.stringify({ groups: { [group]: { projectRoot: 'alpha', title: 'alpha pending private' } } }), 'unrelated.json', JSON.stringify({ project: 'beta', text: 'beta pending value' }));
      expect(listProjectDatabaseInventory(store.db).some(row => row.project === 'alpha')).toBe(true);
      const result = purgeProjectDatabase(store.db, ['ALPHA']);
      expect(result.recordCount).toBeGreaterThan(0);
      const shared = readSharedRecords(store.db, { deviceId: 'local-writer' });
      expect(shared.diagnostics.invalid).toBe(0);
      expect(shared.diagnostics.pending).toBe(0);
      const records = [...shared.records.values()];
      expect(records.some(record => record.kind === 'provenance' && record.key === a)).toBe(false);
      expect(records.find(record => record.kind === 'provenance' && record.key === b)?.value.session.project).toBe('beta');
      expect(records.find(record => record.kind === 'group')?.value.members).toEqual([b]);
      expect(records.some(record => record.kind === 'progress' || record.kind === 'story')).toBe(false);
      expect(store.db.query('SELECT fields FROM work_state_entries').all().some((row: any) => row.fields.includes('alpha private'))).toBe(false);
      expect(store.db.query('SELECT name FROM my_work_file_state').all()).toEqual([{ name: 'unrelated.json' }]);
      expect(listProjectDatabaseInventory(store.db).some(row => row.project === 'alpha')).toBe(false);
    } finally { store.close(); }
  });

  it('clears pending shared data even when its original canonical table is absent', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE my_work_file_state(name TEXT PRIMARY KEY,pending_json TEXT);
        INSERT INTO my_work_file_state VALUES('request-groups.json','{"groups":{"g_123456789abc":{"projectRoot":"alpha","title":"private"}}}')`);
      expect(listProjectDatabaseInventory(db)).toMatchObject([{ project: 'alpha' }]);
      expect(purgeProjectDatabase(db, ['alpha']).recordCount).toBe(1);
      expect(db.query('SELECT * FROM my_work_file_state').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('rebuilds FTS segments so deleted source text is absent after compaction and retained records remain searchable', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`PRAGMA secure_delete=ON;
        CREATE TABLE observations(id INTEGER PRIMARY KEY,project TEXT,title TEXT);
        CREATE VIRTUAL TABLE observations_fts USING fts5(title,content=observations,content_rowid=id);
        INSERT INTO observations VALUES(1,'alpha','uniquesecretdeletedalpha'),(2,'beta','retainedbetaterm');
        INSERT INTO observations_fts(rowid,title) SELECT id,title FROM observations;
        CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts,rowid,title) VALUES('delete',old.id,old.title); END;`);
      purgeProjectDatabase(db, ['alpha']);
      db.exec('VACUUM');
      expect(db.query("SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'uniquesecretdeletedalpha'").all()).toEqual([]);
      expect(db.query("SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'retainedbetaterm'").all()).toEqual([{ rowid: 2 }]);
      expect(db.serialize().includes(Buffer.from('uniquesecretdeletedalpha'))).toBe(false);
    } finally { db.close(); }
  });
});

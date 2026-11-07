import type { Database } from 'bun:sqlite';
import { canonicalJson, stableDocumentId } from '../sync/CanonicalContent.js';
import { createSharedBatch, createSharedEntry, parseSharedRow, type SharedEntryFields } from '../work-view/shared-records.mjs';

type Row = Record<string, any>;
type Schema = Map<string, Set<string>>;

export interface ProjectDatabaseInventory {
  project: string;
  sessionCount: number;
  observationCount: number;
  summaryCount: number;
  promptCount: number;
  toolUseCount: number;
  workStateCount: number;
  deliverableCount: number;
  rowCounts: Record<string, number>;
}

export interface ProjectDatabaseSelection {
  projects: string[];
  inventory: ProjectDatabaseInventory[];
  sessions: Array<{ id: number; project: string; content_session_id: string; memory_session_id: string | null; platform_source: string; cwd?: string }>;
  observationIds: number[];
  summaryIds: number[];
  promptIds: number[];
  workStateIds: number[];
  attachmentIds: string[];
  retainedAttachmentIds: string[];
  mediaDirectories: string[];
  deliverables: Array<{ project: string; bucket_path: string; source_path: string; content_session_id: string; platform_source: string }>;
  retainedDeliverablePaths: string[];
  entityIds: string[];
  cloudEvidence: string[];
  recordCount: number;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const fold = (value: string): string => value.replace(/[A-Z]/g, char => char.toLowerCase());
const CONTENT_TABLES = { observation: 'observations', summary: 'session_summaries', prompt: 'user_prompts', work_state: 'work_state_entries' } as const;
const METADATA_COLUMNS = new Set(['id', 'project', 'content_session_id', 'memory_session_id', 'session_db_id', 'platform_source', 'cwd', 'origin_device_id', 'origin_local_id', 'sync_rev', 'synced_at', 'agent_id', 'tool_use_id', 'bucket_path', 'source_path', 'event_key', 'attachment_id', 'directory', 'observation_id', 'duplicate_of_id', 'row_id', 'origin', 'upload_state', 'upload_attempts', 'kind', 'entity_id', 'queue_key', 'lane', 'job_id', 'k', 'key', 'session_id', 'list_name']);
const BODY_COLUMNS: Record<string, string[]> = { sync_content_outbox: ['body'], sync_outbox: ['body', 'canonical_body'], sync_dead_letter: ['raw_body'], sync_pull_quarantine: ['raw_body'], sync_recovery_jobs: ['scope_json'], sync_conflict_repairs: ['evidence'] };

function schema(db: Database): Schema {
  return new Map((db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(({ name }) => [
    name, new Set((db.query(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string }>).map(column => column.name)),
  ]));
}

function json(value: unknown): Row | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error('Project cleanup found a non-text JSON payload; no complete erasure can be verified.');
  const parsed = JSON.parse(value);
  if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('Project cleanup expected a JSON object payload; no complete erasure can be verified.');
  return parsed;
}

function bodyProjects(body: Row | null): string[] {
  if (!body) return [];
  const mutation = body.mutation ?? body;
  const projects = [body.project, body.payload?.project, mutation.where?.project, mutation.fields?.project, mutation.fields?.merged_into_project]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const wrapper of [body, body.native, body.op, body.hub?.op]) {
    if (wrapper?.body != null) projects.push(...bodyProjects(json(wrapper.body)));
  }
  if (body.kind === 'work_state' && typeof body.payload?.list_name === 'string' && body.payload.list_name.startsWith('__my_work_v1:')) {
    const fields = json(body.payload.fields);
    if (fields?.record === 'entry') projects.push(...projectedProjects(JSON.parse(fields.payload)));
  }
  return projects;
}

function projectedProjects(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(projectedProjects);
  return Object.entries(value).flatMap(([key, child]) => {
    if ((key === 'project' || key === 'projectRoot') && typeof child === 'string') return [child];
    if (key === 'projects' && Array.isArray(child)) return child.filter((project): project is string => typeof project === 'string');
    return projectedProjects(child);
  });
}

export function listProjectDatabaseInventory(db: Database): ProjectDatabaseInventory[] {
  const tables = schema(db);
  const inventory = new Map<string, ProjectDatabaseInventory>();
  const item = (project: string) => {
    const key = fold(project);
    if (!inventory.has(key)) inventory.set(key, { project, sessionCount: 0, observationCount: 0, summaryCount: 0, promptCount: 0, toolUseCount: 0, workStateCount: 0, deliverableCount: 0, rowCounts: {} });
    return inventory.get(key)!;
  };
  const countFields: Record<string, keyof ProjectDatabaseInventory> = { sdk_sessions: 'sessionCount', observations: 'observationCount', session_summaries: 'summaryCount', tool_uses: 'toolUseCount', work_state_entries: 'workStateCount', deliverables: 'deliverableCount' };
  for (const [table, columns] of tables) {
    if (!columns.has('project')) continue;
    for (const row of db.query(`SELECT project, COUNT(*) AS count FROM ${quote(table)} WHERE project IS NOT NULL AND project != '' GROUP BY project COLLATE NOCASE`).all() as Array<{ project: string; count: number }>) {
      const entry = item(row.project);
      entry.rowCounts[table] = row.count;
      const field = countFields[table];
      if (field) (entry as any)[field] = row.count;
    }
  }
  if (tables.get('user_prompts')?.has('session_db_id') && tables.get('sdk_sessions')?.has('project')) {
    for (const row of db.query('SELECT s.project, COUNT(*) AS count FROM user_prompts p JOIN sdk_sessions s ON p.session_db_id=s.id GROUP BY s.project COLLATE NOCASE').all() as Array<{ project: string; count: number }>) {
      const entry = item(row.project); entry.promptCount = row.count; entry.rowCounts.user_prompts = row.count;
    }
  }
  for (const [table, column] of [['sync_content_outbox', 'body'], ['sync_outbox', 'body'], ['sync_dead_letter', 'raw_body'], ['sync_pull_quarantine', 'raw_body'], ['sync_recovery_jobs', 'scope_json'], ['sync_conflict_repairs', 'evidence']] as const) {
    if (!tables.get(table)?.has(column)) continue;
    for (const row of db.query(`SELECT ${quote(column)} AS body FROM ${quote(table)}`).iterate() as Iterable<Row>) {
      for (const project of bodyProjects(json(row.body))) item(project);
    }
  }
  if (tables.get('work_state_entries')?.has('list_name') && tables.get('work_state_entries')?.has('fields')) {
    for (const row of db.query("SELECT fields FROM work_state_entries WHERE list_name GLOB '__my_work_v1:*'").iterate() as Iterable<Row>) {
      const fields = json(row.fields);
      if (fields?.record === 'entry') for (const project of projectedProjects(JSON.parse(fields.payload))) item(project);
    }
  }
  if (tables.get('my_work_file_state')?.has('pending_json')) for (const row of db.query('SELECT pending_json FROM my_work_file_state WHERE pending_json IS NOT NULL').iterate() as Iterable<Row>) {
    for (const project of projectedProjects(json(row.pending_json))) item(project);
  }
  return [...inventory.values()].sort((a, b) => a.project.localeCompare(b.project));
}

function planDeletion(db: Database, projects: string[]) {
  const tables = schema(db);
  const selected = new Set(projects.map(fold));
  const matchesProject = (value: unknown) => typeof value === 'string' && selected.has(fold(value));
  const deletions = new Map<string, Set<number>>();
  const sharedUpdates = new Map<number, string>();
  const projection = (table: string) => [...tables.get(table)!].filter(column => METADATA_COLUMNS.has(column) || BODY_COLUMNS[table]?.includes(column)).map(quote).join(', ');
  const iterateRows = (table: string): Iterable<Row> => tables.has(table) ? db.query(`SELECT rowid AS __rowid${projection(table) ? `, ${projection(table)}` : ''} FROM ${quote(table)}`).iterate() as Iterable<Row> : [];
  const rows = (table: string): Row[] => tables.has(table) ? db.query(`SELECT rowid AS __rowid${projection(table) ? `, ${projection(table)}` : ''} FROM ${quote(table)}`).all() as Row[] : [];
  const add = (table: string, row: Row) => {
    if (!deletions.has(table)) deletions.set(table, new Set());
    deletions.get(table)!.add(row.__rowid);
  };
  const projectRows = new Map<string, Row[]>();
  for (const [table, columns] of tables) {
    if (!columns.has('project')) continue;
    const placeholders = projects.map(() => '?').join(',');
    const found = projects.length ? db.query(`SELECT rowid AS __rowid, ${projection(table)} FROM ${quote(table)} WHERE project COLLATE NOCASE IN (${placeholders})`).all(...projects) as Row[] : [];
    projectRows.set(table, found);
    for (const row of found) add(table, row);
  }
  const sessions = projectRows.get('sdk_sessions') ?? [];
  const sessionIds = new Set(sessions.map(row => row.id));
  const contentIds = new Set(sessions.map(row => row.content_session_id));
  const memoryIds = new Set(sessions.map(row => row.memory_session_id).filter(Boolean));
  const related = (row: Row) => sessionIds.has(row.session_db_id) || memoryIds.has(row.memory_session_id)
    || (row.session_db_id == null && contentIds.has(row.content_session_id));
  for (const table of ['observations', 'session_summaries', 'tool_uses', 'advisor_calls', 'user_prompts']) {
    const found = projectRows.get(table) ?? [];
    const seen = new Set(found.map(row => row.__rowid));
    for (const row of iterateRows(table)) {
      if (!related(row)) continue;
      if (tables.get(table)?.has('project') && row.project && !matchesProject(row.project)) {
        throw new Error(`Session records are shared with project "${row.project}"; select all related projects together.`);
      }
      add(table, row);
      if (!seen.has(row.__rowid)) found.push(row);
    }
    projectRows.set(table, found);
  }
  for (const row of rows('file_context_injections')) if (contentIds.has(row.session_id)) add('file_context_injections', row);
  const sharedConversations = new Set(sessions.map(row => JSON.stringify(['conversation', row.platform_source ?? 'claude', row.content_session_id])));
  const sharedGroupIds = new Set<string>();
  if (tables.get('work_state_entries')?.has('list_name') && tables.get('work_state_entries')?.has('fields')) {
    const shared = (db.query("SELECT rowid AS __rowid, * FROM work_state_entries WHERE list_name GLOB '__my_work_v1:*'").all() as Row[])
      .map(row => {
        const fields = json(row.fields)!;
        return { row, fields, value: fields?.record === 'entry' ? JSON.parse(fields.payload) as Row | null : null };
      });
    const conversations = sharedConversations;
    const conversationProjects = new Map<string, string>();
    for (const row of iterateRows('sdk_sessions')) conversationProjects.set(JSON.stringify(['conversation', row.platform_source ?? 'claude', row.content_session_id]), row.project);
    for (const entry of shared) if (entry.fields?.kind === 'provenance' && entry.value?.session) {
      conversationProjects.set(entry.fields.key, entry.value.session.project);
      if (matchesProject(entry.value.session.project)) conversations.add(entry.fields.key);
    }
    const groups = sharedGroupIds;
    for (const entry of shared) if (entry.fields?.kind === 'group') {
      if (matchesProject(entry.value?.group?.projectRoot)) {
        for (const key of entry.value?.members ?? []) if (!conversationProjects.has(key) || matchesProject(conversationProjects.get(key))) conversations.add(key);
      }
      if (matchesProject(entry.value?.group?.projectRoot) || entry.value?.members?.some((key: string) => conversations.has(key))) groups.add(entry.fields.key);
    }
    const requestMatches = (key: unknown): boolean => {
      if (typeof key !== 'string') return false;
      if (conversations.has(key) || groups.has(key)) return true;
      try {
        const tuple = JSON.parse(key);
        return Array.isArray(tuple) && ((tuple[0] === 'overall-request' && groups.has(tuple[1])) || (tuple[0] === 'explicit-request' && matchesProject(tuple[1])));
      } catch { return false; }
    };
    const changedBatches = new Set<string>();
    const replacements = new Map<number, SharedEntryFields | null>();
    const batchKey = (fields: Row) => JSON.stringify([fields.writer, fields.batch]);
    for (const entry of shared) {
      const { row, fields, value } = entry;
      if (fields?.record !== 'entry' || deletions.get('work_state_entries')?.has(row.__rowid)) continue;
      const affected = projectedProjects(value).some(matchesProject) || requestMatches(fields.key)
        || (fields.kind === 'exclusion' && conversations.has(value?.conversation))
        || (fields.kind === 'progress' && groups.has(fields.key))
        || (selected.size > 0 && ['story', 'refresh'].includes(fields.kind));
      if (!affected) continue;
      parseSharedRow(row as any, fields.writer);
      let replacement: SharedEntryFields | null = null;
      if (fields.kind === 'group') {
        const members = (value?.members ?? []).filter((key: string) => !conversations.has(key));
        if (members.length) replacement = createSharedEntry({ batchId: fields.batch, writer: fields.writer, kind: fields.kind, key: fields.key, revision: fields.revision, base: fields.base,
          value: { group: { title: 'Remaining conversations', anchor: members[0], projectRoot: null }, members, suggestions: {} } });
      }
      replacements.set(row.__rowid, replacement);
      changedBatches.add(batchKey(fields));
    }
    const affectedRows: Row[] = [];
    for (const batch of changedBatches) {
      const batchRows = shared.filter(entry => entry.fields && batchKey(entry.fields) === batch);
      const entries: SharedEntryFields[] = [];
      for (const entry of batchRows.filter(entry => entry.fields.record === 'entry')) {
        const replacement = replacements.get(entry.row.__rowid);
        if (replacement === null) { add('work_state_entries', entry.row); affectedRows.push(entry.row); }
        else {
          parseSharedRow(entry.row as any, entry.fields.writer);
          entries.push(replacement ?? entry.fields as SharedEntryFields);
          if (replacement) { sharedUpdates.set(entry.row.__rowid, canonicalJson(replacement)); affectedRows.push(entry.row); }
        }
      }
      const rebuilt = entries.length ? createSharedBatch(entries, { batchId: batchRows[0].fields.batch, writer: batchRows[0].fields.writer }) : [];
      for (const replacement of rebuilt.filter(row => row.fields.record !== 'entry')) {
        if (!batchRows.some(entry => entry.fields.record === replacement.fields.record
          && (replacement.fields.record !== 'manifest' || entry.fields.part === replacement.fields.part))) {
          throw new Error('Shared My Work batch is incomplete; cannot safely retain its other project records.');
        }
      }
      for (const entry of batchRows.filter(entry => entry.fields.record !== 'entry')) {
        const replacement = rebuilt.find(row => row.fields.record === entry.fields.record && (entry.fields.record !== 'manifest' || row.fields.part === entry.fields.part));
        if (replacement) sharedUpdates.set(entry.row.__rowid, canonicalJson(replacement.fields));
        else add('work_state_entries', entry.row);
        affectedRows.push(entry.row);
      }
    }
    const found = projectRows.get('work_state_entries') ?? [];
    const seen = new Set(found.map(row => row.__rowid));
    for (const row of affectedRows) if (!seen.has(row.__rowid)) { found.push(row); seen.add(row.__rowid); }
    projectRows.set('work_state_entries', found);
  }
  if (tables.get('my_work_file_state')?.has('pending_json')) for (const row of db.query('SELECT rowid AS __rowid, name, pending_json FROM my_work_file_state WHERE pending_json IS NOT NULL').iterate() as Iterable<Row>) {
    const value = json(row.pending_json);
    if (projectedProjects(value).some(matchesProject) || Object.keys(value?.conversations ?? {}).some(key => sharedConversations.has(key))
      || (selected.size && (['story.json', 'refresh.json'].includes(row.name) || sharedGroupIds.has(row.name?.replace(/^progress\//, '').replace(/\.json$/, ''))))) add('my_work_file_state', row);
  }
  const ids = (table: string) => (projectRows.get(table) ?? []).map(row => row.id as number);
  const observationIds = new Set(ids('observations'));
  const workStateIds = new Set(ids('work_state_entries'));
  for (const row of rows('pending_messages')) if (sessionIds.has(row.session_db_id)) add('pending_messages', row);
  for (const row of rows('observation_files')) if (observationIds.has(row.observation_id)) add('observation_files', row);
  for (const row of rows('observation_dedup_candidates')) if (observationIds.has(row.observation_id) || observationIds.has(row.duplicate_of_id)) add('observation_dedup_candidates', row);
  for (const row of rows('local_shared_work_redactions')) if (workStateIds.has(row.row_id)) add('local_shared_work_redactions', row);

  const mediaEvents = rows('media_events').filter(row => sessionIds.has(row.session_db_id));
  const eventKeys = new Set(mediaEvents.map(row => row.event_key));
  const eventRefs = rows('media_event_refs');
  const observationLinks = rows('observation_media_links');
  const candidates = new Set<string>();
  for (const row of eventRefs) if (eventKeys.has(row.event_key)) { candidates.add(row.attachment_id); add('media_event_refs', row); }
  for (const row of observationLinks) if (observationIds.has(row.observation_id)) { candidates.add(row.attachment_id); add('observation_media_links', row); }
  const retainedAttachments = new Set([...eventRefs.filter(row => !eventKeys.has(row.event_key)), ...observationLinks.filter(row => !observationIds.has(row.observation_id))].map(row => row.attachment_id));
  const attachmentIds = [...candidates].filter(id => !retainedAttachments.has(id));
  const deletedAttachments = new Set(attachmentIds);
  for (const row of mediaEvents) add('media_events', row);
  for (const row of rows('media_event_results')) if (eventKeys.has(row.event_key) || observationIds.has(row.observation_id)) add('media_event_results', row);
  const attachments = rows('media_attachments').filter(row => deletedAttachments.has(row.id));
  for (const row of attachments) add('media_attachments', row);
  const mediaDirectories = new Set(attachmentIds);
  for (const row of rows('media_cleanup_jobs')) if (deletedAttachments.has(row.attachment_id)) { add('media_cleanup_jobs', row); mediaDirectories.add(row.directory); }
  for (const row of rows('media_cloud_deletions')) if (deletedAttachments.has(row.attachment_id)) add('media_cloud_deletions', row);

  const entityIds = new Set<string>();
  const cloudEvidence = new Set<string>();
  if (deletions.get('media_cloud_deletions')?.size) cloudEvidence.add('media_cloud_deletions: pending cloud media deletion');
  const nativeIds = new Map<string, Set<string>>();
  const retainedOrigins = new Set<string>();
  for (const [kind, table] of Object.entries(CONTENT_TABLES)) {
    const targetRows = projectRows.get(table) ?? [];
    nativeIds.set(kind, new Set(targetRows.filter(row => !row.origin_device_id).map(row => String(row.id))));
    const deletedIds = new Set(targetRows.map(row => row.id));
    for (const row of iterateRows(table)) {
      if (!deletedIds.has(row.id) && row.origin_device_id) retainedOrigins.add(`${kind}:${row.origin_device_id}:${row.origin_local_id}`);
    }
    for (const row of targetRows) {
      if (row.origin_device_id) {
        entityIds.add(stableDocumentId(kind as keyof typeof CONTENT_TABLES, row.origin_device_id, String(row.origin_local_id)));
        cloudEvidence.add(`${table}: replicated records`);
      }
      if (row.synced_at != null && row.synced_at >= 0) cloudEvidence.add(`${table}: synchronized records`);
    }
  }
  const matchesBody = (body: Row | null): boolean => {
    if (!body) return false;
    if (bodyProjects(body).some(matchesProject)) return true;
    if (body.id && entityIds.has(body.id)) return true;
    const mutation = body.mutation ?? body;
    return contentIds.has(mutation.target?.content_session_id) || memoryIds.has(mutation.target?.memory_session_id)
      || memoryIds.has(mutation.where?.memory_session_id)
      || (mutation.op === 'set_prompt_session' && nativeIds.get('prompt')!.has(String(mutation.target?.origin_local_id)) && mutation.target?.origin_device_id == null);
  };
  const ledgers = ['sync_content_outbox', 'sync_pull_quarantine', 'sync_dead_letter', 'sync_entity_heads', 'sync_conflict_repairs'];
  for (const table of ledgers) {
    for (const row of iterateRows(table)) {
      const body = json(row.body ?? row.raw_body ?? row.evidence);
      const nativeIdMatch = nativeIds.get(row.kind)?.has(String(row.origin_local_id))
        && !retainedOrigins.has(`${row.kind}:${row.origin_device_id}:${row.origin_local_id}`);
      if (table === 'sync_entity_heads' && nativeIdMatch) cloudEvidence.add('sync_entity_heads: possible native synchronization history');
      const nativeMatch = nativeIdMatch && (table === 'sync_content_outbox' || (table === 'sync_dead_letter' && row.lane === 'content'));
      if (!matchesBody(body) && !entityIds.has(row.entity_id ?? row.queue_key) && !nativeMatch) continue;
      if (row.entity_id) entityIds.add(row.entity_id);
      if (table === 'sync_dead_letter' && row.lane === 'content') entityIds.add(row.queue_key);
      if (body?.id && body.kind !== 'mutation') entityIds.add(body.id);
      add(table, row); cloudEvidence.add(`${table}: synchronization history`);
    }
  }
  for (const table of ledgers) for (const row of iterateRows(table)) if (entityIds.has(row.entity_id ?? row.queue_key)) add(table, row);
  for (const row of iterateRows('sync_outbox')) if (matchesBody(json(row.body)) || matchesBody(json(row.canonical_body))) { add('sync_outbox', row); cloudEvidence.add('sync_outbox: queued mutations'); }
  for (const table of ['sync_conflict_repairs', 'sync_conflict_body_versions', 'sync_repair_reservations']) for (const row of rows(table)) if (entityIds.has(row.entity_id)) add(table, row);
  for (const row of rows('sync_launch_exclusions')) if (nativeIds.get(row.kind)?.has(String(row.origin_local_id))) add('sync_launch_exclusions', row);
  const jobs = rows('sync_recovery_jobs').filter(row => bodyProjects(json(row.scope_json)).some(matchesProject));
  const jobIds = new Set(jobs.map(row => row.id));
  for (const row of jobs) add('sync_recovery_jobs', row);
  for (const table of ['sync_recovery_items', 'sync_recovery_receipts']) for (const row of rows(table)) if (jobIds.has(row.job_id) || entityIds.has(row.entity_id)) add(table, row);
  for (const row of rows('sync_state')) {
    if (sessions.some(session => (session.memory_session_id && row.k === `parked_title:mem:${session.memory_session_id}`) || row.k === `parked_title:content:${session.platform_source ?? 'claude'}:${session.content_session_id}`)) add('sync_state', row);
  }
  for (const row of attachments) if (row.origin === 'replica' || row.upload_state === 'uploaded' || row.upload_attempts > 0) cloudEvidence.add('media_attachments: cloud media');

  const deliverables = projectRows.get('deliverables') ?? [];
  const inventory = listProjectDatabaseInventory(db);
  const selection: ProjectDatabaseSelection = {
    projects: [...new Set(projects.map(project => inventory.find(entry => fold(entry.project) === fold(project))?.project ?? project))],
    inventory: inventory.filter(entry => matchesProject(entry.project)),
    sessions: sessions.map(row => ({ id: row.id, project: row.project, content_session_id: row.content_session_id, memory_session_id: row.memory_session_id ?? null, platform_source: row.platform_source ?? 'claude', ...(row.cwd ? { cwd: row.cwd } : {}) })),
    observationIds: [...observationIds], summaryIds: ids('session_summaries'), promptIds: ids('user_prompts'), workStateIds: [...workStateIds],
    attachmentIds, retainedAttachmentIds: [...retainedAttachments], mediaDirectories: [...mediaDirectories],
    deliverables: deliverables.map(row => ({ project: row.project, bucket_path: row.bucket_path ?? '', source_path: row.source_path ?? '', content_session_id: row.content_session_id ?? '', platform_source: row.platform_source ?? 'claude' })),
    retainedDeliverablePaths: rows('deliverables').filter(row => !matchesProject(row.project)).map(row => row.bucket_path).filter((path): path is string => typeof path === 'string'),
    entityIds: [...entityIds], cloudEvidence: [...cloudEvidence], recordCount: [...deletions.values()].reduce((count, ids) => count + ids.size, 0) + sharedUpdates.size,
  };
  return { selection, deletions, sharedUpdates };
}

export function inspectProjectDatabase(db: Database, projects: string[]): ProjectDatabaseSelection {
  return planDeletion(db, projects).selection;
}

export function purgeProjectDatabase(db: Database, projects: string[]): ProjectDatabaseSelection {
  db.exec('PRAGMA secure_delete=ON');
  return db.transaction(() => {
    const { selection, deletions, sharedUpdates } = planDeletion(db, projects);
    const last = ['observations', 'session_summaries', 'user_prompts', 'work_state_entries', 'sdk_sessions', 'media_events', 'media_attachments', 'media_cleanup_jobs', 'media_cloud_deletions', 'sync_content_outbox', 'sync_conflict_body_versions'];
    const ordered = [...deletions.keys()].filter(table => !last.includes(table)).concat(last.filter(table => deletions.has(table)));
    for (const table of ordered) {
      const rowIds = [...deletions.get(table)!];
      for (let offset = 0; offset < rowIds.length; offset += 500) {
        const chunk = rowIds.slice(offset, offset + 500);
        db.query(`DELETE FROM ${quote(table)} WHERE rowid IN (${chunk.map(() => '?').join(',')})`).run(...chunk);
      }
    }
    // Media deletion triggers may have queued cleanup while deleting parents.
    for (const table of ['media_cleanup_jobs', 'media_cloud_deletions']) if (schema(db).has(table)) {
      for (const id of selection.attachmentIds) db.query(`DELETE FROM ${quote(table)} WHERE attachment_id=?`).run(id);
    }
    if (schema(db).has('sync_conflict_body_versions')) {
      for (const id of selection.entityIds) db.query('DELETE FROM sync_conflict_body_versions WHERE entity_id=?').run(id);
    }
    for (const [rowId, fields] of sharedUpdates) db.query('UPDATE work_state_entries SET fields=? WHERE rowid=?').run(fields, rowId);
    if (selection.recordCount) {
      const fts = db.query("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%USING fts5%' AND name IN ('observations_fts','session_summaries_fts','user_prompts_fts')").all() as Array<{ name: string }>;
      for (const { name } of fts) {
        db.exec(`INSERT INTO ${quote(name)}(${quote(name)}) VALUES('rebuild')`);
        db.exec(`INSERT INTO ${quote(name)}(${quote(name)}) VALUES('optimize')`);
      }
    }
    return selection;
  }).immediate();
}

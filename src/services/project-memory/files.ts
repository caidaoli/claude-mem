import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseJsonWithBom, writeJsonFileAtomic, writeTextFileAtomic } from '../../shared/atomic-json.js';
import { resolveDeliverableBucketDir } from '../../shared/deliverables.js';
import { CorpusRenderer } from '../worker/knowledge/CorpusRenderer.js';
import type { CorpusFile } from '../worker/knowledge/types.js';

export interface ProjectMemoryFileScope {
  dataDir: string;
  projects: readonly string[];
  sessions: ReadonlyArray<{ content_session_id: string; platform_source: string; cwd?: string; transcript_path?: string }>;
  deliverables: ReadonlyArray<{ bucket_path: string }>;
  retainedDeliverablePaths: readonly string[];
  mediaDirectories?: readonly string[];
  attachmentIds?: readonly string[];
  promptIds?: readonly number[];
  observationIds?: readonly number[];
}

export interface ProjectMemoryFileInventory {
  dataDir: string;
  operations: Array<{ path: string; action: 'remove' | 'write'; value?: unknown; directory?: boolean }>;
  removedRequestIds: string[];
  reviewDatabases: string[];
  preservedWatchCheckpoints: string[];
  unattributedPaths: string[];
}

function safeStat(root: string, file: string) {
  const rel = relative(root, resolve(file));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Project cleanup path escapes the data directory: ${file}`);
  }
  let current = root;
  for (const part of ['', ...rel.split(sep)]) {
    if (part) current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Project cleanup refuses a symbolic link: ${current}`);
      if (current === resolve(file)) return stat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}

function filesBelow(root: string, directory: string): string[] {
  if (!safeStat(root, directory)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(directory)) {
    const file = join(directory, entry);
    const stat = safeStat(root, file)!;
    if (stat.isDirectory()) result.push(...filesBelow(root, file));
    else if (stat.isFile()) result.push(file);
  }
  return result;
}

function jsonObject(file: string): Record<string, any> {
  const value = parseJsonWithBom<unknown>(readFileSync(file, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Project cleanup expected a JSON object: ${file}`);
  }
  return value as Record<string, any>;
}

const projectKey = (project: string): string => project.replace(/[A-Z]/g, letter => letter.toLowerCase());
const jsonFile = (file: string): boolean => /\.json(?:[.-].*)?$/.test(file);

function workViewDirectories(root: string): string[] {
  if (!lstatSync(root).isDirectory()) throw new Error(`Not a data directory: ${root}`);
  const parents = [root];
  const backups = join(root, 'backups');
  if (safeStat(root, backups)?.isDirectory()) parents.push(backups);
  return parents.flatMap(parent => readdirSync(parent).filter(name => /^work-view(?:$|[-.])/.test(name))
    .map(name => join(parent, name)).filter(file => safeStat(root, file)?.isDirectory()));
}

/** Only explicit stored project keys are candidates; a sanitized bucket name cannot identify its original project. */
export function listFileProjects(dataDir: string): string[] {
  const root = resolve(dataDir);
  const projects = new Set<string>();
  const add = (value: unknown) => { if (typeof value === 'string' && value) projects.add(projectKey(value)); };
  const chromaState = join(root, 'chroma-sync-state.json');
  if (safeStat(root, chromaState)) Object.keys(jsonObject(chromaState)).forEach(add);
  for (const file of filesBelow(root, join(root, 'state', 'context-cache'))) {
    if (!jsonFile(file)) continue;
    const value = jsonObject(file);
    if (Array.isArray(value.keys?.projects)) value.keys.projects.forEach(add);
    if (Array.isArray(value.variants)) value.variants.forEach((variant: any) => variant.keys?.projects?.forEach(add));
  }
  for (const file of filesBelow(root, join(root, 'corpora'))) {
    if (!/\.corpus\.json(?:[.-].*)?$/.test(file)) continue;
    const value = jsonObject(file);
    add(value.filter?.project);
    if (Array.isArray(value.observations)) value.observations.forEach((item: any) => add(item.project));
  }
  for (const directory of workViewDirectories(root)) for (const file of filesBelow(root, directory)) {
    if (!/request-groups.*\.json(?:[.-].*)?$/.test(basename(file))) continue;
    const value = jsonObject(file);
    for (const group of Object.values(value.groups ?? {}) as any[]) add(group.projectRoot);
  }
  for (const directory of [join(root, 'state', 'hook-spool'), join(root, 'state', 'session-end-replay')]) {
    for (const file of filesBelow(root, directory)) {
      if (!jsonFile(file)) continue;
      let value: Record<string, any>;
      try { value = jsonObject(file); }
      catch { continue; } // Corrupt spool entries have no reliable project attribution.
      add(value.payload?.project);
    }
  }
  return [...projects].sort();
}

export function inventoryProjectMemoryFiles(scope: ProjectMemoryFileScope): ProjectMemoryFileInventory {
  const root = resolve(scope.dataDir);
  const projects = new Set(scope.projects.map(projectKey));
  const hasProject = (value: unknown): boolean => typeof value === 'string' && projects.has(projectKey(value));
  const sessionKeys = new Set(scope.sessions.map(session => JSON.stringify(['conversation', session.platform_source, session.content_session_id])));
  const requestIds = new Set<string>(sessionKeys);
  for (const key of sessionKeys) requestIds.add(`g_${createHash('sha256').update(key).digest('hex').slice(0, 12)}`);
  const inventory: ProjectMemoryFileInventory = { dataDir: root, operations: [], removedRequestIds: [], reviewDatabases: [], preservedWatchCheckpoints: [], unattributedPaths: [] };
  const planned = new Map<string, ProjectMemoryFileInventory['operations'][number]>();
  const remove = (file: string) => {
    const stat = safeStat(root, file);
    if (stat) planned.set(file, { path: file, action: 'remove', directory: stat.isDirectory() });
  };
  const write = (file: string, value: unknown) => {
    safeStat(root, file);
    planned.set(file, { path: file, action: 'write', value });
  };
  const removeTree = (directory: string) => {
    if (!safeStat(root, directory)) return;
    for (const name of readdirSync(directory)) {
      const file = join(directory, name);
      if (safeStat(root, file)!.isDirectory()) removeTree(file); else remove(file);
    }
    remove(directory);
  };

  const deliverablesRoot = join(root, 'deliverables');
  const retained = new Set(scope.retainedDeliverablePaths.map(file => resolve(file)));
  const removeDeliverable = (bucketPath: string) => {
    const file = resolve(bucketPath);
    const rel = relative(deliverablesRoot, file);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Deliverable is outside the deliverables directory: ${file}`);
    }
    if (!retained.has(file)) remove(file);
  };
  for (const deliverable of scope.deliverables) removeDeliverable(deliverable.bucket_path);

  for (const directory of new Set([...(scope.mediaDirectories ?? []), ...(scope.attachmentIds ?? [])])) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(directory)) {
      throw new Error(`Invalid project media directory: ${directory}`);
    }
    removeTree(join(root, 'media-v1', directory));
    const temporary = join(root, 'media-v1', '.tmp');
    if (safeStat(root, temporary)) for (const name of readdirSync(temporary)) {
      if (name.startsWith(`${directory}-`)) removeTree(join(temporary, name));
    }
  }

  for (const file of filesBelow(root, join(root, 'state', 'context-cache'))) {
    if (!jsonFile(file)) continue;
    const value = jsonObject(file);
    if (Array.isArray(value.keys?.projects) && value.keys.projects.some(hasProject)) remove(file);
    if (/^\.?variants\.json(?:[.-].*)?$/.test(basename(file)) && Array.isArray(value.variants)) {
      const variants = value.variants.filter((variant: any) => !variant.keys?.projects?.some(hasProject));
      if (variants.length !== value.variants.length) write(file, { ...value, variants });
    }
  }
  for (const file of filesBelow(root, join(root, 'corpora'))) {
    if (!/\.corpus\.json(?:[.-].*)?$/.test(file)) continue;
    const corpus = jsonObject(file) as CorpusFile;
    if (!Array.isArray(corpus.observations)) throw new Error(`Invalid corpus observations: ${file}`);
    const observations = corpus.observations.filter(item => !hasProject(item.project));
    if (!hasProject(corpus.filter?.project) && observations.length === corpus.observations.length) continue;
    if (!observations.length) { remove(file); continue; }
    corpus.observations = observations;
    if (hasProject(corpus.filter.project)) delete corpus.filter.project;
    corpus.session_id = null;
    corpus.updated_at = new Date().toISOString();
    let earliest = observations[0].created_at_epoch;
    let latest = earliest;
    const typeBreakdown: Record<string, number> = {};
    for (const observation of observations) {
      typeBreakdown[observation.type] = (typeBreakdown[observation.type] ?? 0) + 1;
      earliest = Math.min(earliest, observation.created_at_epoch);
      latest = Math.max(latest, observation.created_at_epoch);
    }
    corpus.stats = { observation_count: observations.length, token_estimate: 0,
      date_range: { earliest: new Date(earliest).toISOString(), latest: new Date(latest).toISOString() },
      type_breakdown: typeBreakdown };
    const renderer = new CorpusRenderer();
    corpus.system_prompt = renderer.generateSystemPrompt(corpus);
    corpus.stats.token_estimate = renderer.estimateTokens(renderer.renderCorpus(corpus));
    write(file, corpus);
  }
  const chromaState = join(root, 'chroma-sync-state.json');
  if (safeStat(root, chromaState)) {
    const value = jsonObject(chromaState);
    const keys = Object.keys(value).filter(hasProject);
    for (const key of keys) delete value[key];
    if (keys.length) write(chromaState, value);
  }

  const ledgerDirectories = workViewDirectories(root);
  const ledgerFiles = ledgerDirectories.flatMap(directory => filesBelow(root, directory));
  let affectedLedger = scope.sessions.length > 0;
  for (const file of ledgerFiles) {
    if (!/request-groups.*\.json(?:[.-].*)?$/.test(basename(file))) continue;
    const value = jsonObject(file);
    if (!value.groups || !value.conversations) throw new Error(`Invalid request groups: ${file}`);
    let changed = false;
    for (const key of Object.keys(value.conversations)) if (sessionKeys.has(key)) {
      requestIds.add(value.conversations[key]);
      delete value.conversations[key];
      changed = true;
    }
    for (const [id, group] of Object.entries(value.groups) as Array<[string, any]>) {
      const members = Object.keys(value.conversations).filter(key => value.conversations[key] === id);
      const selected = hasProject(group.projectRoot) || sessionKeys.has(group.anchor);
      if (selected || requestIds.has(id)) {
        requestIds.add(id);
        changed = true;
        if (members.length === 0 || hasProject(group.projectRoot)) {
          delete value.groups[id];
          for (const key of members) delete value.conversations[key];
        } else {
          // Preserve other conversations' membership, without aggregate text derived from the deleted source.
          value.groups[id] = { anchor: members[0], projectRoot: null, title: '', anchorAsk: null, links: [] };
        }
      }
    }
    for (const name of ['ignored', 'suggestions']) {
      if (!value[name]) continue;
      for (const key of Object.keys(value[name])) if (sessionKeys.has(key)) { delete value[name][key]; changed = true; }
    }
    if (changed) { affectedLedger = true; write(file, value); }
  }
  for (const id of requestIds) if (/^g_[0-9a-f]{12}$/.test(id)) requestIds.add(JSON.stringify(['overall-request', id]));
  const matchesRequest = (id: string): boolean => {
    if (requestIds.has(id)) return true;
    let key: unknown;
    try { key = JSON.parse(id); } catch { return false; }
    return Array.isArray(key) && key[0] === 'explicit-request' && key.length === 3 && hasProject(key[1]);
  };
  for (const file of ledgerFiles) {
    const name = basename(file).replace(/^\./, '');
    if (name.startsWith('request-groups')) continue;
    if (/^g_[0-9a-f]{12}\.json(?:[.-].*)?$/.test(name) && requestIds.has(name.slice(0, 14))) remove(file);
    else if (/^human-copy\.json(?:[.-].*)?$/.test(name)) {
      const value = jsonObject(file);
      let changed = false;
      for (const id of Object.keys(value.entries ?? {})) if (matchesRequest(id)) { requestIds.add(id); delete value.entries[id]; changed = true; }
      if (changed) write(file, value);
    } else if (/^human-copy-usage\.jsonl(?:[.-].*)?$/.test(name)) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n').filter(line => line && !matchesRequest(parseJsonWithBom<{ requestId: string }>(line).requestId));
      const next = lines.length ? `${lines.join('\n')}\n` : '';
      if (next !== text) planned.set(file, { path: file, action: 'write', value: next });
    } else if (file === join(root, 'work-view', 'agent-written-prompts.json')) {
      const value = jsonObject(file);
      if (!Array.isArray(value.promptIds)) throw new Error(`Invalid prompt exclusions: ${file}`);
      const promptIds = value.promptIds.filter((id: number) => !scope.promptIds?.includes(id));
      if (promptIds.length !== value.promptIds.length) write(file, { ...value, promptIds });
    } else if (affectedLedger && (/^(story|refresh|hosted-intent|hosted-intent-pending)\.json(?:[.-].*)?$/.test(name)
      || relative(root, file).split(sep).some(part => ['owner-goals', 'agent-runs', 'failed-answers'].includes(part)))) remove(file);
  }
  for (const name of readdirSync(root)) {
    if (!/^work-view-reviews.*\.db$/.test(name)) continue;
    const file = join(root, name);
    safeStat(root, file);
    for (const suffix of ['-wal', '-shm', '-journal']) safeStat(root, file + suffix);
    const db = new Database(file, { readonly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      for (const table of ['work_view_reviews', 'work_view_review_overrides']) if (tables.some(row => row.name === table)) {
        for (const row of db.prepare(`SELECT request_id FROM ${table}`).all() as Array<{ request_id: string }>) {
          if (matchesRequest(row.request_id)) requestIds.add(row.request_id);
        }
      }
    } finally { db.close(); }
    inventory.reviewDatabases.push(file);
  }

  for (const directory of [join(root, 'state', 'hook-spool'), join(root, 'state', 'session-end-replay')]) {
    for (const file of filesBelow(root, directory)) {
      if (!jsonFile(file)) continue;
      let value: Record<string, any>;
      try { value = jsonObject(file); }
      catch { inventory.unattributedPaths.push(file); continue; }
      const payload = value.payload ?? value;
      if (hasProject(payload.project) || scope.sessions.some(session =>
        session.content_session_id === payload.contentSessionId && session.platform_source === (payload.platformSource ?? 'claude'))) {
        if (value.kind === 'deliverables' && Array.isArray(payload.files)) for (const deliverable of payload.files) {
          if (typeof deliverable.bucketPath !== 'string') throw new Error(`Invalid spooled deliverable path: ${file}`);
          removeDeliverable(deliverable.bucketPath);
        }
        remove(file);
      }
    }
  }

  if (safeStat(root, deliverablesRoot)) {
    const selectedBuckets = new Set(scope.projects.map(project => projectKey(basename(resolveDeliverableBucketDir(project, deliverablesRoot)))));
    for (const name of readdirSync(deliverablesRoot)) {
      if (!selectedBuckets.has(projectKey(name))) continue;
      const directory = join(deliverablesRoot, name);
      if (!safeStat(root, directory)?.isDirectory()) throw new Error(`Invalid deliverable bucket: ${directory}`);
      for (const file of filesBelow(root, directory)) if (!planned.has(file) && !retained.has(file)) {
        inventory.unattributedPaths.push(file);
      }
    }
  }

  const watchFile = join(root, 'transcript-watch-state.json');
  if (safeStat(root, watchFile)) {
    const value = jsonObject(watchFile);
    let changed = false;
    for (const file of Object.keys(value.offsets ?? {})) {
      const pendingKeys = Object.keys(value.pendingTools?.[file] ?? {});
      const nativeSessionId = basename(file).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
      const matches = scope.sessions.some(session => session.transcript_path === file || (session.cwd && value.cwds?.[file] === session.cwd)
        || nativeSessionId === session.content_session_id || pendingKeys.some(key => key.endsWith(`:${session.content_session_id}`)));
      if (!matches) continue;
      inventory.preservedWatchCheckpoints.push(file);
      // Numeric offsets/frame line counts and fingerprints contain no source text and prevent replay.
      for (const name of ['pendingTools', 'partials', 'partialBytes', 'cwds']) if (value[name] && Object.hasOwn(value[name], file)) {
        delete value[name][file];
        changed = true;
      }
    }
    if (changed) write(watchFile, value);
  }
  // The command's confirmation explicitly covers the shared diagnostic log directory.
  removeTree(join(root, 'logs'));
  inventory.removedRequestIds = [...requestIds];
  inventory.operations = [...planned.values()];
  return inventory;
}

/** Run after database/vector shutdown, which can itself create new diagnostic log files. */
export function cleanProjectDiagnosticLogs(dataDir: string): number {
  const root = resolve(dataDir);
  let removed = 0;
  const remove = (directory: string): void => {
    if (!safeStat(root, directory)) return;
    for (const name of readdirSync(directory)) {
      const file = join(directory, name);
      if (safeStat(root, file)!.isDirectory()) remove(file);
      else { unlinkSync(file); removed++; }
    }
    rmdirSync(directory);
  };
  remove(join(root, 'logs'));
  return removed;
}

export function cleanProjectMemoryFiles(inventory: ProjectMemoryFileInventory): { removedFiles: number; rewrittenFiles: number; removedReviews: number } {
  let removedFiles = 0;
  let rewrittenFiles = 0;
  let removedReviews = 0;
  for (const operation of inventory.operations) {
    const stat = safeStat(inventory.dataDir, operation.path);
    if (!stat) continue;
    if (operation.action === 'remove') {
      if (stat.isDirectory()) rmdirSync(operation.path); else { unlinkSync(operation.path); removedFiles++; }
    } else {
      if (typeof operation.value === 'string') writeTextFileAtomic(operation.path, operation.value, { mode: 0o600 });
      else writeJsonFileAtomic(operation.path, operation.value, { mode: 0o600 });
      rewrittenFiles++;
    }
  }
  for (const file of inventory.reviewDatabases) {
    safeStat(inventory.dataDir, file);
    for (const suffix of ['-wal', '-shm', '-journal']) safeStat(inventory.dataDir, file + suffix);
    const db = new Database(file, { readwrite: true, create: false });
    try {
      db.exec('PRAGMA secure_delete = ON');
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      db.transaction(() => {
        for (const table of ['work_view_reviews', 'work_view_review_overrides']) if (tables.some(row => row.name === table)) {
          const statement = db.prepare(`DELETE FROM ${table} WHERE request_id = ?`);
          for (const id of inventory.removedRequestIds) removedReviews += statement.run(id).changes;
        }
      })();
      if (removedReviews) {
        db.exec('VACUUM');
        const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
        if (checkpoint.busy) throw new Error(`Review cleanup checkpoint is busy: ${file}`);
      }
    } finally { db.close(); }
  }
  return { removedFiles, rewrittenFiles, removedReviews };
}

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { OBSERVER_SESSIONS_PROJECT, resolveDataDir } from '../../shared/paths.js';
import { holdSpawnLock } from '../../shared/worker-spawn-gate.js';
import { getWorkerPort } from '../../shared/worker-utils.js';
import { shutdownWorkerAndWait } from '../install/shutdown-helper.js';
import { readJsonFileWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { join, sep } from 'node:path';
import { existsSync, lstatSync, unlinkSync } from 'node:fs';
import { listProjectDatabaseInventory, inspectProjectDatabase, purgeProjectDatabase } from './database.js';
import { openProjectDatabases, compactProjectDatabase, type ProjectDatabaseFile } from './backups.js';
import { listFileProjects, inventoryProjectMemoryFiles, cleanProjectMemoryFiles, cleanProjectDiagnosticLogs } from './files.js';
import { assertProjectDeletionOffline, assertCloudErasureAvailable } from './preflight.js';
import { prepareVectorPurge } from './vectors.js';
import type { SessionStore } from '../sqlite/SessionStore.js';

const projectKey = (project: string): string => project.replace(/[A-Z]/g, char => char.toLowerCase());

export interface ProjectDeletionStats {
  project: string;
  sessionCount: number;
  observationCount: number;
  summaryCount: number;
  promptCount: number;
}

export interface ProjectDeletionSummary {
  projects: string[];
  projectCount: number;
  sessionCount: number;
  observationCount: number;
  summaryCount: number;
  promptCount: number;
}

export interface DeleteProjectInteraction {
  intro(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  success(message: string): void;
  cancel(message: string): void;
  outro(message: string): void;
  selectProjects(options: ProjectDeletionStats[]): Promise<string[] | null>;
  confirmDeletion(summary: ProjectDeletionSummary): Promise<boolean>;
}

function formatStats(stats: ProjectDeletionStats): string {
  return [
    `${stats.sessionCount} session${stats.sessionCount === 1 ? '' : 's'}`,
    `${stats.observationCount} observation${stats.observationCount === 1 ? '' : 's'}`,
    `${stats.summaryCount} summar${stats.summaryCount === 1 ? 'y' : 'ies'}`,
    `${stats.promptCount} prompt${stats.promptCount === 1 ? '' : 's'}`,
  ].join(', ');
}

function formatSummary(summary: ProjectDeletionSummary): string {
  return [
    `${summary.projectCount} project${summary.projectCount === 1 ? '' : 's'}`,
    `${summary.sessionCount} session${summary.sessionCount === 1 ? '' : 's'}`,
    `${summary.observationCount} observation${summary.observationCount === 1 ? '' : 's'}`,
    `${summary.summaryCount} summar${summary.summaryCount === 1 ? 'y' : 'ies'}`,
    `${summary.promptCount} prompt${summary.promptCount === 1 ? '' : 's'}`,
  ].join(', ');
}

export function summarizeProjectDeletion(selectedProjects: ProjectDeletionStats[]): ProjectDeletionSummary {
  return selectedProjects.reduce<ProjectDeletionSummary>((summary, project) => {
    summary.projects.push(project.project);
    summary.projectCount += 1;
    summary.sessionCount += project.sessionCount;
    summary.observationCount += project.observationCount;
    summary.summaryCount += project.summaryCount;
    summary.promptCount += project.promptCount;
    return summary;
  }, {
    projects: [],
    projectCount: 0,
    sessionCount: 0,
    observationCount: 0,
    summaryCount: 0,
    promptCount: 0,
  });
}

function createInteraction(): DeleteProjectInteraction {
  return {
    intro(message: string) {
      p.intro(pc.bgRed(pc.white(` ${message} `)));
    },
    info(message: string) {
      p.log.info(message);
    },
    warn(message: string) {
      p.log.warn(message);
    },
    success(message: string) {
      p.log.success(message);
    },
    cancel(message: string) {
      p.cancel(message);
    },
    outro(message: string) {
      p.outro(message);
    },
    async selectProjects(options: ProjectDeletionStats[]): Promise<string[] | null> {
      const result = await p.multiselect({
        message: 'Select the projects to delete from claude-mem:',
        options: options.map((option) => ({
          value: option.project,
          label: option.project,
          hint: formatStats(option),
        })),
        required: false,
      });

      return p.isCancel(result) ? null : result;
    },
    async confirmDeletion(summary: ProjectDeletionSummary): Promise<boolean> {
      const result = await p.confirm({
        message: `Delete ${summary.projectCount} project${summary.projectCount === 1 ? '' : 's'} from claude-mem? This removes ${formatSummary(summary)}.`,
        initialValue: false,
      });

      return !p.isCancel(result) && result;
    },
  };
}

export async function runDeleteProjectCommand(
  _args: string[] = [],
  deps: {
    interaction?: DeleteProjectInteraction;
    store?: SessionStore;
    stopWorker?: typeof shutdownWorkerAndWait;
  } = {},
): Promise<number> {
  if (!deps.interaction && process.stdin.isTTY !== true) {
    console.error('delete-project requires an interactive TTY.');
    return 1;
  }

  const interaction = deps.interaction ?? createInteraction();
  const dataDir = resolveDataDir();
  let release: (() => void) | null = null;
  let databases: ProjectDatabaseFile[] = [];
  let vectors: Awaited<ReturnType<typeof prepareVectorPurge>> = null;
  const pendingPath = join(dataDir, 'project-delete-pending.json');
  let pendingProjects: string[] = [];

  try {
    interaction.intro('claude-mem delete-project');
    if (deps.store) {
      databases = [{ db: deps.store.db, path: ':memory:', backup: false }];
    } else {
      release = await holdSpawnLock(0);
      if (!release) throw new Error('Another claude-mem launcher or maintenance operation is running.');
      // The launcher lock intentionally fails open on I/O errors; destructive maintenance cannot.
      if (readJsonFileWithBom<{ pid: number }>(join(dataDir, 'spawn.lock')).pid !== process.pid) {
        throw new Error('Could not hold the worker spawn lock for project deletion.');
      }
      const port = getWorkerPort({ readOnly: true });
      interaction.info('Stopping claude-mem before project deletion…');
      const stopped = await (deps.stopWorker ?? shutdownWorkerAndWait)(port);
      if (!stopped.stopped) {
        throw new Error(`Could not stop claude-mem on port ${port} (${stopped.blocker.kind}). Close active agent sessions or stop its service manager, then rerun.`);
      }
      assertProjectDeletionOffline(dataDir);
      interaction.info('Worker stopped. Checking local databases and backups…');
      if (existsSync(pendingPath)) {
        if (lstatSync(pendingPath).isSymbolicLink()) throw new Error('Refusing a symlinked project deletion receipt.');
        const pending = readJsonFileWithBom<{ projects: unknown }>(pendingPath);
        if (!Array.isArray(pending.projects) || !pending.projects.length || !pending.projects.every(project => typeof project === 'string' && project.length > 0)) {
          throw new Error('Invalid pending project deletion receipt; resolve it before deleting more projects.');
        }
        pendingProjects = pending.projects;
      }
      databases = openProjectDatabases(dataDir);
      assertCloudErasureAvailable(dataDir, []);
      interaction.info('Checking local vector index; preparing Chroma dependencies may take a few minutes if historical data needs inspection…');
      vectors = await prepareVectorPurge({ dataDir });
    }

    const candidates = new Map<string, ProjectDeletionStats>();
    const addProject = (project: string) => {
      const key = projectKey(project);
      if ([OBSERVER_SESSIONS_PROJECT, '__my_work__'].some(internal => projectKey(internal) === key)) return;
      if (!candidates.has(key)) candidates.set(key, { project, sessionCount: 0, observationCount: 0, summaryCount: 0, promptCount: 0 });
    };
    for (const file of databases) for (const row of listProjectDatabaseInventory(file.db)) {
      addProject(row.project);
      const candidate = candidates.get(projectKey(row.project));
      if (candidate && !file.backup) {
        for (const field of ['sessionCount', 'observationCount', 'summaryCount', 'promptCount'] as const) candidate[field] += row[field];
      }
    }
    if (!deps.store) {
      for (const project of pendingProjects) addProject(project);
      for (const project of listFileProjects(dataDir)) addProject(project);
      if (vectors) for (const project of await vectors.listProjects()) addProject(project);
    }
    const projects = [...candidates.values()].sort((a, b) => a.project.localeCompare(b.project));
    if (projects.length === 0) {
      interaction.outro('No project records found in the database, backups, files or vector index.');
      return 0;
    }
    const selectedProjectNames = await interaction.selectProjects(projects);
    if (!selectedProjectNames || selectedProjectNames.length === 0) {
      interaction.cancel('Deletion cancelled.');
      return 0;
    }
    const selected = new Set(selectedProjectNames.map(projectKey));
    const selectedProjects = projects.filter(project => selected.has(projectKey(project.project)));
    if (selectedProjects.length === 0) {
      interaction.warn('Selected projects no longer exist.');
      return 1;
    }
    const summary = summarizeProjectDeletion(selectedProjects);
    if (pendingProjects.length && (pendingProjects.length !== selected.size || pendingProjects.some(project => !selected.has(projectKey(project))))) {
      throw new Error(`Finish the interrupted deletion first by selecting exactly: ${pendingProjects.join(', ')}.`);
    }
    const selections = databases.map(file => inspectProjectDatabase(file.db, summary.projects));
    if (!deps.store) assertCloudErasureAvailable(dataDir, selections);
    else if (selections.some(selection => selection.cloudEvidence.length)) throw new Error('Complete cloud erasure is unavailable; refusing an unreplicated local deletion.');
    const retainedAttachments = new Set(selections.flatMap(selection => selection.retainedAttachmentIds));
    const fileInventory = deps.store ? null : inventoryProjectMemoryFiles({
      dataDir,
      projects: summary.projects,
      sessions: selections.flatMap(selection => selection.sessions),
      deliverables: selections.flatMap(selection => selection.deliverables),
      retainedDeliverablePaths: selections.flatMap(selection => selection.retainedDeliverablePaths),
      attachmentIds: selections.flatMap(selection => selection.attachmentIds).filter(id => !retainedAttachments.has(id)),
      mediaDirectories: selections.flatMap(selection => selection.mediaDirectories).filter(id => !retainedAttachments.has(id)),
      promptIds: selections.filter((_, index) => !databases[index].backup).flatMap(selection => selection.promptIds),
      observationIds: selections.filter((_, index) => !databases[index].backup).flatMap(selection => selection.observationIds),
    });
    if (fileInventory?.unattributedPaths.length) {
      throw new Error(`Cannot safely attribute these files to a single project; no data was deleted: ${fileInventory.unattributedPaths.join(', ')}`);
    }
    const extraRows = selections.reduce((sum, selection) => sum + selection.inventory.reduce((n, row) => n + row.toolUseCount + row.workStateCount + row.deliverableCount, 0), 0);
    interaction.info(`Selected: ${summary.projects.join(', ')}. Current sessions/observations/summaries/prompts: ${formatSummary(summary)}. Selected database rows across current data and backups: ${selections.reduce((count, selection) => count + selection.recordCount, 0)} (including ${extraRows} tool/work-state/deliverable records), plus associated cleanup, ${fileInventory?.operations.length ?? 0} file changes, and matching vector documents.`);
    if (!deps.store) interaction.warn(`Historical backups (${databases.filter(file => file.backup).length}) will be scrubbed in place. ALL shared claude-mem diagnostic logs will be cleared, including logs of other projects. Original agent transcripts and source files are outside this command. Keep agent sessions closed until deletion completes.`);
    if (!await interaction.confirmDeletion(summary)) {
      interaction.cancel('Deletion cancelled.');
      return 0;
    }
    if (!deps.store) assertProjectDeletionOffline(dataDir);
    if (!deps.store) writeJsonFileAtomic(pendingPath, { projects: summary.projects }, { mode: 0o600 });
    // Keep database identities until external cleanup succeeds, so a failed run can be repeated.
    const vectorCount = vectors ? await vectors.purgeProjects(summary.projects) : 0;
    await vectors?.close();
    vectors = null;
    const logDirectory = fileInventory ? join(fileInventory.dataDir, 'logs') : '';
    const fileCounts = fileInventory ? cleanProjectMemoryFiles({
      ...fileInventory,
      operations: fileInventory.operations.filter(operation => operation.path !== logDirectory && !operation.path.startsWith(logDirectory + sep)),
    }) : null;
    const removedLogs = deps.store ? 0 : cleanProjectDiagnosticLogs(dataDir);
    // Backups first: the live database remains an inventory if an older snapshot fails.
    for (const file of [...databases].sort((a, b) => Number(b.backup) - Number(a.backup))) {
      const hasRecords = inspectProjectDatabase(file.db, summary.projects).recordCount > 0;
      if (!hasRecords && pendingProjects.length === 0) continue;
      if (hasRecords) purgeProjectDatabase(file.db, summary.projects);
      if (!deps.store) compactProjectDatabase(file);
      const remaining = listProjectDatabaseInventory(file.db).filter(row => selected.has(projectKey(row.project)));
      if (remaining.length) throw new Error(`Project records remain in ${file.path}; deletion is incomplete.`);
    }
    if (!deps.store) unlinkSync(pendingPath);
    interaction.success(`Deleted ${summary.projectCount} project${summary.projectCount === 1 ? '' : 's'} from claude-mem.`);
    interaction.outro(`Cleared current data and available local backups; ${vectorCount} vector documents, ${(fileCounts?.removedFiles ?? 0) + removedLogs} files removed, ${fileCounts?.rewrittenFiles ?? 0} shared files updated. Payload-free replay checkpoints are retained.`);
    return 0;
  } catch (error) {
    interaction.warn(error instanceof Error ? error.message : String(error));
    interaction.outro('Deletion did not complete. No success is claimed; fix the reported problem and rerun.');
    return 1;
  } finally {
    try { await vectors?.close(); }
    finally {
      if (!deps.store) for (const file of databases) file.db.close();
      release?.();
    }
  }
}

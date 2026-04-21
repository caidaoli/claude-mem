import * as p from '@clack/prompts';
import pc from 'picocolors';
import { OBSERVER_SESSIONS_PROJECT } from '../../shared/paths.js';
import { SessionStore } from '../sqlite/SessionStore.js';

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

export function listProjectDeletionCandidates(store: SessionStore): ProjectDeletionStats[] {
  const rows = store.db.prepare(`
    SELECT
      s.project AS project,
      COUNT(DISTINCT s.id) AS sessionCount,
      COUNT(DISTINCT o.id) AS observationCount,
      COUNT(DISTINCT ss.id) AS summaryCount,
      COUNT(DISTINCT up.id) AS promptCount
    FROM sdk_sessions s
    LEFT JOIN observations o ON o.memory_session_id = s.memory_session_id
    LEFT JOIN session_summaries ss ON ss.memory_session_id = s.memory_session_id
    LEFT JOIN user_prompts up ON up.content_session_id = s.content_session_id
    WHERE s.project IS NOT NULL
      AND s.project != ''
      AND s.project != ?
    GROUP BY s.project
    ORDER BY s.project ASC
  `).all(OBSERVER_SESSIONS_PROJECT) as ProjectDeletionStats[];

  return rows.map((row) => ({
    project: row.project,
    sessionCount: Number(row.sessionCount),
    observationCount: Number(row.observationCount),
    summaryCount: Number(row.summaryCount),
    promptCount: Number(row.promptCount),
  }));
}

export function deleteProjectsMemory(store: SessionStore, projects: string[]): ProjectDeletionSummary | null {
  const candidates = listProjectDeletionCandidates(store);
  const selectedProjects = projects
    .map((project) => candidates.find((candidate) => candidate.project === project) ?? null)
    .filter((candidate): candidate is ProjectDeletionStats => candidate !== null)
    .filter((candidate, index, list) => list.findIndex((item) => item.project === candidate.project) === index);

  if (selectedProjects.length === 0) {
    return null;
  }

  const summary = summarizeProjectDeletion(selectedProjects);
  const placeholders = summary.projects.map(() => '?').join(', ');

  const deleteTx = store.db.transaction((projectNames: string[]) => {
    return store.db.prepare(`DELETE FROM sdk_sessions WHERE project IN (${placeholders})`).run(...projectNames);
  });

  const result = deleteTx(summary.projects);
  return result.changes > 0 ? summary : null;
}

export async function runDeleteProjectCommand(
  _args: string[] = [],
  deps: {
    interaction?: DeleteProjectInteraction;
    store?: SessionStore;
  } = {},
): Promise<number> {
  if (!deps.interaction && process.stdin.isTTY !== true) {
    console.error('delete-project requires an interactive TTY.');
    return 1;
  }

  const interaction = deps.interaction ?? createInteraction();
  const store = deps.store ?? new SessionStore();
  const ownsStore = !deps.store;

  try {
    interaction.intro('claude-mem delete-project');

    const projects = listProjectDeletionCandidates(store);
    if (projects.length === 0) {
      interaction.outro('No projects found in the claude-mem database.');
      return 0;
    }

    const selectedProjectNames = await interaction.selectProjects(projects);
    if (!selectedProjectNames || selectedProjectNames.length === 0) {
      interaction.cancel('Deletion cancelled.');
      return 0;
    }

    const selectedProjects = selectedProjectNames
      .map((projectName) => projects.find((candidate) => candidate.project === projectName) ?? null)
      .filter((candidate): candidate is ProjectDeletionStats => candidate !== null);
    if (selectedProjects.length === 0) {
      interaction.warn('Selected projects no longer exist.');
      return 1;
    }

    const summary = summarizeProjectDeletion(selectedProjects);
    interaction.info(`Selected ${summary.projectCount} project${summary.projectCount === 1 ? '' : 's'}: ${summary.projects.join(', ')}.`);

    const confirmed = await interaction.confirmDeletion(summary);
    if (!confirmed) {
      interaction.cancel('Deletion cancelled.');
      return 0;
    }

    const deleted = deleteProjectsMemory(store, summary.projects);
    if (!deleted) {
      interaction.warn('Selected projects no longer exist.');
      return 1;
    }

    interaction.success(`Deleted ${deleted.projectCount} project${deleted.projectCount === 1 ? '' : 's'} from claude-mem.`);
    interaction.outro(`Removed ${formatSummary(deleted)} across: ${deleted.projects.join(', ')}.`);
    return 0;
  } finally {
    if (ownsStore) {
      store.close();
    }
  }
}

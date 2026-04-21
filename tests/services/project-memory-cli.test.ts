import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OBSERVER_SESSIONS_PROJECT } from '../../src/shared/paths.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import {
  deleteProjectsMemory,
  listProjectDeletionCandidates,
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

  it('lists project deletion candidates with aggregated counts and excludes internal observer project', () => {
    seedProject(store, 'alpha', 'alpha-1');
    seedProject(store, 'alpha', 'alpha-2');
    seedProject(store, 'beta', 'beta-1');
    store.createSDKSession('observer-content', OBSERVER_SESSIONS_PROJECT, 'internal prompt');

    const projects = listProjectDeletionCandidates(store);

    expect(projects).toEqual([
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

  it('deletes multiple projects and cascades to observations, summaries, and prompts', () => {
    seedProject(store, 'alpha', 'alpha-1');
    seedProject(store, 'alpha', 'alpha-2');
    seedProject(store, 'beta', 'beta-1');
    seedProject(store, 'gamma', 'gamma-1');

    const deleted = deleteProjectsMemory(store, ['alpha', 'beta']);

    expect(deleted).toEqual({
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
    expect(interaction.confirmedSummary).toEqual({
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

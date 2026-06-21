import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Header } from './components/Header';
import { Feed } from './components/Feed';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { LogsDrawer } from './components/LogsModal';
import { CleanupModal } from './components/CleanupModal';
import { WelcomeCard, getStoredWelcomeDismissed, setStoredWelcomeDismissed } from './components/WelcomeCard';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { useStats } from './hooks/useStats';
import { usePagination } from './hooks/usePagination';
import { useTheme } from './hooks/useTheme';
import { useI18n } from './i18n';
import { Observation, Summary, UserPrompt } from './types';
import { mergeAndDeduplicateByProject } from './utils/data';

export function App() {
  const { t } = useI18n();
  const [currentFilter, setCurrentFilter] = useState('');
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [logsModalOpen, setLogsModalOpen] = useState(false);
  const [cleanupModalOpen, setCleanupModalOpen] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState<boolean>(getStoredWelcomeDismissed);
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);
  const [paginatedSummaries, setPaginatedSummaries] = useState<Summary[]>([]);
  const [paginatedPrompts, setPaginatedPrompts] = useState<UserPrompt[]>([]);

  const { observations, summaries, prompts, projects, isProcessing, queueDepth, isConnected } = useSSE();
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { refreshStats } = useStats();
  const { preference, setThemePreference } = useTheme();
  const pagination = usePagination(currentFilter);

  const matchesSelection = useCallback((item: { project: string }) => {
    return !currentFilter || item.project === currentFilter;
  }, [currentFilter]);

  useEffect(() => {
    if (currentFilter && !projects.includes(currentFilter)) {
      setCurrentFilter('');
    }
  }, [projects, currentFilter]);

  const allObservations = useMemo(() => {
    const live = observations.filter(matchesSelection);
    const paginated = paginatedObservations.filter(matchesSelection);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [observations, paginatedObservations, matchesSelection]);

  const allSummaries = useMemo(() => {
    const live = summaries.filter(matchesSelection);
    const paginated = paginatedSummaries.filter(matchesSelection);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [summaries, paginatedSummaries, matchesSelection]);

  const allPrompts = useMemo(() => {
    const live = prompts.filter(matchesSelection);
    const paginated = paginatedPrompts.filter(matchesSelection);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [prompts, paginatedPrompts, matchesSelection]);

  const toggleContextPreview = useCallback(() => {
    setContextPreviewOpen(prev => !prev);
  }, []);

  const toggleLogsModal = useCallback(() => {
    setLogsModalOpen(prev => !prev);
  }, []);

  // Toggle cleanup modal
  const toggleCleanupModal = useCallback(() => {
    setCleanupModalOpen(prev => !prev);
  }, []);

  // Handle loading more data
  const handleLoadMore = useCallback(async () => {
    try {
      const [newObservations, newSummaries, newPrompts] = await Promise.all([
        pagination.observations.loadMore(),
        pagination.summaries.loadMore(),
        pagination.prompts.loadMore()
      ]);

      if (newObservations.length > 0) {
        setPaginatedObservations(prev => [...prev, ...newObservations]);
      }
      if (newSummaries.length > 0) {
        setPaginatedSummaries(prev => [...prev, ...newSummaries]);
      }
      if (newPrompts.length > 0) {
        setPaginatedPrompts(prev => [...prev, ...newPrompts]);
      }
    } catch (error) {
      console.error('Failed to load more data:', error);
    }
  }, [pagination.observations, pagination.summaries, pagination.prompts]);

  useEffect(() => {
    setPaginatedObservations([]);
    setPaginatedSummaries([]);
    setPaginatedPrompts([]);
    handleLoadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFilter]);

  useEffect(() => {
    refreshStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [observations.length]);

  return (
    <>
      <Header
        isConnected={isConnected}
        projects={projects}
        currentFilter={currentFilter}
        onFilterChange={setCurrentFilter}
        isProcessing={isProcessing}
        queueDepth={queueDepth}
        themePreference={preference}
        onThemeChange={setThemePreference}
        onContextPreviewToggle={toggleContextPreview}
        onShowHelp={() => {
          setStoredWelcomeDismissed(false);
          setWelcomeDismissed(false);
        }}
      />

      <Feed
        observations={allObservations}
        summaries={allSummaries}
        prompts={allPrompts}
        onLoadMore={handleLoadMore}
        isLoading={pagination.observations.isLoading || pagination.summaries.isLoading || pagination.prompts.isLoading}
        hasMore={pagination.observations.hasMore || pagination.summaries.hasMore || pagination.prompts.hasMore}
      />

      {!welcomeDismissed && (
        <WelcomeCard onDismiss={() => setWelcomeDismissed(true)} />
      )}

      <ContextSettingsModal
        isOpen={contextPreviewOpen}
        onClose={toggleContextPreview}
        settings={settings}
        onSave={saveSettings}
        isSaving={isSaving}
        saveStatus={saveStatus}
      />

      <button
        className="console-toggle-btn"
        onClick={toggleLogsModal}
        title={t.app.toggleConsole}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5"></polyline>
          <line x1="12" y1="19" x2="20" y2="19"></line>
        </svg>
      </button>

      <button
        className="cleanup-toggle-btn"
        onClick={toggleCleanupModal}
        title={t.app.memoryMaintenance}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>

      <LogsDrawer
        isOpen={logsModalOpen}
        onClose={toggleLogsModal}
      />

      <CleanupModal
        isOpen={cleanupModalOpen}
        onClose={toggleCleanupModal}
      />
    </>
  );
}

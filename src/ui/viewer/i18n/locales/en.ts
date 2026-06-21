export const en = {
  // Header
  header: {
    allProjects: 'All Projects',
    documentation: 'Documentation',
    followX: 'Follow us on X',
    joinDiscord: 'Join our Discord community',
    showWelcome: 'Show welcome card',
    settings: 'Settings',
  },

  // Feed
  feed: {
    noItems: 'No items to display',
    loadingMore: 'Loading more...',
    noMoreItems: 'No more items to load',
  },

  // Welcome Card
  welcome: {
    title: 'Welcome to claude-mem',
    subtitle: 'Persistent memory for Claude Code.',
    liveFeed: 'Live feed',
    liveFeedDesc: 'Observations, summaries, and prompts stream in live.',
    tuneIt: 'Tune it',
    tuneItDesc: 'The gear in the top-right tunes memory injection.',
    recallIt: 'Recall it',
    recallItDesc: 'Ask Claude or run /mem-search to find past work.',
    howItWorks: 'How it works',
    readDocs: 'Read the docs',
    closeWelcome: 'Close welcome',
    closeEsc: 'Close (Esc)',
  },

  // Observation Card
  observation: {
    untitled: 'Untitled',
    facts: 'facts',
    narrative: 'narrative',
    read: 'read:',
    modified: 'modified:',
    merged: 'merged →',
  },

  // Summary Card
  summary: {
    sessionSummary: 'Session Summary',
    investigated: 'Investigated',
    learned: 'Learned',
    completed: 'Completed',
    nextSteps: 'Next Steps',
    session: 'Session',
  },

  // Prompt Card
  prompt: {
    prompt: 'Prompt',
  },

  // Theme Toggle
  theme: {
    lightClickDark: 'Theme: Light (click for Dark)',
    darkClickSystem: 'Theme: Dark (click for System)',
    systemClickLight: 'Theme: System (click for Light)',
  },

  // Context Settings Modal
  settings: {
    title: 'Settings',
    source: 'Source:',
    project: 'Project:',
    closeEsc: 'Close (Esc)',
    errorLoadingPreview: 'Error loading preview:',
    // Loading section
    loading: 'Loading',
    loadingDesc: 'How many observations to inject',
    observations: 'Observations',
    observationsTooltip: 'Number of recent observations to include in context (1-200)',
    sessions: 'Sessions',
    sessionsTooltip: 'Number of recent sessions to pull observations from (1-50)',
    // Display section
    display: 'Display',
    displayDesc: 'What to show in context tables',
    fullObservations: 'Full Observations',
    count: 'Count',
    countTooltip: 'How many observations show expanded details (0-20)',
    field: 'Field',
    fieldTooltip: 'Which field to expand for full observations',
    narrativeOption: 'Narrative',
    factsOption: 'Facts',
    tokenEconomics: 'Token Economics',
    readCost: 'Read cost',
    readCostDesc: 'Tokens to read this observation',
    workInvestment: 'Work investment',
    workInvestmentDesc: 'Tokens spent creating this observation',
    savings: 'Savings',
    savingsDesc: 'Total tokens saved by reusing context',
    // Advanced section
    advanced: 'Advanced',
    advancedDesc: 'AI provider and model selection',
    aiProvider: 'AI Provider',
    aiProviderTooltip: 'Choose between Claude (via Agent SDK), Gemini (via REST API), OpenRouter (multi-model), or a Custom endpoint',
    claudeOption: 'Claude (uses your Claude account)',
    geminiOption: 'Gemini (uses API key)',
    openrouterOption: 'OpenRouter (multi-model)',
    customOption: 'Custom (your own endpoint)',
    claudeModel: 'Claude Model',
    claudeModelTooltip: 'Claude model used for generating observations',
    haikuOption: 'haiku (fastest)',
    sonnetOption: 'sonnet (balanced)',
    opusOption: 'opus (highest quality)',
    geminiApiKey: 'Gemini API Key',
    geminiApiKeyTooltip: 'Your Google AI Studio API key (or set GEMINI_API_KEY env var)',
    enterGeminiKey: 'Enter Gemini API key...',
    geminiModel: 'Gemini Model',
    geminiModelTooltip: 'Gemini model used for generating observations',
    rateLimiting: 'Rate Limiting',
    rateLimitingDesc: 'Enable for free tier (10-30 RPM). Disable if you have billing set up (1000+ RPM).',
    openrouterApiKey: 'OpenRouter API Key',
    openrouterApiKeyTooltip: 'Your OpenRouter API key from openrouter.ai (or set OPENROUTER_API_KEY env var)',
    enterOpenrouterKey: 'Enter OpenRouter API key...',
    openrouterModel: 'OpenRouter Model',
    openrouterModelTooltip: 'Model identifier from OpenRouter (e.g., anthropic/claude-3.5-sonnet, google/gemini-2.0-flash-thinking-exp)',
    siteUrl: 'Site URL (Optional)',
    siteUrlTooltip: 'Your site URL for OpenRouter analytics (optional)',
    appName: 'App Name (Optional)',
    appNameTooltip: 'Your app name for OpenRouter analytics (optional)',
    apiBaseUrl: 'API Base URL',
    apiBaseUrlTooltip: 'Base URL of your endpoint. Examples: https://api.openai.com, https://your-proxy.example.com, https://generativelanguage.googleapis.com',
    apiKey: 'API Key',
    apiKeyTooltip: 'API key for the custom endpoint (or set CUSTOM_API_KEY env var)',
    enterApiKey: 'Enter API key...',
    model: 'Model',
    modelTooltip: 'Model identifier expected by the endpoint (e.g., gpt-4o, gemini-2.5-flash, gpt-5.4-mini)',
    protocol: 'Protocol',
    protocolTooltip: 'Wire protocol the endpoint speaks. OpenAI = /v1/chat/completions, Gemini = generateContent, Codex = /v1/responses',
    maxContextMessages: 'Max Context Messages',
    maxContextMessagesTooltip: 'Conversation messages kept per request after head-anchored truncation. 0 = unlimited (no truncation)',
    maxTokens: 'Max Tokens',
    maxTokensTooltip: 'Estimated token budget per request (chars/4). 0 = disabled',
    firstTokenTimeout: 'First Token Timeout (s)',
    firstTokenTimeoutTooltip: 'Seconds to wait for the first response chunk before retrying. 0 = disabled',
    totalTimeout: 'Total Timeout (s)',
    totalTimeoutTooltip: 'Seconds for the full request including body read. 0 = disabled',
    streaming: 'Streaming',
    streamingDesc: 'Use SSE streaming for partial responses (recommended for long generations)',
    workerPort: 'Worker Port',
    workerPortTooltip: 'Port for the background worker service',
    logLevel: 'Log Level',
    logLevelTooltip: 'Worker/hook log verbosity. DEBUG = most verbose; SILENT = no logs. Default: INFO',
    includeLastSummary: 'Include last summary',
    includeLastSummaryDesc: 'Add previous session\'s summary to context',
    includeLastMessage: 'Include last message',
    includeLastMessageDesc: 'Add previous session\'s final message',
    saving: 'Saving...',
    save: 'Save',
  },

  // Cleanup Modal
  cleanup: {
    title: 'Memory Maintenance',
    close: 'Close',
    cleanupPeriod: 'Cleanup Period',
    last7Days: 'Last 7 days',
    last7DaysDesc: 'Delete records older than 7 days',
    last15Days: 'Last 15 days',
    last15DaysDesc: 'Delete records older than 15 days',
    last1Month: 'Last 1 month',
    last1MonthDesc: 'Delete records older than 30 days',
    last6Months: 'Last 6 months',
    last6MonthsDesc: 'Delete records older than 180 days',
    last1Year: 'Last 1 year',
    last1YearDesc: 'Delete records older than 365 days',
    all: 'All',
    allDesc: 'Delete ALL records (CAREFUL!)',
    preview: 'Preview',
    previewTitle: 'Preview',
    cutoffDate: 'Cutoff date:',
    observations: 'Observations',
    summaries: 'Summaries',
    prompts: 'Prompts',
    sessions: 'Sessions',
    total: 'Total',
    startCleanup: 'Start Cleanup',
    noRecords: 'No records to delete in this period.',
    confirmWarningPre: '',
    confirmWarningPost: ' records will be permanently deleted. This cannot be undone!',
    confirmTypeLabel: 'Type "DELETE ALL" to confirm:',
    confirmPhrase: 'DELETE ALL',
    confirmPlaceholder: 'DELETE ALL',
    cancel: 'Cancel',
    deleting: 'Deleting...',
    delete: 'Delete',
    cleanupComplete: 'Cleanup Complete!',
    recordsDeleted: ' records deleted:',
    observation: 'observation',
    summary: 'summary',
    prompt: 'prompt',
    session: 'session',
    done: 'Done',
    loading: 'Loading...',
    previewFailed: 'Preview failed',
    cleanupFailed: 'Cleanup failed',
    confirmError: 'Type "DELETE ALL" to confirm',
  },

  // Logs Drawer
  logs: {
    console: 'Console',
    autoRefresh: 'Auto-refresh',
    refreshLogs: 'Refresh logs',
    scrollToBottom: 'Scroll to bottom',
    clearLogs: 'Clear logs',
    closeConsole: 'Close console',
    confirmClear: 'Are you sure you want to clear all logs?',
    noLogs: 'No logs available',
    quick: 'Quick:',
    alignment: 'Alignment',
    alignmentTitle: 'Show only session alignment logs',
    levels: 'Levels:',
    components: 'Components:',
    selectNone: 'Select none',
    selectAll: 'Select all',
  },

  // App-level
  app: {
    toggleConsole: 'Toggle Console',
    memoryMaintenance: 'Memory Maintenance',
  },

  // Language switcher
  language: {
    label: 'Language',
    en: 'English',
    zhCN: '中文',
  },

  // Error Boundary
  errorBoundary: {
    title: 'Something went wrong',
    message: 'The application encountered an error. Please refresh the page to try again.',
    details: 'Error details',
  },

  // GitHub Button
  github: {
    title: 'GitHub',
    starUs: 'Star us on GitHub',
    stars: 'stars',
  },

  // Scroll to Top
  scrollToTop: {
    ariaLabel: 'Scroll to top',
  },

  // Protocols
  protocols: {
    openai: 'OpenAI',
    gemini: 'Gemini',
    codex: 'Codex (Responses API)',
  },
} as const;

export type TranslationKeys = typeof en;


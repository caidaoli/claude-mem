import type { TranslationKeys } from './en';

export const zhCN: TranslationKeys = {
  // Header
  header: {
    allProjects: '所有项目',
    documentation: '文档',
    followX: '关注我们的 X',
    joinDiscord: '加入我们的 Discord 社区',
    showWelcome: '显示欢迎卡片',
    settings: '设置',
  },

  // Feed
  feed: {
    noItems: '没有可显示的项目',
    loadingMore: '加载更多...',
    noMoreItems: '没有更多项目了',
  },

  // Welcome Card
  welcome: {
    title: '欢迎使用 claude-mem',
    subtitle: 'Claude Code 的持久化记忆。',
    liveFeed: '实时动态',
    liveFeedDesc: '观察记录、摘要和提示实时流入。',
    tuneIt: '调优配置',
    tuneItDesc: '右上角齿轮图标可调节记忆注入方式。',
    recallIt: '搜索回忆',
    recallItDesc: '向 Claude 提问或运行 /mem-search 查找过去的工作。',
    howItWorks: '工作原理',
    readDocs: '阅读文档',
    closeWelcome: '关闭欢迎',
    closeEsc: '关闭 (Esc)',
  },

  // Observation Card
  observation: {
    untitled: '无标题',
    facts: '事实',
    narrative: '叙述',
    read: '读取:',
    modified: '修改:',
    merged: '合并至 →',
  },

  // Summary Card
  summary: {
    sessionSummary: '会话摘要',
    investigated: '已调查',
    learned: '已学习',
    completed: '已完成',
    nextSteps: '下一步',
    session: '会话',
  },

  // Prompt Card
  prompt: {
    prompt: '提示',
  },

  // Theme Toggle
  theme: {
    lightClickDark: '主题：浅色（点击切换为深色）',
    darkClickSystem: '主题：深色（点击切换为系统）',
    systemClickLight: '主题：跟随系统（点击切换为浅色）',
  },

  // Context Settings Modal
  settings: {
    title: '设置',
    source: '来源：',
    project: '项目：',
    closeEsc: '关闭 (Esc)',
    errorLoadingPreview: '加载预览出错：',
    // Loading section
    loading: '加载配置',
    loadingDesc: '注入多少条观察记录',
    observations: '观察记录数',
    observationsTooltip: '包含在上下文中的最近观察记录数量 (1-200)',
    sessions: '会话数',
    sessionsTooltip: '从最近多少个会话中提取观察记录 (1-50)',
    // Display section
    display: '显示',
    displayDesc: '上下文表格中显示的内容',
    fullObservations: '完整观察记录',
    count: '数量',
    countTooltip: '显示展开详情的观察记录数 (0-20)',
    field: '字段',
    fieldTooltip: '完整观察记录展开的字段',
    narrativeOption: '叙述',
    factsOption: '事实',
    tokenEconomics: 'Token 经济',
    readCost: '读取成本',
    readCostDesc: '读取此观察记录的 Token 数',
    workInvestment: '工作投入',
    workInvestmentDesc: '创建此观察记录花费的 Token 数',
    savings: '节省',
    savingsDesc: '通过复用上下文节省的总 Token 数',
    // Advanced section
    advanced: '高级',
    advancedDesc: 'AI 提供商和模型选择',
    aiProvider: 'AI 提供商',
    aiProviderTooltip: '在 Claude（通过 Agent SDK）、Gemini（通过 REST API）、OpenRouter（多模型）或自定义端点之间选择',
    claudeOption: 'Claude（使用你的 Claude 账户）',
    geminiOption: 'Gemini（使用 API 密钥）',
    openrouterOption: 'OpenRouter（多模型）',
    customOption: '自定义（你自己的端点）',
    claudeModel: 'Claude 模型',
    claudeModelTooltip: '用于生成观察记录的 Claude 模型',
    haikuOption: 'haiku（最快）',
    sonnetOption: 'sonnet（平衡）',
    opusOption: 'opus（最高质量）',
    geminiApiKey: 'Gemini API 密钥',
    geminiApiKeyTooltip: '你的 Google AI Studio API 密钥（或设置 GEMINI_API_KEY 环境变量）',
    enterGeminiKey: '输入 Gemini API 密钥...',
    geminiModel: 'Gemini 模型',
    geminiModelTooltip: '用于生成观察记录的 Gemini 模型',
    rateLimiting: '速率限制',
    rateLimitingDesc: '免费层级启用 (10-30 RPM)。如果已设置计费则禁用 (1000+ RPM)。',
    openrouterApiKey: 'OpenRouter API 密钥',
    openrouterApiKeyTooltip: '你的 OpenRouter API 密钥，来自 openrouter.ai（或设置 OPENROUTER_API_KEY 环境变量）',
    enterOpenrouterKey: '输入 OpenRouter API 密钥...',
    openrouterModel: 'OpenRouter 模型',
    openrouterModelTooltip: 'OpenRouter 的模型标识符（例如 anthropic/claude-3.5-sonnet, google/gemini-2.0-flash-thinking-exp）',
    siteUrl: '站点 URL（可选）',
    siteUrlTooltip: '你的站点 URL，用于 OpenRouter 统计（可选）',
    appName: '应用名称（可选）',
    appNameTooltip: '你的应用名称，用于 OpenRouter 统计（可选）',
    apiBaseUrl: 'API 基础 URL',
    apiBaseUrlTooltip: '你的端点基础 URL。示例：https://api.openai.com、https://your-proxy.example.com、https://generativelanguage.googleapis.com',
    apiKey: 'API 密钥',
    apiKeyTooltip: '自定义端点的 API 密钥（或设置 CUSTOM_API_KEY 环境变量）',
    enterApiKey: '输入 API 密钥...',
    model: '模型',
    modelTooltip: '端点使用的模型标识符（例如 gpt-4o, gemini-2.5-flash, gpt-5.4-mini）',
    protocol: '协议',
    protocolTooltip: '端点使用的协议。OpenAI = /v1/chat/completions, Gemini = generateContent, Codex = /v1/responses',
    maxContextMessages: '最大上下文消息数',
    maxContextMessagesTooltip: '每次请求保留的对话消息数（头部锚定截断后）。0 = 无限制（不截断）',
    maxTokens: '最大 Token 数',
    maxTokensTooltip: '每次请求的估计 Token 预算 (字符数/4)。0 = 禁用',
    firstTokenTimeout: '首 Token 超时 (秒)',
    firstTokenTimeoutTooltip: '等待第一个响应块的秒数，超时后重试。0 = 禁用',
    totalTimeout: '总超时 (秒)',
    totalTimeoutTooltip: '完整请求（包括读取正文）的秒数。0 = 禁用',
    streaming: '流式传输',
    streamingDesc: '使用 SSE 流式传输部分响应（推荐用于长时间生成）',
    workerPort: 'Worker 端口',
    workerPortTooltip: '后台 Worker 服务的端口',
    logLevel: '日志级别',
    logLevelTooltip: 'Worker/Hook 日志详细程度。DEBUG = 最详细；SILENT = 无日志。默认：INFO',
    includeLastSummary: '包含上次摘要',
    includeLastSummaryDesc: '将上次会话的摘要添加到上下文',
    includeLastMessage: '包含上次消息',
    includeLastMessageDesc: '将上次会话的最后一条消息添加到上下文',
    saving: '保存中...',
    save: '保存',
  },

  // Cleanup Modal
  cleanup: {
    title: '记忆维护',
    close: '关闭',
    cleanupPeriod: '清理周期',
    last7Days: '最近 7 天',
    last7DaysDesc: '删除 7 天前的记录',
    last15Days: '最近 15 天',
    last15DaysDesc: '删除 15 天前的记录',
    last1Month: '最近 1 个月',
    last1MonthDesc: '删除 30 天前的记录',
    last6Months: '最近 6 个月',
    last6MonthsDesc: '删除 180 天前的记录',
    last1Year: '最近 1 年',
    last1YearDesc: '删除 365 天前的记录',
    all: '全部',
    allDesc: '删除所有记录（请谨慎！）',
    preview: '预览',
    previewTitle: '预览',
    cutoffDate: '截止日期：',
    observations: '观察记录',
    summaries: '摘要',
    prompts: '提示',
    sessions: '会话',
    total: '合计',
    startCleanup: '开始清理',
    noRecords: '此周期内没有要删除的记录。',
    confirmWarningPre: '',
    confirmWarningPost: ' 条记录将被永久删除。此操作不可撤销！',
    confirmTypeLabel: '输入"全部删除"以确认：',
    confirmPhrase: '全部删除',
    confirmPlaceholder: '全部删除',
    cancel: '取消',
    deleting: '删除中...',
    delete: '删除',
    cleanupComplete: '清理完成！',
    recordsDeleted: ' 条记录已删除：',
    observation: '观察记录',
    summary: '摘要',
    prompt: '提示',
    session: '会话',
    done: '完成',
    loading: '加载中...',
    previewFailed: '预览失败',
    cleanupFailed: '清理失败',
    confirmError: '输入"全部删除"以确认',
  },

  // Logs Drawer
  logs: {
    console: '控制台',
    autoRefresh: '自动刷新',
    refreshLogs: '刷新日志',
    scrollToBottom: '滚动到底部',
    clearLogs: '清除日志',
    closeConsole: '关闭控制台',
    confirmClear: '确定要清除所有日志吗？',
    noLogs: '暂无日志',
    quick: '快捷：',
    alignment: '对齐',
    alignmentTitle: '仅显示会话对齐日志',
    levels: '级别：',
    components: '组件：',
    selectNone: '取消全选',
    selectAll: '全选',
  },

  // App-level
  app: {
    toggleConsole: '切换控制台',
    memoryMaintenance: '记忆维护',
  },

  // Language switcher
  language: {
    label: '语言',
    en: 'English',
    zhCN: '中文',
  },

  // Error Boundary
  errorBoundary: {
    title: '出错了',
    message: '应用程序遇到错误。请刷新页面重试。',
    details: '错误详情',
  },

  // GitHub Button
  github: {
    title: 'GitHub',
    starUs: '在 GitHub 上给我们加星',
    stars: '星标',
  },

  // Scroll to Top
  scrollToTop: {
    ariaLabel: '回到顶部',
  },

  // Protocols
  protocols: {
    openai: 'OpenAI',
    gemini: 'Gemini',
    codex: 'Codex (Responses API)',
  },
};


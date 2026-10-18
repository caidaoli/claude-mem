const translations = {
  en: {
    language: 'Language', myWork: 'My Work', teamBrain: 'TeamBrain', memorySettings: 'Memory & settings',
    skip: 'Skip to my work', workspaceEyebrow: 'Your workspace, at a glance', workspaceSubtitle: 'Your requests. What landed. What needs you.',
    cards: 'Cards', list: 'List', agents: 'Agents', workView: 'Work view', search: 'Search requests or agents', project: 'Project', allProjects: 'All projects',
    timeRange: 'Time range', day: 'Past 24 hours', week: 'Past 7 days', allWork: 'All recorded work', sort: 'Sort', sortRequests: 'Sort requests', attention: 'Attention first', latest: 'Latest update', oldest: 'Oldest update', titleAZ: 'Request A–Z',
    filterWork: 'Filter work', all: 'All', needs: 'Needs you', working: 'In progress', quiet: 'No recent update', ready: 'Ready to check', checked: 'Checked', blocked: 'Blocked', todo: 'To do', unknown: 'Update recorded', closed: 'Closed', other: 'Other states',
    allWorkHeading: 'All work', connecting: 'Connecting…', waiting: 'Waiting for local work', loading: 'Loading your local work…', noMatch: 'No matching work', noRequests: 'No requests here yet', reconnect: 'Keep this page open to reconnect, or open the memory viewer to inspect the worker.', reading: 'Reading saved requests from this computer.', tryAnother: 'Try another request, project or contributor.', recordedRequests: 'Recorded human requests appear here as your tools save work. You can also explore your existing memory below.',
    openMemory: 'Open memory & settings →', sourceNote: 'Reading saved requests from this computer…', readingNote: 'Working, reported complete, and human checked are separate states. Your review closes the loop.',
    optionalConnections: 'Optional connections', connectClaude: 'Connect Claude.ai ↗', connectChatGPT: 'Connect ChatGPT ↗', cloudChecking: 'Cloud sync: checking configuration…', waitingConnection: 'Waiting for the local connection…',
    teamOptional: 'Optional shared workspace', teamIntro: 'See the work your team chose to share, and the next step you can help with.', personalSeparate: 'Your personal work stays separate.', checkConnection: 'Check your connection to see shared work.', noSharedVisit: 'No shared update received in this visit.', getConnected: 'Get connected', chooseTeam: 'Choose how to join your team.', teamSetupIntro: 'TeamBrain adds a shared view beside My Work. Each member chooses what to share; opening this page does not upload your local work.', startTeam: 'Start a team', startTeamDesc: 'Set up a team account in CMEM Cloud, check the available plan, and invite the people you work with.', setupTeam: 'Set up a team ↗', pricingNote: 'Plan eligibility and current pricing are shown during setup. This page does not start a subscription.', existingInvite: 'Use an existing invitation', inviteDesc: 'Ask a team owner for an invite link, then run this command in a terminal on this computer:', approveDevice: 'Sign in and approve this device. An installation already connected to another account must resolve that account choice first.', refresh: 'Refresh connection', whatConnects: 'What connects here', connectsDesc: 'This panel reads shared lists, tasks and findings through your approved CMEM connection. Claude.ai and ChatGPT setup remains separate. TeamBrain does not assign work, send replies, or sync your private review notes.', openTeam: 'Already a member? Open your team account ↗', sharedWork: 'Shared work', teamSettings: 'Team settings ↗', searchShared: 'Search shared work, people or projects', filterShared: 'Filter shared work by project', recordedTeam: 'Recorded team activity, not a presence signal. Continue with your teammate or in the source conversation. Private review notes stay on this computer.',
    backRequest: 'Back to request', backMyWork: 'Back to My Work', allAgents: 'All agents', contributor: 'Contributor', outsideHistory: 'This request is outside the loaded history', returnMyWork: 'Return to My Work to see the current requests.', exploreMemory: 'Explore recorded memory →',
    close: 'Close dialog', recordedResult: 'Recorded result · your review', evidence: 'Recorded evidence', noEvidence: 'No separate test evidence was recorded. Inspect the source before checking this result.', reviewNote: 'Checking saves a local note that you looked at this version. It does not certify correctness or change the agent’s work. New substantive updates need another check.', localReviewUnavailable: 'Local review storage is unavailable. Your source work remains readable and unchanged.', originalRequest: 'View original request', markChecked: 'Mark checked', changedWhileReading: 'This work changed while you were reading. Review the latest version before checking.', checkSaved: 'Checked locally. Your review is saved.', checkUndone: 'Check undone. The result is ready to review.', dismiss: 'Dismiss notification', handoffCopied: 'Handoff copied. Paste it into the agent or conversation you choose.', clipboardUnavailable: 'Clipboard unavailable. Copy the selected handoff text below.', loadingSource: 'Loading recorded source…', sourceUnavailable: 'This source record is no longer available.',
  },
  'zh-CN': {
    language: '语言', myWork: '我的工作', teamBrain: 'TeamBrain', memorySettings: '记忆与设置',
    skip: '跳转到我的工作', workspaceEyebrow: '一览你的工作区', workspaceSubtitle: '你的请求、已完成的工作，以及需要你处理的事项。',
    cards: '卡片', list: '列表', agents: '代理', workView: '工作视图', search: '搜索请求或代理', project: '项目', allProjects: '所有项目',
    timeRange: '时间范围', day: '过去 24 小时', week: '过去 7 天', allWork: '所有已记录的工作', sort: '排序', sortRequests: '排序请求', attention: '优先显示需处理项', latest: '最近更新', oldest: '最早更新', titleAZ: '请求名称 A–Z',
    filterWork: '筛选工作', all: '全部', needs: '需要你处理', working: '进行中', quiet: '近期无更新', ready: '待检查', checked: '已检查', blocked: '已阻塞', todo: '待开始', unknown: '已记录更新', closed: '已关闭', other: '其他状态',
    allWorkHeading: '全部工作', connecting: '连接中…', waiting: '正在等待本地工作', loading: '正在加载本地工作…', noMatch: '没有匹配的工作', noRequests: '还没有请求', reconnect: '保持此页面打开以重新连接，或打开记忆查看器检查 Worker。', reading: '正在读取这台电脑上保存的请求。', tryAnother: '换一个请求、项目或贡献者试试。', recordedRequests: '工具保存工作后，记录的人类请求会显示在这里。你也可以在下方查看已有记忆。',
    openMemory: '打开记忆与设置 →', sourceNote: '正在读取这台电脑上保存的请求…', readingNote: '进行中、已报告完成和人工检查是不同状态。你的检查会完成这条闭环。',
    optionalConnections: '可选连接', connectClaude: '连接 Claude.ai ↗', connectChatGPT: '连接 ChatGPT ↗', cloudChecking: '云同步：正在检查配置…', waitingConnection: '等待本地连接…',
    teamOptional: '可选共享工作区', teamIntro: '查看团队选择共享的工作，以及你可以协助的下一步。', personalSeparate: '你的个人工作保持独立。', checkConnection: '检查连接以查看共享工作。', noSharedVisit: '本次访问还没有收到共享更新。', getConnected: '连接团队', chooseTeam: '选择加入团队的方式。', teamSetupIntro: 'TeamBrain 会在“我的工作”旁边增加共享视图。每个人自行选择共享内容；打开此页面不会上传你的本地工作。', startTeam: '创建团队', startTeamDesc: '在 CMEM Cloud 创建团队账号，查看可用方案并邀请协作者。', setupTeam: '创建团队 ↗', pricingNote: '方案资格和当前价格会在设置过程中显示。此页面不会启动订阅。', existingInvite: '使用已有邀请', inviteDesc: '向团队所有者索取邀请链接，然后在这台电脑的终端中运行：', approveDevice: '登录并批准此设备。已经连接到其他账号的安装需要先解决账号选择。', refresh: '刷新连接', whatConnects: '这里会连接什么', connectsDesc: '此面板通过已批准的 CMEM 连接读取共享列表、任务和发现。Claude.ai 与 ChatGPT 的设置保持独立。TeamBrain 不会分配工作、发送回复或同步你的私人检查笔记。', openTeam: '已经是成员？打开团队账号 ↗', sharedWork: '共享工作', teamSettings: '团队设置 ↗', searchShared: '搜索共享工作、人员或项目', filterShared: '按项目筛选共享工作', recordedTeam: '这里记录的是团队活动，不代表在线状态。请与队友或源会话继续协作。私人检查笔记保留在这台电脑上。',
    backRequest: '返回请求', backMyWork: '返回我的工作', allAgents: '所有代理', contributor: '贡献者', outsideHistory: '此请求不在已加载的历史记录中', returnMyWork: '返回“我的工作”查看当前请求。', exploreMemory: '查看已记录的记忆 →',
    close: '关闭对话框', recordedResult: '已记录结果 · 你的检查', evidence: '已记录证据', noEvidence: '没有记录单独的测试证据。检查结果前请查看源内容。', reviewNote: '检查会保存一条本地笔记，记录你看过此版本。它不会证明结果正确，也不会改变代理的工作。新的实质更新需要再次检查。', localReviewUnavailable: '本地检查存储不可用。源工作仍可读取且未被修改。', originalRequest: '查看原始请求', markChecked: '标记为已检查', changedWhileReading: '你查看期间工作发生了变化。请查看最新版本后再检查。', checkSaved: '已在本地检查，检查结果已保存。', checkUndone: '已撤销检查，可以重新查看结果。', dismiss: '关闭通知', handoffCopied: '交接内容已复制。将它粘贴到你选择的代理或会话中。', clipboardUnavailable: '剪贴板不可用。请复制下方已选中的交接文本。', loadingSource: '正在加载已记录的源内容…', sourceUnavailable: '此源记录已不可用。',
  },
};

let current = 'en';
try {
  const stored = localStorage.getItem('claude-mem-locale');
  current = stored === 'zh-CN' || (!stored && navigator.language?.toLowerCase().startsWith('zh')) ? 'zh-CN' : 'en';
} catch { /* Browser storage may be unavailable. */ }

export const t = (key, vars = {}) => String(translations[current][key] ?? translations.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '');
export const locale = () => current;
export function setLocale(next) {
  current = next === 'zh-CN' ? 'zh-CN' : 'en';
  try { localStorage.setItem('claude-mem-locale', current); } catch { /* ignore */ }
  document.documentElement.lang = current;
  window.dispatchEvent(new CustomEvent('claude-mem-locale-change', { detail: current }));
}
export function applyStaticTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(element => { element.placeholder = t(element.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-aria]').forEach(element => { element.setAttribute('aria-label', t(element.dataset.i18nAria)); });
}

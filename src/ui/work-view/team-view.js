import { relativeTime } from './view-model.js';
import { t, locale, dateLocale } from './i18n.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const field = (pairs, names) => names.map(name => pairs?.find(pair => pair[0] === name)?.[1]).find(value => typeof value === 'string' && value.trim()) || '';
const statusLabel = value => ({ doing: t('working'), 'in-progress': t('working'), todo: t('todo'), blocked: t('blocked'), 'needs-you': t('needs'), 'needs-input': t('needs'), 'waiting-on-user': t('needs'), 'awaiting-approval': t('needs') })[String(value || '').toLowerCase()] || (value || (locale() === 'zh-CN' ? '未记录状态' : 'Status not recorded'));
const detailLabel = key => ({ human_summary: locale() === 'zh-CN' ? '更新' : 'Update', progress: locale() === 'zh-CN' ? '进度' : 'Progress', next: locale() === 'zh-CN' ? '下一步' : 'Next', next_step: locale() === 'zh-CN' ? '下一步' : 'Next', outcome: locale() === 'zh-CN' ? '结果' : 'Outcome', result: locale() === 'zh-CN' ? '结果' : 'Result', next_action: t('detailNextAction'), blocker: t('detailBlocker'), blockers: t('detailBlockers'), evidence: t('detailEvidence') })[key] || key;

export function sharingDescription(team) {
  if (!team.broadcasting) return locale() === 'zh-CN' ? '你正在查看共享工作。这台电脑已关闭共享。' : 'You are viewing shared work. Sharing from this computer is off.';
  const scope = team.projects === null ? t('allProjects').toLowerCase() : team.projects?.length ? team.projects.join(', ') : (locale() === 'zh-CN' ? '未选择项目' : 'no projects selected');
  return locale() === 'zh-CN' ? `共享设置已开启，范围：${scope}。` : `Your sharing setting is on for ${scope}.`;
}

const timeMarkup = (value, prefix = t('updatedPrefix')) => {
  const epoch = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(epoch) || epoch <= 0) return `<span class="team-task-time">${esc(t('timeNotRecorded'))}</span>`;
  return `<time data-team-time="${epoch}" data-time-prefix="${esc(prefix)}" datetime="${new Date(epoch).toISOString()}" title="${esc(new Date(epoch).toLocaleString(dateLocale()))}">${esc(prefix)} ${esc(relativeTime(epoch))}</time>`;
};
const findingLabel = value => ({ collision: t('overlappingWork'), delegation: t('handoff'), gap: t('missingContext') })[value] || (value ? String(value).replace(/[-_]/g, ' ') : t('finding'));
// Errors keep their key so a displayed message can follow a language switch.
const localError = key => Object.assign(new Error(t(key)), { i18nKey: key });
export function teamReceiptIsStale(receivedAt, now = performance.now()) {
  return receivedAt !== null && (!Number.isFinite(receivedAt) || !Number.isFinite(now) || now < receivedAt || now - receivedAt > 35000);
}

const detailKeys = ['human_summary', 'progress', 'next', 'next_step', 'next_action', 'blocker', 'blockers', 'outcome', 'result', 'evidence'];

export function filterTeamLists(board, { search = '', project = '' } = {}) {
  const needle = search.trim().toLowerCase();
  const findings = new Map(board.findings.map(finding => [finding.id, finding]));
  return board.lists.filter(list => (!project || list.project === project) && (!needle || [
    list.name, list.display_name, list.project, JSON.stringify(list.state),
    ...list.tasks.flatMap(task => [task.name, task.status, JSON.stringify(task.details), ...task.finding_ids.map(id => {
      const finding = findings.get(id); return finding ? `${finding.title} ${finding.subtitle || ''} ${finding.narrative || ''}` : '';
    })]),
  ].join(' ').toLowerCase().includes(needle)));
}

const normalizedTaskStatus = value => String(value || '').trim().toLowerCase().replace(/_/g, '-');
const terminalTaskStates = new Set(['done', 'complete', 'completed', 'closed', 'cancelled', 'canceled', 'dropped']);
const openTeamTasks = list => list.tasks.filter(task => !terminalTaskStates.has(normalizedTaskStatus(task.status)));
// A task summary is not a parent request lifecycle or a human review state.
export function teamTaskActivity(list) {
  const open = openTeamTasks(list);
  const count = t(open.length === 1 ? 'openTask' : 'openTasks', { count: open.length });
  if (list.closed) return { state: 'closed', label: locale() === 'zh-CN' ? '列表已关闭' : 'List closed', count };
  const statuses = new Set(open.map(task => normalizedTaskStatus(task.status)));
  for (const [state, label, aliases] of [
    ['needs', locale() === 'zh-CN' ? '任务：需要你处理' : 'Tasks: Needs you', ['needs-you', 'needs-input', 'needs-human', 'waiting-on-user', 'awaiting-approval']],
    ['blocked', locale() === 'zh-CN' ? '任务：已阻塞' : 'Tasks: Blocked', ['blocked']],
    ['working', locale() === 'zh-CN' ? '任务：进行中' : 'Tasks: In progress', ['doing', 'in-progress', 'working', 'active']],
    ['todo', locale() === 'zh-CN' ? '任务：待开始' : 'Tasks: To do', ['todo', 'to-do', 'queued', 'pending']],
  ]) if (aliases.some(status => statuses.has(status))) return { state, label, count };
  return { state: 'quiet', label: open.length ? (locale() === 'zh-CN' ? '未记录任务状态' : 'Task status not recorded') : (locale() === 'zh-CN' ? '没有未完成任务' : 'No open tasks'), count };
}

export function teamCardHtml(list, findings = new Map(), members = new Map(), open = false) {
  const key = JSON.stringify([list.user_id, list.project, list.name]);
  const recordedStatus = field(list.state, ['status', 'request_status']);
  const summary = field(list.state, ['human_summary', 'progress', 'stage', 'phase']) || t('openTasksHint');
  const next = field(list.state, ['next', 'next_step', 'next_action']) || list.tasks.map(task => field(task.details, ['next', 'next_step', 'next_action'])).find(Boolean);
  const activity = teamTaskActivity(list), count = activity.count;
  return `<article class="request-card team-card" tabindex="-1"><div class="team-card-main"><div class="request-card-meta"><span class="team-card-state" data-task-state="${activity.state}"><span class="team-state-dot" aria-hidden="true"></span>${esc(activity.label)}</span>${timeMarkup(list.last_written_at)}</div><h3>${esc(list.name)}</h3><p class="team-task-count">${esc(count)}${recordedStatus ? ` · ${esc(t('recordedListStatus', { status: statusLabel(recordedStatus) }))}` : ''}</p><p class="team-card-summary">${esc(summary)}</p><div class="team-card-byline"><strong>${esc(list.display_name)}</strong><span>${esc(list.project)}</span></div>${next ? `<div class="team-card-next"><span>${esc(t('nextStep'))}</span><p>${esc(next)}</p></div>` : ''}</div><details class="team-card-details" data-list="${esc(key)}" ${open ? 'open' : ''}><summary>${esc(count)} · ${esc(t('viewDetails'))}</summary><ol class="team-task-list">${list.tasks.map(task => `<li><div class="team-task-heading"><h4>${esc(task.name)}</h4><span class="team-task-status">${esc(statusLabel(task.status))}</span></div><span class="team-task-time">${timeMarkup(task.updated_at)}</span>${task.details.filter(([name, value]) => typeof value === 'string' && value.trim() && detailKeys.includes(name)).map(([name, value]) => `<p class="team-task-detail"><strong>${esc(detailLabel(name).replace(/_/g, ' '))}</strong>${esc(value)}</p>`).join('')}${task.finding_ids.map(id => findings.get(id)).filter(Boolean).map(finding => {
    const people = [...new Set(finding.member_ids.map(id => members.get(id) || t('teamMember')))];
    return `<details class="team-finding" data-finding="${finding.id}"><summary>${esc(t('labelColon', { label: findingLabel(finding.type) }))} ${esc(finding.title)}</summary>${finding.subtitle ? `<p>${esc(finding.subtitle)}</p>` : ''}${finding.narrative ? `<p>${esc(finding.narrative)}</p>` : ''}<p class="team-finding-meta">${esc(people.join(' · '))}${people.length ? ' · ' : ''}${timeMarkup(finding.created_at, t('recordedPrefix'))}</p></details>`;
  }).join('')}</li>`).join('') || `<li>${esc(t('noOpenTasksList'))}</li>`}</ol></details></article>`;
}

export async function readTeamResource(path, signal, { timeoutMs = 15000, fetcher = fetch } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timeout = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  try {
    const response = await fetcher(path, { cache: 'no-store', signal: controller.signal });
    const raw = await response.text();
    let body = null;
    try { body = JSON.parse(raw); } catch { /* Error responses may be HTML. */ }
    if (!response.ok) throw Object.assign(body?.error ? new Error(body.error) : localError('sharedLoadFailed'), { status: response.status });
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw localError('sharedUnreadable');
    return body;
  } catch (error) {
    if (timedOut) throw localError('teamTimeout');
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
}

export function setupTeamView() {
  const state = { active: false, teams: [], selected: '', appUrl: 'https://cmem.ai/teambrain/app', board: null, pending: null, signature: '', search: '', project: '', controller: null, serial: 0, lastReceived: 0, receivedAt: null, lastError: null, currentError: '', loading: false, inFlight: false };
  let timer = null;
  let personalHash = location.hash === '#teambrain' ? '#cards' : location.hash || '#cards';
  const read = (path, signal) => readTeamResource(path, signal);
  function paintHealth() {
    const health = $('team-health');
    const stale = state.lastReceived && teamReceiptIsStale(state.receivedAt);
    health.dataset.state = state.currentError ? 'error' : stale ? 'stale' : state.loading ? 'connecting' : state.lastReceived ? 'live' : 'idle';
    const message = state.currentError ? state.currentError() : t(stale ? 'sharedStale' : state.loading ? 'checkingTeam' : state.lastReceived ? 'sharedConnected' : 'teamIdle');
    if (health.textContent !== message) health.textContent = message;
    $('team-received').textContent = state.lastReceived ? t('lastTeamUpdate', { relative: relativeTime(state.lastReceived), time: new Date(state.lastReceived).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }) : t('noSharedVisit');
    $('team-last-error').hidden = !state.lastError;
    if (state.lastError) $('team-last-error').textContent = t('lastIssue', { time: new Date(state.lastError.at).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' }), message: state.lastError.message() });
    for (const element of document.querySelectorAll('[data-team-time]')) element.textContent = `${element.dataset.timePrefix} ${relativeTime(Number(element.dataset.teamTime))}`;
    for (const id of ['team-refresh', 'team-refresh-connected']) $(id).disabled = state.loading;
  }
  function startPolling() {
    timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      paintHealth();
      if (state.selected) void loadBoard();
    }, 5000);
  }
  function stop() { state.controller?.abort(); state.controller = null; clearInterval(timer); timer = null; state.serial++; state.inFlight = false; }
  function show(active, updateRoute = true) {
    if (active && !state.active && location.hash !== '#teambrain') personalHash = location.hash || '#cards';
    state.active = active;
    $('personal-workspace').hidden = active; $('team-workspace').hidden = !active;
    $('workspace-personal').setAttribute('aria-pressed', String(!active)); $('workspace-team').setAttribute('aria-pressed', String(active));
    if (updateRoute) history.replaceState(null, '', `${location.pathname}${location.search}${active ? '#teambrain' : personalHash}`);
    stop();
    if (active) {
      void loadTeams();
      startPolling();
    }
  }
  // Messages are kept as functions and resolved when painted, in the current language.
  function failure(error, context = 'sharedWork') {
    if (error.name === 'AbortError') return;
    state.currentError = () => t('contextUnavailable', { context: t(context), message: error.i18nKey ? t(error.i18nKey) : error.message });
    state.lastError = { at: Date.now(), message: state.currentError };
    paintHealth();
    if ([401, 403, 404].includes(error.status)) {
      state.board = null; state.pending = null; state.signature = '';
      $('team-updates').replaceChildren(); renderBoard();
    }
  }
  async function loadTeams() {
    const serial = ++state.serial;
    state.inFlight = false;
    state.controller?.abort(); state.controller = new AbortController();
    state.loading = true; paintHealth();
    try {
      const result = await read('/api/teambrain/status', state.controller.signal);
      if (!state.active || serial !== state.serial) return;
      if (!Array.isArray(result.teams)) throw localError('membershipUnreadable');
      state.currentError = ''; state.teams = result.teams || []; state.appUrl = result.appUrl || 'https://cmem.ai/teambrain/app';
      $('team-setup').hidden = result.configured && state.teams.length > 0;
      $('team-connected').hidden = !result.configured || state.teams.length === 0;
      if (!result.configured || !state.teams.length) {
        state.selected = ''; state.board = null; state.pending = null; state.signature = ''; state.lastReceived = 0; state.receivedAt = null;
        if (result.configured) state.currentError = () => t('noMembership');
        return;
      }
      const previousTeam = state.selected;
      state.selected = state.teams.some(team => team.id === state.selected) ? state.selected
        : state.teams.some(team => team.id === result.selectedTeamId) ? result.selectedTeamId : state.teams[0].id;
      if (state.selected !== previousTeam) { state.lastReceived = 0; state.receivedAt = null; state.board = null; state.pending = null; state.signature = ''; $('team-updates').replaceChildren(); }
      $('team-select').innerHTML = state.teams.map(team => `<option value="${esc(team.id)}" ${team.id === state.selected ? 'selected' : ''}>${esc(team.name)}</option>`).join('');
      renderBoard();
      await loadBoard();
    } catch (error) { if (serial === state.serial && state.active) failure(error, 'teamMembership'); }
    finally { if (serial === state.serial) { state.loading = false; paintHealth(); } }
  }
  async function loadBoard() {
    if (!state.active || !state.selected || state.inFlight) return;
    state.inFlight = true;
    const selected = state.selected, serial = state.serial;
    try {
      const result = await read(`/api/teambrain/board?team_id=${encodeURIComponent(selected)}`, state.controller?.signal);
      if (!state.active || serial !== state.serial || selected !== state.selected) return;
      if (!Array.isArray(result.lists) || !Array.isArray(result.findings)) throw localError('boardUnreadable');
      state.lastReceived = Date.now(); state.receivedAt = performance.now();
      state.currentError = ''; paintHealth();
      const signature = JSON.stringify(result);
      if (signature === state.signature) return;
      state.signature = signature;
      if (state.board && (window.scrollY > 220 || document.querySelector('.team-card details[open]') || document.activeElement?.closest('.team-card, .team-controls'))) {
        state.pending = result; pendingBanner();
      } else { state.board = result; state.pending = null; $('team-updates').replaceChildren(); renderBoard(); }
    } catch (error) { if (state.active && serial === state.serial && selected === state.selected) failure(error); }
    finally { if (serial === state.serial) state.inFlight = false; }
  }
  function pendingBanner() {
    $('team-updates').innerHTML = `<div class="updates-banner"><span>${esc(t('sharedUpdatesReady'))}</span><button type="button" id="apply-team-updates">${esc(t('showUpdates'))}</button></div>`;
    $('apply-team-updates').onclick = () => { state.board = state.pending; state.pending = null; $('team-updates').replaceChildren(); renderBoard(); $('shared-work-heading').focus({ preventScroll: true }); };
  }
  function renderBoard() {
    const team = state.teams.find(item => item.id === state.selected);
    $('team-name').textContent = team?.name || t('sharedWork');
    $('team-sharing').textContent = team ? sharingDescription(team) : '';
    $('team-seat-count').textContent = team?.seatsUsed != null && team.seatLimit != null ? t('seats', { used: team.seatsUsed, limit: team.seatLimit }) : '';
    const appUrl = new URL(state.appUrl); if (state.selected) appUrl.searchParams.set('team', state.selected);
    $('team-manage').href = appUrl.href;
    const board = state.board;
    if (!board) { $('team-cards').innerHTML = `<div class="team-empty"><h3>${esc(t('noSharedLoaded'))}</h3><p>${esc(t('noSharedLoadedText'))}</p></div>`; $('team-count').textContent = ''; return; }
    const projects = [...new Set(board.lists.map(list => list.project))].sort();
    if (state.project && !projects.includes(state.project)) state.project = '';
    $('team-project').hidden = projects.length < 2;
    $('team-project').innerHTML = `<option value="">${esc(t('allProjects'))}</option>` + projects.map(project => `<option value="${esc(project)}" ${state.project === project ? 'selected' : ''}>${esc(project)}</option>`).join('');
    const open = new Set([...document.querySelectorAll('.team-card details[open]')].map(item => item.dataset.list));
    const lists = filterTeamLists(board, state);
    const taskCount = lists.reduce((sum, list) => sum + openTeamTasks(list).length, 0);
    $('team-count').textContent = `${t(lists.length === 1 ? 'sharedList' : 'sharedLists', { count: lists.length })} · ${t(taskCount === 1 ? 'openTask' : 'openTasks', { count: taskCount })}`;
    const findings = new Map(board.findings.map(finding => [finding.id, finding]));
    const members = new Map(board.lists.map(list => [list.user_id, list.display_name]));
    const expandedFindings = new Set([...document.querySelectorAll('.team-finding[open]')].map(element => element.dataset.finding));
    $('team-cards').innerHTML = lists.length ? lists.map(list => teamCardHtml(list, findings, members, open.has(JSON.stringify([list.user_id, list.project, list.name])))).join('') : `<div class="team-empty"><h3>${esc(t('noSharedView'))}</h3><p>${esc(t('noSharedViewText'))}</p></div>`;
    for (const element of document.querySelectorAll('.team-finding')) if (expandedFindings.has(element.dataset.finding)) element.open = true;
  }
  $('workspace-personal').onclick = () => show(false);
  $('workspace-team').onclick = () => show(true);
  $('team-refresh').onclick = () => { state.signature = ''; void loadTeams(); };
  $('team-refresh-connected').onclick = () => { state.signature = ''; void loadTeams(); };
  $('team-select').onchange = event => { stop(); state.selected = event.target.value; state.lastReceived = 0; state.receivedAt = null; state.lastError = null; state.currentError = ''; state.board = null; state.pending = null; state.signature = ''; $('team-updates').replaceChildren(); renderBoard(); state.controller = new AbortController(); paintHealth(); void loadBoard(); startPolling(); };
  $('team-search').oninput = event => { state.search = event.target.value.trim().toLowerCase(); renderBoard(); };
  $('team-project').onchange = event => { state.project = event.target.value; renderBoard(); $('team-project').focus({ preventScroll: true }); };
  document.addEventListener('visibilitychange', () => {
    if (!state.active || document.visibilityState !== 'visible') return;
    paintHealth();
    if (state.selected) void loadBoard();
  });
  window.addEventListener('pagehide', stop);
  window.addEventListener('claude-mem-locale-change', () => {
    paintHealth();
    if (state.active) renderBoard();
    if (state.pending) pendingBanner();
  });
  window.addEventListener('popstate', () => {
    const active = location.hash === '#teambrain';
    if (active !== state.active) show(active, false);
  });
  if (location.hash === '#teambrain') show(true);
}

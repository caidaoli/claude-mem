import { setupTeamView } from './team-view.js';
import { relativeTime, requestElapsed } from './view-model.js';
import { presentWork, effectiveStatus, statusCategory, contentSignature, handoffText, scopeWork, sortWork } from './presentation.js';
import { personalRoute, parsePersonalRoute, requestCards, requestList, agentCards, requestPage, workstreamPage } from './request-views.js';
import { getConnectionStatus } from './live-status.js';
import { t, locale, dateLocale, setLocale, applyStaticTranslations } from './i18n.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { rows: [], unlinked: [], loaded: false, failed: false, snapshot: null, filter: 'all', query: '', range: 'day', project: '', sort: 'attention', view: 'cards', from: 'cards', requestId: null, workId: null, agentId: null, pending: null, applied: null, sync: null, signature: '', lastReceived: 0, sourceConnected: false, changed: new Set(), unread: new Set(), previousCounts: {}, busy: false, toastTimer: null };
const connection = { transportConnected: false, reconnecting: false, lastEventAt: null, sourceConnected: null, lastSuccessfulCheckAt: null, lastSuccessfulCheckReceivedAt: null };
const labelKeys = { all: 'all', needs: 'needs', working: 'working', quiet: 'quiet', ready: 'ready', checked: 'checked', blocked: 'blocked', todo: 'todo', unknown: 'unknown', closed: 'closed', other: 'other' };
const labels = new Proxy({}, { get: (_, key) => t(labelKeys[key] || key) });
const rowById = id => state.rows.find(row => row.id === id);
const closeButton = () => `<button type="button" class="dialog-close" data-close aria-label="${t('close')}">×</button>`;
// Existing bookmarked memory routes continue to open the preserved viewer.
if (/^#\/?(?:sessions(?:\/|$)|session\/|observation\/|summary\/)/.test(location.hash)) location.replace(`/viewer${location.hash}`);
function announce(text) { $('announcement').textContent = ''; requestAnimationFrame(() => { $('announcement').textContent = text; }); }
function scopedRows() {
  return scopeWork(state.rows, state).filter(row => !state.agentId || row.agentIds.includes(state.agentId));
}
function visibleRows() { return sortWork(scopedRows().filter(row => state.filter === 'all' || (state.filter === 'other' ? statusCategory(row) === 'other' : effectiveStatus(row) === state.filter)), state.sort); }
function render() {
  const open = new Set([...document.querySelectorAll('details[open]')].map(element => element.dataset.updates));
  const projects = [...new Set(state.rows.flatMap(row => row.projects?.length ? row.projects : [row.project]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (state.project && !projects.includes(state.project)) state.project = '';
  $('project-filter').hidden = false;
  $('project-filter').innerHTML = `<option value="">${t('allProjects')}</option>` + projects.map(project => `<option value="${esc(project)}" ${state.project === project ? 'selected' : ''}>${esc(project)}</option>`).join('');
  const scoped = scopedRows();
  const counts = Object.fromEntries(Object.keys(labels).map(key => [key, key === 'all' ? scoped.length : 0]));
  for (const row of scoped) {
    const status = effectiveStatus(row);
    counts[Object.hasOwn(labels, status) ? status : 'unknown']++;
    if (statusCategory(row) === 'other') counts.other++;
  }
  $('status-tabs').innerHTML = Object.entries(labels).filter(([key]) => ['all', 'needs', 'working', 'quiet', 'ready', 'checked'].includes(key) || key === state.filter || (key !== 'other' && counts[key])).map(([key, label]) => `<button type="button" class="status-tab" data-filter="${key}" aria-pressed="${state.filter === key}">${label}<span class="tab-count${state.previousCounts[key] != null && state.previousCounts[key] !== counts[key] ? ' changed' : ''}">${counts[key]}</span></button>`).join('');
  state.previousCounts = counts;
  const rows = visibleRows();
  $('work-heading').textContent = state.filter === 'all' ? t('allWorkHeading') : labels[state.filter];
  $('view-count').textContent = state.loaded ? `${rows.length} ${locale() === 'zh-CN' ? '个请求' : `request${rows.length === 1 ? '' : 's'}`}` : t('connecting');
  const emptyTitle = !state.loaded ? state.failed ? t('waiting') : t('loading') : state.query ? t('noMatch') : t('noRequests');
  const emptyText = !state.loaded ? state.failed ? t('reconnect') : t('reading') : state.query ? t('tryAnother') : t('recordedRequests');
  const detail = state.view === 'request';
  $('work-heading').parentElement.hidden = detail;
  $('personal-heading').hidden = detail;
  $('personal-toolbar').hidden = detail;
  $('status-tabs').hidden = detail;
  $('unlinked-work').hidden = detail || !state.unlinked.length;
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
  let html;
  let trail = '';
  if (detail) {
    const row = rowById(state.requestId);
    const work = row?.workstreams.find(item => item.id === state.workId);
    const route = work ? personalRoute('request', { ...state, workId: null }) : personalRoute(state.from, { ...state, requestId: null, workId: null });
    trail = `<a class="back-button" href="${esc(route)}" data-route>← ${work ? t('backRequest') : t('backMyWork')}</a>`;
    html = row ? work ? workstreamPage(row, work) : requestPage(row, state) : `<div class="empty-work"><h3>${t('outsideHistory')}</h3><p>${t('returnMyWork')}</p></div>`;
  } else {
    if (state.agentId) {
      const agent = state.rows.flatMap(row => row.contributors || []).find(agent => agent.id === state.agentId);
      trail = `<div class="agent-scope"><a class="back-button" href="${esc(personalRoute('agents', { ...state, agentId: null }))}" data-route>← ${t('allAgents')}</a><span>${esc(agent?.label || t('contributor'))}</span></div>`;
    }
    html = rows.length ? state.view === 'list' ? requestList(rows, state) : state.view === 'agents' && !state.agentId ? agentCards(rows, state) : requestCards(rows, state)
      : `<div class="empty-work"><h3>${emptyTitle}</h3><p>${emptyText}</p><a class="source-link" href="/viewer">${t('openMemory')}</a></div>`;
  }
  $('scope-trail').innerHTML = trail;
  $('work-grid').className = !detail && (state.view === 'cards' || state.agentId) ? 'work-grid request-grid' : !detail && state.view === 'agents' ? 'agent-grid' : '';
  $('work-grid').innerHTML = html;
  for (const element of document.querySelectorAll('details[data-updates]')) if (open.has(element.dataset.updates)) element.open = true;
  $('reading-note').textContent = t('readingNote');
  $('unlinked-work').hidden = detail || !state.unlinked.length;
  $('unlinked-count').textContent = locale() === 'zh-CN' ? `${state.unlinked.length} 条工作记录缺少关联的人类请求` : `${state.unlinked.length} work records need a linked human request`;
  $('unlinked-items').innerHTML = locale() === 'zh-CN' ? `<p>这些记录保持独立，因为原始人类请求未被捕获或关联。请在记忆查看器中查看来源。</p><a class="source-link" href="/viewer">${t('exploreMemory')}</a>` : '<p>These records stay separate because their original human request was not captured or linked. Explore their source in the memory viewer.</p><a class="source-link" href="/viewer">Explore recorded memory →</a>';
  state.changed.clear();
}
function dialog(id, content, html) { $(content).innerHTML = html; $(id).showModal(); }
function markRead(id) { state.unread.delete(id); const element = [...document.querySelectorAll('.work-card')].find(card => card.dataset.id === id); element?.querySelector('.new-dot')?.remove(); }
function evidenceList(row) { return `<ul>${(row.evidence.length ? row.evidence : [t('noEvidence')]).map(text => `<li>${esc(text)}</li>`).join('')}</ul>`; }
function openReview(id) {
  const row = rowById(id); if (!row) return; markRead(id);
  dialog('review-dialog', 'review-content', `<div class="dialog-body"><div class="dialog-top"><span class="dialog-eyebrow">${t('recordedResult')}</span>${closeButton()}</div><h2 id="review-title">${esc(row.title)}</h2><p class="dialog-intro">${esc(row.outcome)}</p><section class="evidence-box"><h3>${t('evidence')}</h3>${evidenceList(row)}</section><p class="dialog-note">${t('reviewNote')}</p>${row.review?.available === false ? `<p role="alert">${t('localReviewUnavailable')}</p>` : ''}<div class="dialog-actions"><button type="button" class="button-secondary" data-detail="${esc(id)}">${t('originalRequest')}</button><button type="button" class="button-primary" data-check="${esc(id)}" ${row.review?.available === false ? 'disabled' : ''}>${t('markChecked')}</button></div></div>`);
}
function openDetail(id) {
  if (!rowById(id)) return;
  markRead(id); $('review-dialog').close();
  navigate(personalRoute('request', { ...state, requestId: id, workId: null, from: state.view === 'request' ? state.from : state.view }));
}
const positions = new Map();
function syncControls() {
  $('search').value = state.query; $('time-range').value = state.range; $('sort').value = state.sort;
}
function navigate(route, replace = false) {
  positions.set(location.hash, { scroll: window.scrollY, focus: document.activeElement?.closest('[href]')?.getAttribute('href') });
  if (replace) history.replaceState(null, '', route); else history.pushState(null, '', route);
  Object.assign(state, parsePersonalRoute(route)); syncControls();
  if (state.requestId) markRead(state.requestId);
  render();
  const position = positions.get(route);
  const restore = position?.focus && [...document.querySelectorAll('[href]')].find(element => element.getAttribute('href') === position.focus);
  (restore || document.querySelector('#work-grid h1') || $('work-heading')).focus({ preventScroll: true });
  window.scrollTo(0, position?.scroll || 0);
}
function saveScope() {
  history.replaceState(null, '', personalRoute(state.view, state));
}
window.addEventListener('popstate', () => {
  if (location.hash === '#teambrain') return;
  Object.assign(state, parsePersonalRoute(location.hash)); syncControls(); render();
  const position = positions.get(location.hash);
  const restore = position?.focus && [...document.querySelectorAll('[href]')].find(element => element.getAttribute('href') === position.focus);
  restore?.focus({ preventScroll: true }); window.scrollTo(0, position?.scroll || 0);
});
function toast(message, undo = null) {
  clearTimeout(state.toastTimer); $('toast').hidden = false;
  $('toast').innerHTML = `<span>${esc(message)}</span>${undo ? `<button type="button" id="undo-check">${esc(t('undo'))}</button>` : ''}<button class="toast-dismiss" type="button" id="dismiss-toast" aria-label="${esc(t('dismiss'))}">×</button>`;
  if (undo) $('undo-check').onclick = undo;
  $('dismiss-toast').onclick = () => { $('toast').hidden = true; };
  if (!undo) state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 8000);
}
function focusCurrentWork(id) {
  const page = document.querySelector('#work-grid .request-page, #work-grid .records-page');
  const target = page?.querySelector('[data-undo], [data-review], h1')
    || [...document.querySelectorAll('.work-card')].find(card => card.dataset.id === id)
    || $('work-heading');
  target.focus({ preventScroll: true });
}
async function saveReview(id, checked) {
  const row = rowById(id); if (!row || state.busy) return;
  state.busy = true; document.querySelectorAll('[data-check],[data-undo]').forEach(button => { button.disabled = true; });
  try {
    const response = await fetch('/api/work-view/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: id, expectedFingerprint: row.contentFingerprint, checked }) });
    if (response.status === 409) { $('review-dialog').close(); await refresh(true); focusCurrentWork(id); toast(t('changedWhileReading')); return; }
    if (!response.ok) throw new Error(t('reviewSaveFailed'));
    const snapshot = await response.json(); $('review-dialog').close(); accept(snapshot, true);
    toast(t(checked ? 'checkSaved' : 'checkUndone'), checked ? () => saveReview(id, false) : null);
    announce(t(checked ? 'announceChecked' : 'announceUndone'));
    focusCurrentWork(id);
  } catch (error) { toast(error.message); }
  finally { state.busy = false; document.querySelectorAll('[data-check],[data-undo]').forEach(button => { button.disabled = false; }); }
}
function openConnection(service) {
  const name = service === 'ChatGPT' ? 'ChatGPT' : 'Claude.ai';
  dialog('connect-dialog', 'connect-content', `<div class="dialog-body"><div class="dialog-top"><span class="dialog-eyebrow">${locale() === 'zh-CN' ? '可选 CMEM Cloud 设置' : 'Optional CMEM Cloud setup'}</span>${closeButton()}</div><h2 id="connection-title">${locale() === 'zh-CN' ? `将记忆连接到 ${name}` : `Bring your memory to ${name}.`}</h2><p class="dialog-intro">${locale() === 'zh-CN' ? `继续现有的 CMEM 连接设置，登录并选择 ${name}。设置流程会说明如何连接聊天应用和本地记忆。` : `Continue to the existing CMEM connection setup, sign in, and choose ${name}. The setup explains how to connect your chat app and local memory.`}</p><p class="dialog-note">${locale() === 'zh-CN' ? '云同步可能上传保存的提示和观察记录。启用前请查看设置与共享范围。本地面板无需连接也可以使用。' : 'Cloud sync can upload your saved prompts and observation narratives. Review the setup and sharing scope before enabling it. This local panel stays available without connecting.'}</p><div class="dialog-actions"><button type="button" class="button-secondary" data-close>${locale() === 'zh-CN' ? '继续使用本地功能' : 'Keep working locally'}</button><a class="button-primary" href="https://cmem.ai/connect?from=local-work" target="_blank" rel="noopener noreferrer">${locale() === 'zh-CN' ? '继续连接设置 ↗' : 'Continue to connection setup ↗'}</a></div></div>`);
}
function pendingBanner() {
  $('updates-banner').innerHTML = `<div class="updates-banner"><span><strong>${esc(t('updatesReady'))}</strong> ${esc(t('placeSaved'))}</span><button type="button" id="apply-updates">${esc(t('showUpdates'))}</button></div>`;
  $('apply-updates').onclick = () => { if (state.pending) apply(state.pending, true); focusCurrentWork(state.requestId); announce(t('updatesApplied')); };
}
function isReading() { return state.view === 'request' || state.busy || window.scrollY > 220 || !!document.querySelector('dialog[open], .work-card details[open]') || !!document.activeElement?.closest('#work-grid, .search-field, .status-tabs, #personal-toolbar, .view-switch'); }
function apply(snapshot, force = false) {
  if (!force && state.rows.length && isReading()) {
    state.pending = snapshot; pendingBanner();
    return;
  }
  const previous = new Map(state.rows.map(row => [row.id, contentSignature(row)]));
  const content = new Map(state.rows.map(row => [row.id, row.contentFingerprint]));
  const result = presentWork(snapshot, state.rows);
  for (const row of result.rows) if (!previous.has(row.id) || previous.get(row.id) !== contentSignature(row)) {
    if (state.rows.length && (!content.has(row.id) || content.get(row.id) !== row.contentFingerprint)) state.unread.add(row.id);
    if (state.rows.length) state.changed.add(row.id);
  }
  state.rows = result.rows; state.unlinked = result.unlinked; state.applied = snapshot; state.pending = null; $('updates-banner').replaceChildren(); render();
}
function renderConnection() {
  const status = getConnectionStatus({ ...connection, now: performance.now(), wallNow: Date.now() });
  $('connection').dataset.state = status.state;
  $('connection').title = status.tooltip;
  if ($('connection-label').textContent !== status.label) $('connection-label').textContent = status.label;
  if ($('source-note').textContent !== status.detail) $('source-note').textContent = status.detail;
}
function health(source) {
  connection.sourceConnected = typeof source?.connected === 'boolean' ? source.connected : null;
  state.sourceConnected = connection.sourceConnected === true;
  state.failed = connection.sourceConnected === false;
  if (source?.connected === true && typeof source.lastCheckedAt === 'string' && Number.isFinite(Date.parse(source.lastCheckedAt))) {
    connection.lastSuccessfulCheckAt = source.lastCheckedAt;
    connection.lastSuccessfulCheckReceivedAt = performance.now();
  }
  renderConnection();
}
function paintReceived() { if (state.lastReceived) $('received-time').textContent = t('lastReceived', { time: new Date(state.lastReceived).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }); }
function received() { state.lastReceived = Date.now(); paintReceived(); }
function accept(snapshot, force = false, fromEvent = false) {
  state.loaded = true; state.snapshot = snapshot;
  received();
  // An HTTP read that began before a newer event must not renew or overwrite
  // the feed's source-health evidence.
  if (fromEvent || connection.lastEventAt === null) health(snapshot.source);
  const signature = JSON.stringify([snapshot.revision, snapshot.humanRequests, snapshot.unlinkedWork]);
  if (!force && signature === state.signature) return;
  state.signature = signature; apply(snapshot, force);
}
async function refresh(force = false) {
  const previousEvent = connection.lastEventAt;
  const response = await fetch('/api/work-view', { cache: 'no-store' });
  if (!response.ok) throw new Error(t('localLoadFailed'));
  const snapshot = await response.json();
  if (connection.lastEventAt !== previousEvent) {
    if (force && state.snapshot) apply(state.pending || state.snapshot, true);
    return;
  }
  accept(snapshot, force);
}
document.addEventListener('click', async event => {
  const route = event.target.closest('a[data-route]');
  if (route && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    if (route.classList.contains('brand') && $('personal-workspace').hidden) $('workspace-personal').click();
    navigate(route.getAttribute('href')); return;
  }
  const target = event.target.closest('button'); if (!target) return;
  if (target.dataset.view) { navigate(personalRoute(target.dataset.view, { ...state, requestId: null, workId: null, agentId: null, from: null })); return; }
  if (target.dataset.filter) { state.filter = target.dataset.filter; saveScope(); render(); [...document.querySelectorAll('[data-filter]')].find(button => button.dataset.filter === state.filter)?.focus({ preventScroll: true }); }
  if (target.dataset.review) openReview(target.dataset.review);
  if (target.dataset.detail) openDetail(target.dataset.detail);
  if (target.dataset.copyHandoff) {
    const row = rowById(target.dataset.copyHandoff); if (!row) return;
    const text = handoffText(row);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      $('handoff-feedback').textContent = t('handoffCopied');
      announce(t('handoffAnnounce'));
    } catch {
      const area = $('handoff-text'); area.hidden = false; area.value = text; area.focus(); area.select();
      $('handoff-feedback').textContent = t('clipboardUnavailable');
    }
  }
  if (target.dataset.check) await saveReview(target.dataset.check, true);
  if (target.dataset.undo) await saveReview(target.dataset.undo, false);
  if (target.dataset.connect) openConnection(target.dataset.connect);
  if (target.hasAttribute('data-close')) target.closest('dialog').close();
  if (target.dataset.evidenceKind) {
    const pre = target.closest('[data-evidence-record]')?.querySelector('pre') || $('raw-evidence'); if (!pre) return; pre.hidden = false; pre.textContent = t('loadingSource');
    try { const response = await fetch(`/api/work-view/evidence/${encodeURIComponent(target.dataset.evidenceKind)}/${encodeURIComponent(target.dataset.evidenceId)}`); if (!response.ok) throw new Error(); pre.textContent = JSON.stringify(await response.json(), null, 2); }
    catch { pre.textContent = t('sourceUnavailable'); }
  }
});
document.addEventListener('toggle', event => { if (event.target.matches('details[open][data-updates]')) markRead(event.target.dataset.updates); }, true);
$('search').addEventListener('input', event => { state.query = event.target.value.trim().toLowerCase(); saveScope(); render(); });
$('time-range').addEventListener('change', event => { state.range = event.target.value; saveScope(); render(); });
$('project-filter').addEventListener('change', event => { state.project = event.target.value; saveScope(); render(); $('project-filter').focus({ preventScroll: true }); });
$('sort').addEventListener('change', event => { state.sort = event.target.value; saveScope(); render(); });
for (const item of document.querySelectorAll('dialog')) item.addEventListener('click', event => { if (event.target === item) { const rect = item.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) item.close(); } });
Object.assign(state, parsePersonalRoute(location.hash)); syncControls();
if (location.hash !== '#teambrain') history.replaceState(null, '', personalRoute(state.view, state));
applyStaticTranslations(); document.documentElement.lang = locale();
render();
refresh().catch(() => { state.failed = true; renderConnection(); render(); });
const stream = new EventSource('/api/work-view/events');
stream.onopen = () => { connection.transportConnected = true; connection.reconnecting = false; renderConnection(); };
stream.addEventListener('work-view', event => {
  try {
    const snapshot = JSON.parse(event.data);
    if (!snapshot || !Array.isArray(snapshot.humanRequests) || typeof snapshot.source?.connected !== 'boolean') return;
    connection.transportConnected = true; connection.reconnecting = false; connection.lastEventAt = performance.now();
    accept(snapshot, false, true);
  } catch { /* Malformed messages cannot renew the live indicator. */ }
});
stream.addEventListener('heartbeat', event => {
  try {
    const beat = JSON.parse(event.data);
    if (!beat || typeof beat.source?.connected !== 'boolean') return;
    connection.transportConnected = true; connection.reconnecting = false; connection.lastEventAt = performance.now();
    received(); health(beat.source);
  } catch { /* Keep the last valid heartbeat; the freshness deadline still applies. */ }
});
stream.onerror = () => { connection.transportConnected = false; connection.reconnecting = true; renderConnection(); };
const timer = setInterval(() => {
  renderConnection();
  document.querySelectorAll('[data-time]').forEach(element => { element.textContent = `${element.dataset.timePrefix || ''}${relativeTime(Number(element.dataset.time))}`; });
  document.querySelectorAll('[data-request-elapsed]').forEach(element => { const row = rowById(element.dataset.requestElapsed); if (row) element.textContent = requestElapsed(row); });
}, 1000);
// Age recorded activity without a synthetic source event or a forced reorder.
const ageTimer = setInterval(() => {
  if (!state.snapshot || !state.rows.length) return;
  const aged = presentWork(state.snapshot, state.rows).rows;
  if (aged.some((row, index) => row.status !== state.rows[index]?.status)) apply(state.snapshot);
}, 60000);
function paintSync() { if (state.sync) $('sync-state').textContent = t(state.sync); }
fetch('/api/sync/status', { cache: 'no-store' }).then(response => response.ok ? response.json() : Promise.reject()).then(sync => { state.sync = sync.configured ? 'syncConfigured' : 'syncOff'; }).catch(() => { state.sync = 'syncUnavailable'; }).then(paintSync);
window.addEventListener('pagehide', () => { stream.close(); clearInterval(timer); clearInterval(ageTimer); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

setupTeamView();
$('workspace-personal').addEventListener('click', () => { history.replaceState(null, '', personalRoute(state.view, state)); });
const languageSelect = $('language-select');
languageSelect.value = locale();
languageSelect.addEventListener('change', event => setLocale(event.target.value));
// Rows carry text computed in the language they were built in, so rebuild them from the applied snapshot.
window.addEventListener('claude-mem-locale-change', () => {
  languageSelect.value = locale();
  if (state.applied) state.rows = presentWork(state.applied, state.rows).rows;
  if (state.pending) pendingBanner();
  renderConnection(); paintReceived(); paintSync(); render();
});

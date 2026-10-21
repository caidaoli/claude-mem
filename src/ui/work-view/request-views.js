import { activityFor, cleanText, relativeTime, requestElapsed, STATUS } from './view-model.js';
import { effectiveStatus } from './presentation.js';
import { t, dateLocale } from './i18n.js';

export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const esc = escapeHTML;
const labels = { working: 'working', needs: 'needs', ready: 'ready', checked: 'checked' };
const chevron = '<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="m9 5 7 7-7 7" stroke="currentColor" stroke-width="1.7"/></svg>';
// Worktree checkouts record "repo/worktree"; people know the repo.
const projectLabel = project => String(project || t('unknownProject')).split('/')[0];
const evidenceKinds = { 'work-state': 'kindWorkState', observation: 'kindObservation', prompt: 'kindPrompt', summary: 'kindSummary', session: 'kindSession' };
const projectNames = row => [...new Set((row.projects || [row.project]).filter(Boolean).map(projectLabel))].join(' · ');

export function personalRoute(view, state = {}) {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries({ id: view === 'request' ? state.requestId : null, work: view === 'request' ? state.workId : null, agent: state.agentId, from: view === 'request' ? state.from : null, project: state.project, range: state.range, sort: state.sort, status: state.filter, q: state.query })) {
    if (value && !((key === 'range' && value === 'day') || (key === 'sort' && value === 'attention') || (key === 'status' && value === 'all'))) parameters.set(key, value);
  }
  return `#${view}${parameters.size ? `?${parameters}` : ''}`;
}

export function parsePersonalRoute(hash) {
  const [rawView, query = ''] = hash.replace(/^#/, '').split('?');
  const parameters = new URLSearchParams(query);
  const view = ['cards', 'list', 'agents', 'request'].includes(rawView) ? rawView : rawView === 'board' ? 'list' : 'cards';
  return { view, requestId: parameters.get('id'), workId: parameters.get('work'), agentId: parameters.get('agent'),
    from: ['cards', 'list', 'agents'].includes(parameters.get('from')) ? parameters.get('from') : 'cards',
    project: parameters.get('project') || '', range: ['all', 'week'].includes(parameters.get('range')) ? parameters.get('range') : 'day',
    sort: ['latest', 'oldest', 'title'].includes(parameters.get('sort')) ? parameters.get('sort') : 'attention',
    filter: ['working', 'needs', 'ready', 'checked', 'quiet', 'blocked', 'todo', 'unknown', 'closed', 'other'].includes(parameters.get('status')) ? parameters.get('status') : 'all', query: parameters.get('q') || '' };
}

export function badge(row) {
  const status = effectiveStatus(row);
  const shape = status === 'needs' ? '!' : ['ready', 'checked'].includes(status) ? '✓' : '';
  return `<span class="status status-${esc(status)}"><span class="status-icon" aria-hidden="true">${shape}</span>${esc(labels[status] ? t(labels[status]) : row.sourceLabel || STATUS[status]?.label || t('unknown'))}</span>`;
}
const time = updated => {
  const epoch = Number(updated) || 0;
  return `<time class="card-time" data-time="${epoch}"${epoch > 0 ? ` datetime="${new Date(epoch).toISOString()}" title="${esc(new Date(epoch).toLocaleString(dateLocale()))}"` : ''}>${esc(relativeTime(epoch))}</time>`;
};
// One line per tool, as on the approved cards: "Codex · 5 contributors".
export function contributors(agents = []) {
  const groups = new Map();
  for (const agent of agents) {
    const key = agent.platformSource || agent.label || 'Contributor';
    const group = groups.get(key) || { label: agent.label || t('contributor'), icon: agent.icon, count: 0 };
    group.count++; groups.set(key, group);
  }
  return [...groups.values()].map(group => `<span class="card-contributor">${group.icon ? `<img src="${esc(group.icon)}" width="25" height="25" alt="">` : ''}<span>${esc(group.label)}${group.count > 1 ? `<span class="contributor-count"> · ${esc(t('contributorCount', { count: group.count }))}</span>` : ''}</span></span>`).join('') || `<span class="contributor-count">${esc(t('noContributor'))}</span>`;
}
function copyNote(row) {
  return row.humanCopy && ['pending', 'outdated'].includes(row.copyState) ? `<small class="copy-note">${esc(t('summaryUpdating'))}</small>` : '';
}
function nextCopy(row) {
  if (effectiveStatus(row) === 'checked') return { label: t('checkedLocally'), text: t('checkedLocallyText') };
  const summary = String(row.activity || '').replace(/\s+/g, ' ').trim();
  const next = String(row.next || '').replace(/\s+/g, ' ').trim();
  return next && next !== summary ? { label: t(effectiveStatus(row) === 'needs' ? 'needs' : effectiveStatus(row) === 'ready' ? 'ready' : 'nextStep'), text: next } : null;
}
export function requestCards(rows, state) {
  return rows.map(row => {
    const next = nextCopy(row), status = effectiveStatus(row);
    const route = personalRoute('request', { ...state, requestId: row.id, workId: null, from: state.view });
    return `<article class="request-card work-card status-${esc(status)}${state.changed?.has(row.id) ? ' updated' : ''}" data-id="${esc(row.id)}" tabindex="-1"><a class="request-card-open" href="${esc(route)}" data-route>
      <div class="request-card-meta">${badge(row)}<span>${time(row.updated)}${state.unread?.has(row.id) ? `<span class="new-dot">${esc(t('newUpdate'))}</span>` : ''}</span></div>
      <div class="request-card-body"><div class="request-card-copy"><h2>${esc(row.title)}</h2><p class="request-card-summary">${esc(row.activity)}</p>${copyNote(row)}</div></div>
      <div class="request-card-context"><div class="request-contributors" aria-label="${esc(t('contributors'))}">${contributors(row.contributors)}</div><span class="card-project" title="${esc((row.projects || [row.project]).join(' · '))}">${esc(projectNames(row))}</span></div>
      <div class="request-card-footer${next ? '' : ' no-next'}">${next ? `<div><span class="card-next-label">${esc(next.label)}</span><p>${esc(next.text)}</p></div>` : ''}<span class="open-label">${esc(t(status === 'ready' ? 'reviewResult' : status === 'needs' ? 'readHandoff' : 'openRequest'))} ${chevron}</span></div>
    </a></article>`;
  }).join('');
}

export function requestList(rows, state) {
  const [status, request, next, updated] = ['status', 'request', 'nextOrOutcome', 'lastUpdate'].map(key => esc(t(key)));
  return `<div class="board-surface"><table class="work-table" aria-label="${esc(t('requests'))}"><thead><tr><th scope="col">${status}</th><th scope="col">${request}</th><th scope="col">${next}</th><th scope="col">${updated}</th><th scope="col"><span class="sr-only">${esc(t('openRequest'))}</span></th></tr></thead><tbody>${rows.map(row => {
    const route = personalRoute('request', { ...state, requestId: row.id, workId: null, from: 'list' });
    return `<tr class="work-row" data-id="${esc(row.id)}"><td data-label="${status}">${badge(row)}</td><td data-label="${request}"><a class="request-title" href="${esc(route)}" data-route>${esc(row.title)}</a><p class="project-name">${esc(projectNames(row))}</p></td><td data-label="${next}"><p class="next-copy">${esc(nextCopy(row)?.text || row.activity)}</p>${copyNote(row)}</td><td data-label="${updated}">${time(row.updated)}</td><td class="row-arrow"><a href="${esc(route)}" data-route aria-label="${esc(t('openRequestNamed', { title: row.title }))}">${chevron}</a></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

export function agentCards(rows, state) {
  const agents = new Map();
  for (const row of rows) for (const agent of row.contributors || []) {
    if (!agents.has(agent.id)) agents.set(agent.id, { agent, requests: [] });
    agents.get(agent.id).requests.push(row);
  }
  return [...agents.values()].map(({ agent, requests }) => {
    const latest = [...requests].sort((a, b) => b.updated - a.updated)[0];
    const route = personalRoute('agents', { ...state, agentId: agent.id, requestId: null, workId: null });
    return `<article class="agent-card"><a class="agent-open" href="${esc(route)}" data-route><div class="agent-top"><span class="agent-avatar">${agent.icon ? `<img src="${esc(agent.icon)}" width="32" height="32" alt="">` : esc((agent.label || '?').slice(0, 1))}</span><div class="agent-identity"><h2>${esc(agent.label)}</h2><p>${esc(agent.agentType && !['main', 'default'].includes(agent.agentType) ? agent.agentType : t('contributingRequests'))}</p></div>${time(latest.updated)}</div>${badge(latest)}<p class="agent-summary">${esc(latest.title)}</p><div class="agent-requests">${requests.slice(0, 2).map(row => `<p>${esc(row.activity)}</p>`).join('')}</div><div class="agent-footer"><span>${esc(t(requests.length === 1 ? 'humanRequest' : 'humanRequests', { count: requests.length }))}</span><span class="open-label">${esc(t('viewRequests'))} ${chevron}</span></div></a></article>`;
  }).join('') || `<div class="empty-work"><h3>${esc(t('noContributorsView'))}</h3><p>${esc(t('noContributorsText'))}</p></div>`;
}

export function sourceDisclosure(urls, label = t('originalSource')) {
  const sources = [...new Set(urls)].flatMap(url => {
    const match = String(url).match(/^\/api\/work-view\/evidence\/(work-state|observation|prompt|summary|session)\/(\d+)$/);
    return match ? [`<button type="button" class="source-link" data-evidence-kind="${match[1]}" data-evidence-id="${match[2]}">${esc(t('readSource', { kind: t(evidenceKinds[match[1]]), id: match[2] }))}</button>`] : [];
  }).join(' ');
  return sources ? `<details class="source-details" data-evidence-record><summary>${esc(label)}</summary><div class="source-content">${sources}<pre class="raw-source" hidden></pre></div></details>` : '';
}

export function requestFacts(row) {
  const started = Number.isFinite(row.startedAtEpoch) && row.startedAtEpoch > 0
    ? new Date(row.startedAtEpoch).toLocaleString(dateLocale(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : t('notRecorded');
  return `<dl class="request-facts"><div><dt>${esc(t('contributors'))}</dt><dd class="request-contributors">${contributors(row.contributors)}</dd></div>${row.requestedBy ? `<div><dt>${esc(t('requestedBy'))}</dt><dd>${esc(row.requestedBy)}</dd></div>` : ''}<div><dt>${esc(t('started'))}</dt><dd>${esc(started)}</dd></div><div><dt>${esc(t(row.completedAtEpoch ? 'timeToCompletion' : 'elapsed'))}</dt><dd data-request-elapsed="${esc(row.id)}" title="${esc(t('elapsedTitle'))}">${esc(requestElapsed(row))}</dd></div><div><dt>${esc(t('stage'))}</dt><dd>${esc(row.stage || t('notRecorded'))}</dd></div><div><dt>${esc(t('shipEstimate'))}</dt><dd>${esc(row.shipEstimate || t('notEstimated'))}</dd></div></dl>`;
}

export function afterShip(row) {
  const data = row.afterShip || {};
  const sources = item => sourceDisclosure((item.sourceRefs || []).map(ref => `/api/work-view/evidence/${ref.kind}/${ref.id}`), t('recordedSource'));
  const links = kind => (data.resources || []).filter(item => item.kind === kind).flatMap(item => {
    try {
      const url = new URL(item.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
      return [`<li><a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(t(kind === 'documentation' ? 'openDocumentation' : 'openPromotion'))}</a>${sources(item)}</li>`];
    } catch { return []; }
  }).join('');
  const docs = links('documentation'), promo = links('promotion');
  const categories = (data.classifications || []).map(item => `<li>${esc(cleanText(item.text, 160))}${sources(item)}</li>`).join('');
  const group = (title, items, empty) => `<section class="after-ship-group"><h3>${esc(t(title))}</h3>${items ? `<ul>${items}</ul>` : `<p class="empty-copy">${esc(t(empty))}</p>`}</section>`;
  return `<section class="after-ship"><h2>${esc(t('afterShip'))}</h2><p>${esc(t('afterShipIntro'))}</p><div class="after-ship-grid">${group('documentation', docs, 'noDocumentation')}${group('promotion', promo, 'noPromotion')}${group('classification', categories, 'notClassified')}</div>${(data.notes || []).map(note => `<div class="after-ship-note"><p>${esc(cleanText(note.text, 220))}</p>${sources(note)}</div>`).join('')}</section>`;
}

export function requestPage(row, state) {
  return `<div class="request-page"><div class="request-heading"><h1 tabindex="-1">${esc(row.title)}</h1><div class="request-meta">${badge(row)}<span>${esc(projectNames(row))}</span>${time(row.updated)}</div>${requestFacts(row)}</div>
    <section class="request-overview"><h2>${esc(t('whereItStands'))}</h2><p>${esc(row.activity)}</p>${copyNote(row)}<p class="request-next"><strong>${esc(t('labelColon', { label: nextCopy(row)?.label || t('nextStep') }))}</strong> ${esc(nextCopy(row)?.text || row.next)}</p><details class="original-request"><summary>${esc(t('originalRequestHeading'))}</summary><div class="original-body"><p>${esc(row.original?.text)}</p>${sourceDisclosure([row.original?.url], t('readFullOriginal'))}</div></details></section>
    <div class="section-heading"><h2>${esc(t('workBehind'))}</h2></div><div class="workstream-list">${row.workstreams.map(work => `<article class="workstream-row"><a class="workstream-open" href="${esc(personalRoute('request', { ...state, requestId: row.id, workId: work.id }))}" data-route><div class="workstream-text"><h3>${esc(work.title)}</h3><p>${esc(work.summary)}</p><div class="request-contributors">${contributors(work.contributors)}</div></div>${badge({ status: work.status })}${chevron}</a></article>`).join('') || `<p class="empty-work">${esc(t('noWorkstreams'))}</p>`}</div>
    ${row.scopeUpdates?.length ? `<details class="original-request"><summary>${esc(t('followUps'))}</summary><div class="original-body">${row.scopeUpdates.map(update => `<p>${esc(update.text)}</p>${sourceDisclosure([update.url])}`).join('')}</div></details>` : ''}
    <div class="request-actions">${effectiveStatus(row) === 'ready' ? `<button type="button" class="button-primary" data-review="${esc(row.id)}">${esc(t('reviewResult'))}</button>` : effectiveStatus(row) === 'checked' ? `<button type="button" class="button-secondary" data-undo="${esc(row.id)}">${esc(t('undoCheck'))}</button>` : ''}<button type="button" class="button-secondary" data-copy-handoff="${esc(row.id)}">${esc(t('copyHandoff'))}</button><a class="source-link" href="/viewer">${esc(t('memorySessions'))}</a></div><p class="dialog-note" id="handoff-feedback" role="status"></p><label class="sr-only" for="handoff-text">${esc(t('handoffTextLabel'))}</label><textarea class="raw-source" id="handoff-text" readonly rows="9" hidden></textarea>${afterShip(row)}
  </div>`;
}

export function workstreamPage(row, work) {
  const activity = activityFor(work, null, 100);
  return `<div class="records-page"><div class="request-heading"><h1 tabindex="-1">${esc(work.title)}</h1><div class="request-meta">${badge({ status: work.status })}<div class="request-contributors">${contributors(work.contributors)}</div></div></div><div class="records-intro"><p>${esc(work.summary)}</p></div><div class="section-heading"><h2>${esc(t('recordedChanges'))}</h2></div><ul class="records-list">${activity.map(item => `<li><div class="record-meta">${time(item.atEpoch)}<span>${esc(t(item.kind === 'work-state' ? 'workUpdate' : 'observation'))}</span></div><div class="record-copy"><p>${esc(item.title || item.detail)}</p>${item.detail && item.detail !== item.title ? `<p class="record-detail">${esc(item.detail)}</p>` : ''}</div>${sourceDisclosure([item.url])}</li>`).join('') || `<li>${esc(t('noDetailedUpdates'))}</li>`}</ul></div>`;
}

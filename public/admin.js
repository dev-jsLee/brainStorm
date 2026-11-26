// brainStorm 관리 화면(기획 대조 3단계): 감사 기록(n76) · 에이전트 연결(기획서 2.1 → «에이전트 연결 상태», 마스터 결정 1·2) · 멤버 권한.
// runs.js 처럼 함수만 정의한다 — 호출은 app.js 의 라우터가 한다. app.js 의 전역($·S·el·api·ask·notify·announce…)을 쓴다.
// 토큰 발급은 화면에 없다(결정 2 — CT 안 CLI → 600 파일). 연결 화면은 조회·폐기만.
'use strict';

/** 작업 유형 → 화면 문구 */
const AUDIT_ACTION = {
  'auth.login': t('admin.action.auth.login'),
  'auth.token': t('admin.action.auth.token'),
  'credential.create': t('admin.action.credential.create'),
  'credential.revoke': t('admin.action.credential.revoke'),
  'participant.create': t('admin.action.participant.create'),
  'participant.rename': t('admin.action.participant.rename'),
  'passphrase.set': t('admin.action.passphrase.set'),
  'websession.create': t('admin.action.websession.create'),
  'websession.revoke': t('admin.action.websession.revoke'),
  'websession.revoke_all': t('admin.action.websession.revoke_all'),
  'thread.create': t('admin.action.thread.create'),
  'thread.fork': t('admin.action.thread.fork'),
  'thread.read': t('admin.action.thread.read'),
  'thread.post': t('admin.action.thread.post'),
  'thread.stop': t('admin.action.thread.stop'),
  'thread.resume': t('admin.action.thread.resume'),
  'thread.archive': t('admin.action.thread.archive'),
  'thread.unarchive': t('admin.action.thread.unarchive'),
  'thread.hide': t('admin.action.thread.hide'),
  'thread.unhide': t('admin.action.thread.unhide'),
  'thread.trash': t('admin.action.thread.trash'),
  'thread.restore': t('admin.action.thread.restore'),
  'thread.purge': t('admin.action.thread.purge'),
  'member.set': t('admin.action.member.set'),
  'member.remove': t('admin.action.member.remove'),
  'session.rotate': t('admin.action.session.rotate'),
  'run.cancel': t('admin.action.run.cancel'),
  'run.read': t('admin.action.run.read'),
  'run.refresh': t('admin.action.run.refresh'),
  'runs.view': t('admin.action.runs.view'),
  'delivery.cancel': t('admin.action.delivery.cancel'),
  'request.create': t('admin.action.request.create'),
  'request.hold': t('admin.action.request.hold'),
  'request.hold_ack': t('admin.action.request.hold_ack'),
  'request.holds_view': t('admin.action.request.holds_view'),
  'request_pair.add': t('admin.action.request_pair.add'),
  'request_pair.remove': t('admin.action.request_pair.remove'),
  'audit.view': t('admin.action.audit.view'),
  'connections.view': t('admin.action.connections.view'),
  'agents.view': t('admin.action.agents.view'),
  'agents.model': t('admin.action.agents.model'),
  'attachment.add': t('admin.action.attachment.add'),
  'attachment.read': t('admin.action.attachment.read'),
  'adapter.claim': t('admin.action.adapter.claim'),
  'adapter.ack': t('admin.action.adapter.ack'),
  'adapter.run': t('admin.action.adapter.run'),
};
/** 이벤트 유형 필터의 묶음(정책 9 적용 범위 순) */
const AUDIT_GROUPS = [
  ['credential.*', t('admin.group.credential')],
  ['member.*', t('admin.group.member')],
  ['session.rotate', t('admin.group.session_rotate')],
  ['run.cancel', t('admin.group.run_cancel')],
  ['request.*', t('admin.group.request')],
  ['auth.*', t('admin.group.auth')],
  ['audit.view', t('admin.group.audit_view')],
];
const AUDIT_RESULT = { ok: t('admin.result.ok'), requested: t('admin.result.requested'), noop: t('admin.result.noop'), denied: t('admin.result.denied'), failed: t('admin.result.failed') };
/** 사유 코드 → 화면 문구. 모르는 코드는 코드 그대로 */
const AUDIT_REASON = {
  token_revoked: t('admin.reason.token_revoked'),
  token_expired: t('admin.reason.token_expired'),
  token_unknown: t('admin.reason.token_unknown'),
  token_malformed: t('admin.reason.token_malformed'),
  participant_disabled: t('admin.reason.participant_disabled'),
  not_member: t('admin.reason.not_member'),
  master_only: t('admin.reason.master_only'),
  adapter_scope_required: t('admin.reason.adapter_scope_required'),
  impersonation: t('admin.reason.impersonation'),
  no_post_permission: t('admin.reason.no_post_permission'),
  no_invoke_permission: t('admin.reason.no_invoke_permission'),
  agent_invocation_disabled: t('admin.reason.agent_invocation_disabled'),
  request_pair_not_allowed: t('admin.reason.request_pair_not_allowed'),
  request_chain_limit: t('admin.reason.request_chain_limit'),
  invoke_paused: t('admin.reason.invoke_paused'),
  already_acked: t('admin.reason.already_acked'),
  already_allowed: t('admin.reason.already_allowed'),
  not_allowed: t('admin.reason.not_allowed'),
  source_kind_forbidden: t('admin.reason.source_kind_forbidden'),
  bad_input_mode: t('admin.reason.bad_input_mode'),
  not_owner: t('admin.reason.not_owner'),
  not_author: t('admin.reason.not_author'),
  bad_passphrase: t('admin.reason.bad_passphrase'),
  too_many_attempts: t('admin.reason.too_many_attempts'),
  already_revoked: t('admin.reason.already_revoked'),
  no_credential: t('admin.reason.no_credential'),
  unchanged: t('admin.reason.unchanged'),
  duplicate: t('admin.reason.duplicate'),
  already_requested: t('admin.reason.already_requested'),
  already_final: t('admin.reason.already_final'),
  queued_cancelled: t('admin.reason.queued_cancelled'),
  acked: t('admin.reason.acked'),
  no_ack: t('admin.reason.no_ack'),
  completed_first: t('admin.reason.completed_first'),
  failed_first: t('admin.reason.failed_first'),
  lease_expired: t('admin.reason.lease_expired'),
  rotated: t('admin.reason.rotated'),
  has_run: t('admin.reason.has_run'),
  bad_member: t('admin.reason.bad_member'),
  bad_agent: t('admin.reason.bad_agent'),
  weak_passphrase: t('admin.reason.weak_passphrase'),
  not_agent: t('admin.reason.not_agent'),
  stop_new: t('admin.reason.stop_new'),
  cancel_current: t('admin.reason.cancel_current'),
  no_session: t('admin.reason.no_session'),
};
/** 상태 칸(before/after) 키 → 화면 문구 */
const AUDIT_KEY = {
  state: t('admin.key.state'),
  status: t('admin.key.status'),
  member: t('admin.key.member'),
  can_read: t('admin.key.can_read'),
  can_post: t('admin.key.can_post'),
  can_invoke: t('admin.key.can_invoke'),
  generation: t('admin.key.generation'),
  session_id: t('admin.key.session_id'),
  cancelled_runs: t('admin.key.cancelled_runs'),
  cancel_requested_runs: t('admin.key.cancel_requested_runs'),
  withdrawn_deliveries: t('admin.key.withdrawn_deliveries'),
  invoke_paused: t('admin.key.invoke_paused'),
  participant_id: t('admin.key.participant_id'),
  label: t('admin.key.label'),
  scope: t('admin.key.scope'),
  expires_at: t('admin.key.expires_at'),
  revoked_at: t('admin.key.revoked_at'),
  members: t('admin.key.members'),
  default_recipient: t('admin.key.default_recipient'),
  parent_thread_id: t('admin.key.parent_thread_id'),
  fork_seq: t('admin.key.fork_seq'),
  included: t('admin.key.included'),
  reason: t('admin.key.reason'),
  confirmed_by: t('admin.key.confirmed_by'),
  ack_limit_ms: t('admin.key.ack_limit_ms'),
  cancel_requested: t('admin.key.cancel_requested'),
  via: t('admin.key.via'),
  ip: t('admin.key.ip'),
  filters: t('admin.key.filters'),
  page: t('admin.key.page'),
  kind: t('admin.key.kind'),
  is_master: t('admin.key.is_master'),
  room_member: t('admin.key.room_member'),
  name: t('admin.key.name'),
  minutes: t('admin.key.minutes'),
  removed: t('admin.key.removed'),
  web_sessions_removed: t('admin.key.web_sessions_removed'),
  run_id: t('admin.key.run_id'),
  recipient_id: t('admin.key.recipient_id'),
  message_seq: t('admin.key.message_seq'),
  status_code: t('admin.key.status_code'),
};

function actorLabel(id, kind) {
  if (kind === 'cli' || id === 'cli:root') return t('admin.actor_cli');
  if (kind === 'server' || id === 'server') return t('admin.actor_server');
  if (kind === 'anonymous' || id === 'anonymous') return t('admin.actor_unknown');
  const p = S.participants.get(id);
  if (!p) return id;
  return p.is_master ? t('admin.actor_master', { name: p.name }) : p.name;
}
function auditActionLabel(a) {
  return AUDIT_ACTION[a] ?? a;
}
function fmtVal(k, v) {
  if (v === null || v === undefined) return t('admin.none');
  if (typeof v === 'boolean') return v ? t('admin.yes') : t('admin.no');
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'string' ? pname(x) : String(x))).join(', ') : t('admin.none');
  if (typeof v === 'object') return Object.entries(v).map(([kk, vv]) => `${AUDIT_KEY[kk] ?? kk} ${fmtVal(kk, vv)}`).join(' · ');
  if (typeof v === 'number' && /_at$/.test(k)) return when(v);
  if (k === 'ack_limit_ms') return t('admin.seconds', { n: Math.round(v / 1000) });
  if (k === 'state') return STATE[v] ?? v;
  if (k === 'participant_id' || k === 'confirmed_by' || k === 'recipient_id' || k === 'default_recipient') return pname(v);
  if (k === 'parent_thread_id') return threadById(v)?.title ?? v;
  if (k === 'reason' && AUDIT_REASON[v]) return AUDIT_REASON[v];
  return String(v);
}
function stateKv(obj) {
  if (!obj) return el('span', { class: 'faint' }, '—');
  const ent = Object.entries(obj);
  if (!ent.length) return el('span', { class: 'faint' }, '—');
  return el('span', { class: 'statekv' }, ...ent.flatMap(([k, v], i) => [i ? ' · ' : null, el('span', { class: 'faint' }, `${AUDIT_KEY[k] ?? k} `), fmtVal(k, v)]));
}
function auditTarget(e) {
  const owner = e.after?.participant_id ?? e.before?.participant_id;
  const th = e.thread_id ? threadById(e.thread_id) : null;
  const parts = [];
  if (e.target_type === 'credential') parts.push(`${t('admin.tgt_credential', { id: e.target_id })}${owner ? ` · ${pname(owner)}` : ''}`);
  else if (e.target_type === 'participant' || e.target_type === 'agent') parts.push(e.target_id ? t(e.target_type === 'agent' ? 'admin.tgt_agent' : 'admin.tgt_participant', { name: pname(e.target_id) }) : t('admin.participant'));
  else if (e.target_type === 'thread') parts.push(th ? '' : t('admin.tgt_thread', { id: e.target_id }));
  else if (e.target_type === 'run') parts.push(t('admin.tgt_run', { id: shortId(e.target_id) }));
  else if (e.target_type === 'delivery') parts.push(t('admin.tgt_delivery', { id: shortId(e.target_id) }));
  else if (e.target_type === 'audit') parts.push(t('admin.audit_log'));
  else if (e.target_type === 'web_session') parts.push(t('admin.web_session'));
  else if (e.target_type) parts.push(`${e.target_type} ${e.target_id ?? ''}`);
  const scope = th ? convLabel(th.kind, th.title) : e.thread_id ? el('span', { class: 'faint' }, t('admin.tgt_thread', { id: shortId(e.thread_id) })) : null;
  const txt = parts.filter(Boolean).join(' ');
  if (!txt && !scope) return el('span', { class: 'faint' }, '—');
  return el('span', { class: 'tgt' }, txt, txt && scope ? el('span', { class: 'faint' }, ' · ') : null, scope);
}
function resultBadge(e) {
  return el('span', { class: `badge au-${e.result}` }, AUDIT_RESULT[e.result] ?? e.result);
}

// ───── 감사 기록 (n76) ─────
function auQuery() {
  return S.au ?? (S.au = { q: '', action: '', actor: '', result: '', since: store('bs.audit-since') ?? 'today', thread: '', corr: '', page: 1 });
}
async function showAudit(params) {
  const q = auQuery();
  if (params) {
    for (const k of ['q', 'action', 'actor', 'result', 'since', 'thread', 'corr']) q[k] = params.has(k) ? params.get(k) ?? '' : k === 'since' ? q.since : '';
    q.page = Math.max(1, Number(params.get('page')) || 1);
  }
  $('au-h').focus();
  await loadAudit();
}
function auSinceMs(v) {
  if (!v) return null;
  if (v === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return Date.now() - Number(v);
}
function auHash() {
  const q = auQuery();
  const p = new URLSearchParams();
  for (const k of ['q', 'action', 'actor', 'result', 'thread', 'corr']) if (q[k]) p.set(k, q[k]);
  p.set('since', q.since);
  if (q.page > 1) p.set('page', String(q.page));
  return `audit?${p}`;
}
function onAuditFilter(resetPage = true) {
  const q = auQuery();
  q.q = $('af-q').value.trim();
  q.action = $('af-action').value;
  q.actor = $('af-actor').value;
  q.result = $('af-result').value;
  q.since = $('af-since').value;
  if (resetPage) q.page = 1;
  store('bs.audit-since', q.since);
  history.replaceState(null, '', `#${auHash()}`);
  loadAudit();
}
let auSeq = 0;
async function loadAudit() {
  const q = auQuery();
  const p = new URLSearchParams();
  for (const k of ['q', 'action', 'actor', 'result', 'thread', 'corr']) if (q[k]) p.set(k, q[k]);
  const since = auSinceMs(q.since);
  if (since) p.set('since', String(since));
  p.set('page', String(q.page));
  p.set('limit', '50');
  const my = ++auSeq;
  let r;
  try {
    r = await api('GET', `/api/audit?${p}`);
  } catch (e) {
    if (my === auSeq) $('au-table').replaceChildren(el('p', { class: 'err' }, t('admin.audit_load_failed', { error: e.message })));
    return;
  }
  if (my !== auSeq) return;
  S.auData = r;
  S.auOpen = null;
  fillAuditFilters();
  renderAuditTable();
}
function fillAuditFilters() {
  const q = auQuery();
  const r = S.auData;
  const known = new Set(AUDIT_GROUPS.map((g) => g[0]));
  const acts = [...new Set([...(r?.actions ?? []), ...(q.action && !known.has(q.action) ? [q.action] : [])])].sort();
  $('af-action').replaceChildren(
    el('option', { value: '' }, t('admin.all')),
    el('optgroup', { label: t('admin.filter_groups') }, ...AUDIT_GROUPS.map(([v, label]) => el('option', { value: v }, label))),
    el('optgroup', { label: t('admin.filter_single') }, ...acts.map((a) => el('option', { value: a }, `${auditActionLabel(a)} (${a})`))),
  );
  const actors = [...(r?.actors ?? [])];
  if (q.actor && !actors.some((a) => a.id === q.actor)) actors.push({ id: q.actor, kind: '' });
  $('af-actor').replaceChildren(el('option', { value: '' }, t('admin.all')), ...actors.map((a) => el('option', { value: a.id }, actorLabel(a.id, a.kind))));
  $('af-q').value = q.q;
  $('af-action').value = q.action;
  $('af-actor').value = q.actor;
  $('af-result').value = q.result;
  $('af-since').value = q.since;
  const chips = [];
  const drop = (k) => () => {
    q[k] = '';
    q.page = 1;
    history.replaceState(null, '', `#${auHash()}`);
    loadAudit();
  };
  if (q.thread) {
    const th = threadById(q.thread);
    chips.push(el('span', { class: 'chip on' }, t('admin.chip_thread', { title: th ? th.title : q.thread }), el('button', { type: 'button', class: 'icon', 'aria-label': t('admin.chip_thread_clear'), onclick: drop('thread') }, '×')));
  }
  if (q.corr) chips.push(el('span', { class: 'chip on' }, t('admin.chip_corr', { id: q.corr }), el('button', { type: 'button', class: 'icon', 'aria-label': t('admin.chip_corr_clear'), onclick: drop('corr') }, '×')));
  $('af-chips').replaceChildren(...chips);
}
function auditWhen(e) {
  return el(
    'span',
    {},
    when(e.requested_at),
    e.repeat_count > 1 ? el('div', { class: 'faint small' }, t('admin.repeat_more', { n: e.repeat_count - 1, at: when(e.last_at) })) : null,
  );
}
function auditDetail(e) {
  return el(
    'div',
    { class: 'au-detail' },
    kvList(
      [t('admin.corr_id'), el('span', {}, el('code', {}, e.corr_id), ' ', el('a', { href: `#audit?corr=${encodeURIComponent(e.corr_id)}&since=` }, t('admin.related_entries')))],
      [t('admin.action_type'), `${auditActionLabel(e.action)} (${e.action})`],
      [t('admin.actor'), `${actorLabel(e.actor_id, e.actor_kind)} — ${e.actor_id}`],
      [t('admin.target'), e.target_id ? `${e.target_type} ${e.target_id}` : e.target_type ?? '—'],
      e.thread_id ? [t('admin.thread_scope'), el('a', { href: `#${e.thread_id}` }, threadById(e.thread_id)?.title ?? e.thread_id)] : null,
      [t('admin.requested_at'), when(e.requested_at)],
      [t('admin.processed_at'), when(e.processed_at)],
      [t('admin.result'), el('span', {}, resultBadge(e), e.reason ? ` ${AUDIT_REASON[e.reason] ?? e.reason} (${e.reason})` : '')],
      e.repeat_count > 1 ? [t('admin.grouped'), t('admin.grouped_text', { n: e.repeat_count, at: when(e.last_at) })] : null,
      [t('admin.before'), stateKv(e.before)],
      [t('admin.after'), stateKv(e.after)],
    ),
  );
}
function closeAuditDetail() {
  if (S.mode !== 'audit' || !S.auOpen) return;
  S.auOpen = null;
  renderAuditTable();
}
function renderAuditTable() {
  const r = S.auData;
  if (!r) return;
  $('au-total').textContent = t('admin.total', { n: r.total.toLocaleString(I18N.locale) });
  const narrow = isNarrow();
  if (!r.entries.length) {
    $('au-table').replaceChildren(el('p', { class: 'muted empty-runs' }, t('admin.audit_empty')));
  } else if (narrow) {
    $('au-table').replaceChildren(
      el(
        'ul',
        { class: 'rcards' },
        ...r.entries.map((e) => {
          const open = S.auOpen === e.id;
          return el(
            'li',
            { class: `rcard au-row-${e.result}`, 'data-id': String(e.id) },
            el('div', { class: 'rc1' }, resultBadge(e), el('b', {}, auditActionLabel(e.action)), el('span', { class: 'faint' }, '·'), actorLabel(e.actor_id, e.actor_kind)),
            el('div', { class: 'rc2 muted small' }, auditWhen(e), ' · ', auditTarget(e), e.reason ? ` · ${AUDIT_REASON[e.reason] ?? e.reason}` : ''),
            el('div', { class: 'rc3' }, auditToggle(e, open)),
            open ? auditDetail(e) : null,
          );
        }),
      ),
    );
  } else {
    const rows = [];
    for (const e of r.entries) {
      const open = S.auOpen === e.id;
      rows.push(
        el(
          'tr',
          { class: `au-row-${e.result}${open ? ' open' : ''}`, 'data-id': String(e.id) },
          el('td', { class: 'c-at' }, auditWhen(e)),
          el('td', { class: 'c-act' }, auditActionLabel(e.action), el('div', { class: 'faint small' }, e.action)),
          el('td', { class: 'c-actor' }, actorLabel(e.actor_id, e.actor_kind)),
          el('td', { class: 'c-tgt' }, auditTarget(e)),
          el('td', { class: 'c-res' }, resultBadge(e), e.reason ? el('div', { class: 'small' }, AUDIT_REASON[e.reason] ?? e.reason) : null),
          el('td', { class: 'c-more' }, auditToggle(e, open)),
        ),
      );
      if (open) rows.push(el('tr', { class: 'au-open' }, el('td', { colspan: '6' }, auditDetail(e))));
    }
    $('au-table').replaceChildren(
      el(
        'table',
        { class: 'rtable autable' },
        el('thead', {}, el('tr', {}, ...[t('admin.th_time'), t('admin.th_event'), t('admin.actor'), t('admin.th_target'), t('admin.result'), t('admin.th_detail')].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, ...rows),
      ),
    );
  }
  renderAuditPager();
}
function auditToggle(e, open) {
  return el(
    'button',
    {
      type: 'button',
      class: 'small-btn au-more',
      'aria-expanded': String(open),
      onclick: () => {
        S.auOpen = open ? null : e.id;
        renderAuditTable();
      },
    },
    open ? t('admin.collapse') : t('admin.view'),
  );
}
function renderAuditPager() {
  const r = S.auData;
  const q = auQuery();
  const go = (n) => () => {
    q.page = n;
    history.replaceState(null, '', `#${auHash()}`);
    loadAudit();
    $('au-h').focus();
  };
  if (r.pages <= 1) return $('au-pages').replaceChildren();
  const nums = new Set([1, r.pages, r.page - 1, r.page, r.page + 1].filter((n) => n >= 1 && n <= r.pages));
  const list = [...nums].sort((a, b) => a - b);
  const items = [];
  items.push(el('button', { type: 'button', disabled: r.page <= 1, onclick: go(r.page - 1) }, t('admin.prev')));
  list.forEach((n, i) => {
    if (i && n - list[i - 1] > 1) items.push(el('span', { class: 'faint' }, '…'));
    items.push(el('button', { type: 'button', class: n === r.page ? 'cur' : '', 'aria-current': n === r.page ? 'page' : null, onclick: go(n) }, String(n)));
  });
  items.push(el('button', { type: 'button', disabled: r.page >= r.pages, onclick: go(r.page + 1) }, t('admin.next')));
  $('au-pages').replaceChildren(...items);
}

// ───── 에이전트 연결 (기획서 2.1 재해석) ─────
async function showAgents() {
  $('ag-h').focus();
  await loadConnections();
}
let agSeq = 0;
async function loadConnections() {
  const my = ++agSeq;
  let r;
  try {
    r = await api('GET', '/api/connections');
  } catch (e) {
    if (my === agSeq) $('ag-list').replaceChildren(el('p', { class: 'err' }, t('admin.conn_load_failed', { error: e.message })));
    return;
  }
  if (my !== agSeq) return;
  S.conn = r;
  S.agents = new Map(r.agents.map((a) => [a.id, a]));
  $('ag-checked').textContent = t('admin.last_checked', { at: when(r.now) });
  renderConnections();
}
const DENY_TXT = { token_revoked: t('admin.deny.token_revoked'), token_expired: t('admin.deny.token_expired'), participant_disabled: t('admin.deny.participant_disabled') };
/** 연결 준비 상태(2.1 «초기 설정 · 연결 중 · 준비 완료 · 연결 실패»를 서버가 아는 신호로) */
function readiness(a) {
  if (a.state === 'no_credential') return { cls: 'off', word: t('admin.rd.no_credential'), text: t('admin.rd.no_credential_text') };
  if (a.state === 'revoked') return { cls: 'off', word: t('admin.revoked'), text: a.last_seen_at ? t('admin.rd.revoked_text_seen', { ago: rel(a.last_seen_at) }) : t('admin.rd.revoked_text') };
  if (a.state === 'never') return { cls: '', word: t('admin.rd.never'), text: t('admin.rd.never_text') };
  const age = Date.now() - a.last_seen_at;
  if (age < 60_000) return { cls: 'on', word: t('admin.rd.on'), text: t('admin.rd.on_text', { n: Math.max(1, Math.floor(age / 1000)) }) };
  return { cls: 'stale', word: t('admin.rd.stale'), text: t('admin.rd.stale_text', { ago: rel(a.last_seen_at) }) };
}
/** «폐기된 에이전트 숨기기» — 유효한 토큰이 하나도 없는(state revoked) 에이전트를 목록에서 뺀다. 이 브라우저에만 기억(기본 숨김) */
const AG_HIDE_KEY = 'bs.agents.hideRevoked';
const credStatusLabel = (s) => ({ active: t('admin.cred_active'), revoked: t('admin.revoked'), expired: t('admin.cred_expired') })[s];
const agHideRevoked = () => store(AG_HIDE_KEY) !== '0';
function renderConnections() {
  const r = S.conn;
  if (!r) return;
  if (!r.agents.length) return $('ag-list').replaceChildren(el('p', { class: 'muted' }, t('admin.no_agents')));
  const hide = agHideRevoked();
  $('ag-hide-revoked').checked = hide;
  const hidden = hide ? r.agents.filter((a) => a.state === 'revoked') : [];
  const shown = r.agents.filter((a) => !hidden.includes(a));
  const showAll = () => {
    store(AG_HIDE_KEY, '0');
    renderConnections();
  };
  $('ag-list').replaceChildren(
    hidden.length
      ? el('p', { class: 'muted small ag-hidden-note' }, `${t('admin.hidden_revoked', { n: hidden.length, names: hidden.map((a) => a.name).join(', ') })} `, el('button', { type: 'button', class: 'small-btn', onclick: showAll }, t('admin.show_hidden')))
      : null,
    shown.length ? null : el('p', { class: 'muted' }, t('admin.no_visible_agents')),
    ...shown.map((a) => {
      const rd = readiness(a);
      const credRows = a.credential_list.map((c) =>
        el(
          'tr',
          { class: c.status === 'active' ? '' : 'dim', 'data-cred': c.id },
          el('td', {}, c.label ?? el('span', { class: 'faint' }, t('admin.no_label')), el('div', { class: 'faint small' }, el('code', {}, c.id))),
          el('td', {}, el('span', { class: `badge cr-${c.status}` }, credStatusLabel(c.status))),
          el('td', {}, when(c.created_at)),
          el('td', {}, c.status === 'revoked' ? when(c.revoked_at) : c.expires_at ? when(c.expires_at) : el('span', { class: 'faint' }, t('admin.none'))),
          el('td', {}, c.last_used_at ? `${when(c.last_used_at)} (${rel(c.last_used_at)})` : el('span', { class: 'faint' }, t('admin.never_used'))),
          el('td', {}, c.status === 'active' ? el('button', { type: 'button', class: 'danger small-btn', onclick: () => revokeAsk(a, c) }, t('admin.revoke')) : el('span', { class: 'faint' }, '—')),
        ),
      );
      const deniedLink = `#audit?actor=${encodeURIComponent(a.id)}&action=auth.token&result=denied&since=`;
      return el(
        'section',
        { class: 'dcard ag-card', 'data-agent': a.id },
        el(
          'div',
          { class: 'ag-head' },
          el('span', { class: `dot ${rd.cls}`, 'aria-hidden': 'true' }),
          el('h3', {}, a.name),
          el('code', { class: 'faint' }, a.id),
          el('span', { class: `pill ag-${a.state}` }, rd.word),
          el('span', { class: 'spacer' }),
          el('a', { href: `#audit?actor=${encodeURIComponent(a.id)}&since=`, class: 'small' }, t('admin.audit_log')),
        ),
        el('p', { class: 'ag-ready small' }, rd.text),
        kvList(
          [t('admin.main_room'), a.room_member ? t('admin.member') : el('span', { class: 'alertish' }, t('admin.not_member_left'))],
          [t('admin.readable_threads'), t('admin.n_threads', { n: a.threads })],
          [t('admin.model'), modelField(a)],
          [t('admin.runs'), a.runs.last_at ? t('admin.runs_summary', { active: a.runs.active, ago: rel(a.runs.last_at), state: a.runs.last_state ? `(${STATE[a.runs.last_state] ?? a.runs.last_state})` : '' }) : t('admin.runs_none')],
          [
            t('admin.last_denied'),
            a.last_denied
              ? el('span', { class: 'alertish' }, `${DENY_TXT[a.last_denied.reason] ?? AUDIT_REASON[a.last_denied.reason] ?? a.last_denied.reason} · ${rel(a.last_denied.at)}${a.last_denied.count > 1 ? ` · ${t('admin.denied_count', { n: a.last_denied.count })}` : ''} `, el('a', { href: deniedLink }, t('admin.log_link')))
              : el('span', { class: 'faint' }, t('admin.none')),
          ],
        ),
        a.credential_list.length && isNarrow()
          ? el(
              'ul',
              { class: 'rcards ag-credcards' },
              ...a.credential_list.map((c) =>
                el(
                  'li',
                  { class: `rcard${c.status === 'active' ? '' : ' dim'}`, 'data-cred': c.id },
                  el('div', { class: 'rc1' }, el('span', { class: `badge cr-${c.status}` }, credStatusLabel(c.status)), el('b', {}, c.label ?? t('admin.no_label')), el('code', { class: 'faint small' }, c.id)),
                  el(
                    'div',
                    { class: 'rc2 muted small' },
                    `${t('admin.cred_issued', { at: when(c.created_at) })} · ${c.status === 'revoked' ? t('admin.cred_revoked_at', { at: when(c.revoked_at) }) : c.expires_at ? t('admin.cred_expires_at', { at: when(c.expires_at) }) : t('admin.no_expiry')} · ${c.last_used_at ? t('admin.last_used', { ago: rel(c.last_used_at) }) : t('admin.never_used')}`,
                  ),
                  c.status === 'active' ? el('div', { class: 'rc3' }, el('button', { type: 'button', class: 'danger small-btn', onclick: () => revokeAsk(a, c) }, t('admin.revoke'))) : null,
                ),
              ),
            )
          : a.credential_list.length
          ? el(
              'table',
              { class: 'hist ag-creds' },
              el('thead', {}, el('tr', {}, ...[t('admin.th_label_id'), t('admin.th_status'), t('admin.th_issued'), t('admin.th_exp_rev'), t('admin.th_last_used'), ''].map((h) => el('th', { scope: 'col' }, h)))),
              el('tbody', {}, ...credRows),
            )
          : el('p', { class: 'muted small' }, t('admin.no_tokens')),
      );
    }),
  );
}
/** 모델 칸(2026-11-04) — 마스터가 정한 값 · 비우면 어댑터 기본값 · 다음 호출부터. 런타임별 추천은 datalist */
const MODEL_HINTS = { 'claude-cli': ['opus', 'sonnet', 'haiku', 'fable'] };
function modelField(a) {
  const rt = a.last_model?.runtime ?? null;
  const listId = `ag-models-${a.id}`;
  const input = el('input', { type: 'text', class: 'ag-model-input', value: a.model ?? '', placeholder: t('admin.model_default'), list: listId, 'aria-label': t('admin.model_for', { name: a.name }), maxlength: '100', size: '18' });
  const save = async () => {
    const v = input.value.trim();
    if (v === (a.model ?? '')) return;
    try {
      const r = await api('PUT', `/api/agents/${encodeURIComponent(a.id)}/model`, { model: v || null });
      announce(r.model ? t('admin.model_set', { name: a.name, model: r.model }) : t('admin.model_cleared', { name: a.name }));
    } catch (e) {
      await notify(t('admin.model_failed'), e.message);
    }
    await loadConnections();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });
  const hints = MODEL_HINTS[rt] ?? [];
  const actual = a.last_model?.model ? t('admin.model_actual', { model: a.last_model.model, runtime: rt ?? '?' }) : t('admin.model_actual_none');
  const unsupported = rt && /^openclaw/.test(rt);
  return el(
    'span',
    { class: 'ag-model' },
    input,
    el('datalist', { id: listId }, ...hints.map((h) => el('option', { value: h }))),
    ' ',
    el('button', { type: 'button', class: 'small-btn', onclick: save }, t('admin.model_save')),
    el('div', { class: 'faint small' }, actual),
    unsupported ? el('div', { class: 'alertish small' }, t('admin.model_unsupported', { runtime: rt })) : null,
  );
}
async function revokeAsk(a, c) {
  const ok = await ask({
    title: t('admin.revoke_title'),
    text: t('admin.revoke_text', { name: a.name, label: c.label ?? c.id }),
    ok: t('admin.revoke'),
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api('POST', `/api/credentials/${encodeURIComponent(c.id)}/revoke`);
    announce(r.outcome === 'revoked' ? t('admin.revoked_done', { name: a.name }) : t('admin.already_revoked'));
  } catch (e) {
    await notify(t('admin.revoke_failed'), e.message);
  }
  await loadConnections();
}

// ───── 멤버 권한 ─────
async function showMembers(params) {
  const agent = params?.get('agent');
  if (agent || (!params?.get('thread') && S.mbBy === 'agent')) return showMembersByAgent(agent || S.mbAgent);
  setMbBy('thread');
  const want = params?.get('thread') || S.mbThread || S.cur || room()?.id;
  S.mbThread = want && threadById(want) ? want : room()?.id ?? S.threads[0]?.id ?? null;
  fillMemberThreads();
  $('mb-status').textContent = '';
  $('mb-h').focus();
  await loadMembers();
}
function fillMemberThreads() {
  $('mb-thread').replaceChildren(...S.threads.map((th) => el('option', { value: th.id }, `${th.kind === 'room' ? `${t('admin.room_tag')} ` : ''}${pathOf(th)}`)));
  if (S.mbThread) $('mb-thread').value = S.mbThread;
}
let mbSeq = 0;
async function loadMembers() {
  if (!S.mbThread) return $('mb-table').replaceChildren(el('p', { class: 'muted' }, t('admin.no_threads')));
  const my = ++mbSeq;
  const th = S.mbThread;
  try {
    const d = await api('GET', `/api/threads/${encodeURIComponent(th)}`);
    if (my !== mbSeq) return;
    S.mbDetail = d;
  } catch (e) {
    if (my === mbSeq) $('mb-table').replaceChildren(el('p', { class: 'err' }, t('admin.load_failed', { error: e.message })));
    return;
  }
  renderMembers();
}
function renderMembers() {
  if (S.mbBy === 'agent') return renderMembersByAgent();
  const d = S.mbDetail;
  if (!d || S.mode !== 'members') return;
  const thr = d.thread;
  const mem = new Map(d.members.map((m) => [m.participant_id, m]));
  const agents = [...S.participants.values()].filter((p) => p.kind === 'agent' && !p.disabled);
  const master = [...S.participants.values()].find((p) => p.is_master);
  const busy = !!S.mbBusy;
  const narrow = isNarrow();
  const cb = (label, checked, disabled, onchange, extra = {}) => {
    const i = el('input', { type: 'checkbox', checked, disabled: disabled || busy, 'aria-label': label, ...extra });
    if (onchange) i.addEventListener('change', () => onchange(i));
    return i;
  };
  const rowFor = (p) => {
    const m = mem.get(p.id);
    const isDefault = thr.default_recipient === p.id;
    const cells = [
      el('span', {}, el('b', {}, p.name), ' ', el('code', { class: 'faint' }, p.id), isDefault ? el('div', { class: 'faint small' }, t('admin.default_recipient')) : null),
      cb(t('admin.cb_member', { name: p.name }), !!m, false, (i) => changeMember(p, i.checked ? { can_read: true, can_post: true } : { remove: true }), { 'data-k': 'member' }),
      cb(t('admin.cb_read', { name: p.name }), !!m?.can_read, !m, (i) => changeMember(p, { can_read: i.checked, can_post: i.checked ? !!m.can_post : false }), { 'data-k': 'read' }),
      cb(t('admin.cb_post', { name: p.name }), !!m?.can_post, !m || !m.can_read, (i) => changeMember(p, { can_read: true, can_post: i.checked }), { 'data-k': 'post' }),
      el('span', { class: 'faint small' }, t('admin.invoke_off')),
    ];
    return narrow
      ? el(
          'li',
          { class: `rcard mb-row${m ? '' : ' dim'}`, 'data-pid': p.id },
          el('div', { class: 'rc1' }, cells[0]),
          el('div', { class: 'mb-toggles' }, el('label', {}, cells[1], ` ${t('admin.member')}`), el('label', {}, cells[2], ` ${t('admin.read')}`), el('label', {}, cells[3], ` ${t('admin.post')}`)),
          el('div', { class: 'faint small' }, t('admin.invoke_off_narrow')),
        )
      : el('tr', { class: `mb-row${m ? '' : ' dim'}`, 'data-pid': p.id }, ...cells.map((c) => el('td', {}, c)));
  };
  const masterCells = [
    el('span', {}, el('b', {}, master?.name ?? t('admin.master')), ' ', el('span', { class: 'faint small' }, t('admin.master_always'))),
    cb(t('admin.cb_member', { name: t('admin.master') }), true, true),
    cb(t('admin.cb_read', { name: t('admin.master') }), true, true),
    cb(t('admin.cb_post', { name: t('admin.master') }), true, true),
    el('span', { class: 'small' }, t('admin.invoke_on')),
  ];
  const head = el('div', { class: 'mb-head small' }, convLabel(thr.kind, pathOf(threadById(thr.id) ?? thr)), ' · ', el('a', { href: `#${thr.id}` }, t('admin.open_thread')), ' · ', el('a', { href: `#audit?thread=${encodeURIComponent(thr.id)}&action=member.*&since=` }, t('admin.member_history')));
  if (narrow) {
    $('mb-table').replaceChildren(
      head,
      el('ul', { class: 'rcards' }, el('li', { class: 'rcard mb-row master' }, el('div', { class: 'rc1' }, masterCells[0]), el('div', { class: 'faint small' }, t('admin.master_all'))), ...agents.map(rowFor)),
    );
  } else {
    $('mb-table').replaceChildren(
      head,
      el(
        'table',
        { class: 'rtable mbtable' },
        el('thead', {}, el('tr', {}, ...[t('admin.participant'), t('admin.member'), t('admin.read'), t('admin.post'), t('admin.invoke')].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, el('tr', { class: 'mb-row master' }, ...masterCells.map((c) => el('td', {}, c))), ...agents.map(rowFor)),
      ),
    );
  }
}
async function changeMember(p, body) {
  const th = S.mbThread;
  const thr = threadById(th);
  if (body.remove) {
    const ok = await ask({
      title: t('admin.remove_title'),
      text: t('admin.remove_text', { name: p.name, title: thr?.title ?? th }),
      ok: t('admin.remove'),
      danger: true,
    });
    if (!ok) return renderMembers();
  }
  S.mbBusy = true;
  renderMembers();
  try {
    const d = await api('POST', `/api/threads/${encodeURIComponent(th)}/members`, { participant_id: p.id, ...body });
    if (th === S.mbThread) S.mbDetail = d;
    const m = d.members.find((x) => x.participant_id === p.id);
    const now = m ? t('admin.perm_now', { read: m.can_read ? t('admin.on') : t('admin.off'), post: m.can_post ? t('admin.on') : t('admin.off') }) : t('admin.not_member');
    $('mb-status').replaceChildren(`${t('admin.perm_saved', { name: p.name, now })} `, el('a', { href: `#audit?thread=${encodeURIComponent(th)}&action=member.*&since=` }, t('admin.view_log_paren')));
    announce(t('admin.perm_changed', { name: p.name, now }));
  } catch (e) {
    $('mb-status').textContent = t('admin.change_failed', { error: e.message });
  }
  S.mbBusy = false;
  renderMembers();
}

// ───── 멤버별 보기(마스터 #2030): 멤버 하나를 골라 대화마다 권한 ─────
function mbAgents() {
  return [...S.participants.values()].filter((p) => p.kind === 'agent' && !p.disabled).sort((a, b) => a.name.localeCompare(b.name));
}
function setMbBy(by) {
  S.mbBy = by;
  const ag = by === 'agent';
  $('mb-by-thread').setAttribute('aria-pressed', String(!ag));
  $('mb-by-agent').setAttribute('aria-pressed', String(ag));
  $('mb-thread-l').hidden = ag;
  $('mb-agent-l').hidden = !ag;
  $('mb-agent-note').hidden = !ag;
  if (!ag) delete $('mb-table').dataset.agent;
}
async function showMembersByAgent(want) {
  setMbBy('agent');
  const agents = mbAgents();
  S.mbAgent = want && agents.some((a) => a.id === want) ? want : agents[0]?.id ?? null;
  $('mb-agent').replaceChildren(...agents.map((a) => el('option', { value: a.id }, `${a.name} (${a.id})`)));
  if (S.mbAgent) $('mb-agent').value = S.mbAgent;
  $('mb-status').textContent = '';
  $('mb-h').focus();
  await loadMembersByAgent();
}
let mbaSeq = 0;
async function loadMembersByAgent() {
  if (!S.mbAgent) return $('mb-table').replaceChildren(el('p', { class: 'muted' }, t('admin.no_agents')));
  const my = ++mbaSeq;
  if (S.mbRowsFor !== S.mbAgent) {
    // 다른 멤버로 바꾸는 중 — 앞 멤버의 줄을 남기면 그 칸을 눌러 엉뚱한 멤버를 바꾼다
    S.mbRows = null;
    $('mb-table').replaceChildren(el('p', { class: 'muted' }, '…'));
  }
  try {
    const d = await api('GET', `/api/participants/${encodeURIComponent(S.mbAgent)}/memberships`);
    if (my !== mbaSeq) return;
    S.mbRows = new Map(d.memberships.map((m) => [m.thread_id, m]));
    S.mbRowsFor = d.participant_id;
  } catch (e) {
    if (my === mbaSeq) $('mb-table').replaceChildren(el('p', { class: 'err' }, t('admin.load_failed', { error: e.message })));
    return;
  }
  renderMembersByAgent();
}
/** 걸러 보이는 대화(제목·경로에 낱말) — 서버 목록 순서(채팅방 먼저 · 만든 순) */
function mbVisible() {
  const q = (S.mbFilter || '').trim().toLowerCase();
  const out = [];
  for (const [id, m] of S.mbRows ?? []) {
    const th = threadById(id);
    if (!th || th.deleted_at) continue;
    const label = pathOf(th);
    if (q && !label.toLowerCase().includes(q)) continue;
    out.push({ th, m, label });
  }
  return out;
}
function renderMembersByAgent() {
  if (S.mode !== 'members' || S.mbBy !== 'agent' || !S.mbRows) return;
  const p = S.participants.get(S.mbRowsFor);
  if (!p) return;
  const busy = !!S.mbBusy;
  const narrow = isNarrow();
  const rows = mbVisible();
  const cb = (label, checked, disabled, onchange, k) => {
    const i = el('input', { type: 'checkbox', checked, disabled: disabled || busy, 'aria-label': label, 'data-k': k });
    if (onchange) i.addEventListener('change', () => onchange(i));
    return i;
  };
  const rowFor = ({ th, m, label }) => {
    const on = !!m.member;
    const name = el('span', {}, th.kind === 'room' ? `${t('admin.room_tag')} ` : '', el('a', { href: `#${th.id}` }, label), th.default_recipient === p.id ? el('div', { class: 'faint small' }, t('admin.default_recipient')) : null);
    const cells = [
      name,
      cb(t('admin.cb_member', { name: label }), on, false, (i) => changeMemberAt(th.id, p, i.checked ? { can_read: true, can_post: true } : { remove: true }), 'member'),
      cb(t('admin.cb_read', { name: label }), on && m.can_read, !on, (i) => changeMemberAt(th.id, p, { can_read: i.checked, can_post: i.checked ? !!m.can_post : false }), 'read'),
      cb(t('admin.cb_post', { name: label }), on && m.can_post, !on || !m.can_read, (i) => changeMemberAt(th.id, p, { can_read: true, can_post: i.checked }), 'post'),
    ];
    return narrow
      ? el('li', { class: `rcard mb-row${on ? '' : ' dim'}`, 'data-tid': th.id }, el('div', { class: 'rc1' }, cells[0]), el('div', { class: 'mb-toggles' }, el('label', {}, cells[1], ` ${t('admin.member')}`), el('label', {}, cells[2], ` ${t('admin.read')}`), el('label', {}, cells[3], ` ${t('admin.post')}`)))
      : el('tr', { class: `mb-row${on ? '' : ' dim'}`, 'data-tid': th.id }, ...cells.map((c) => el('td', {}, c)));
  };
  const filter = el('input', { type: 'search', id: 'mb-filter', value: S.mbFilter || '', placeholder: t('admin.mb_filter'), 'aria-label': t('admin.mb_filter') });
  let ft = null;
  filter.addEventListener('input', () => {
    clearTimeout(ft);
    ft = setTimeout(() => {
      S.mbFilter = filter.value;
      if (S.mode !== 'members' || S.mbBy !== 'agent') return;
      renderMembersByAgent();
      const f = $('mb-filter');
      if (!f) return;
      f.focus();
      f.setSelectionRange(f.value.length, f.value.length);
    }, 200);
  });
  const bulk = (key, body) => el('button', { type: 'button', class: 'small', disabled: busy || !rows.length, onclick: () => bulkMembers(p, rows, body, t(key)) }, t(key));
  const count = rows.filter((r) => r.m.member).length;
  const head = el(
    'div',
    { class: 'mb-head small' },
    el('b', {}, p.name),
    ' · ',
    t('admin.mb_count', { n: count, total: rows.length }),
    ' · ',
    el('a', { href: `#audit?actor=&action=member.*&q=${encodeURIComponent(p.id)}&since=` }, t('admin.view_log_paren')),
  );
  const tools = el('div', { class: 'mb-bulk small' }, filter, el('span', { class: 'faint' }, t('admin.mb_bulk_label', { n: rows.length })), bulk('admin.mb_bulk_rw', { can_read: true, can_post: true }), bulk('admin.mb_bulk_ro', { can_read: true, can_post: false }), bulk('admin.mb_bulk_remove', { remove: true }));
  const list = !rows.length
    ? el('p', { class: 'muted' }, t('admin.no_threads'))
    : narrow
    ? el('ul', { class: 'rcards' }, ...rows.map(rowFor))
    : el(
        'table',
        { class: 'rtable mbtable' },
        el('thead', {}, el('tr', {}, ...[t('html.common.conversation'), t('admin.member'), t('admin.read'), t('admin.post')].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, ...rows.map(rowFor)),
      );
  $('mb-table').replaceChildren(head, tools, list);
  $('mb-table').dataset.agent = p.id;
}
/** 한 줄 바꾸기 — 대화별 보기의 changeMember 와 같은 API · 빼기는 확인창 */
async function changeMemberAt(threadId, p, body) {
  const thr = threadById(threadId);
  if (body.remove) {
    const ok = await ask({ title: t('admin.remove_title'), text: t('admin.remove_text', { name: p.name, title: thr?.title ?? threadId }), ok: t('admin.remove'), danger: true });
    if (!ok) return renderMembersByAgent();
  }
  S.mbBusy = true;
  renderMembersByAgent();
  try {
    const m = await postMember(threadId, p, body);
    const now = m.member ? t('admin.perm_now', { read: m.can_read ? t('admin.on') : t('admin.off'), post: m.can_post ? t('admin.on') : t('admin.off') }) : t('admin.not_member');
    $('mb-status').textContent = t('admin.perm_saved', { name: `${p.name} · ${pathOf(thr ?? { id: threadId, title: threadId })}`, now });
    announce(t('admin.perm_changed', { name: p.name, now }));
  } catch (e) {
    $('mb-status').textContent = t('admin.change_failed', { error: e.message });
  }
  S.mbBusy = false;
  renderMembersByAgent();
}
async function postMember(threadId, p, body) {
  const d = await api('POST', `/api/threads/${encodeURIComponent(threadId)}/members`, { participant_id: p.id, ...body });
  const x = d.members.find((y) => y.participant_id === p.id);
  const m = x ? { thread_id: threadId, member: true, can_read: !!x.can_read, can_post: !!x.can_post } : { thread_id: threadId, member: false };
  S.mbRows?.set(threadId, m);
  return m;
}
/** 보이는 대화 모두에 같은 권한 — 이미 그 상태인 대화는 건너뜀 · 하나씩 보내 감사 기록도 대화마다 남는다 */
async function bulkMembers(p, rows, body, label) {
  const same = (m) => (body.remove ? !m.member : m.member && m.can_read === body.can_read && m.can_post === body.can_post);
  const todo = rows.filter((r) => !same(r.m));
  if (!todo.length) return ($('mb-status').textContent = t('admin.mb_bulk_none'));
  const ok = await ask({
    title: label,
    text: t(body.remove ? 'admin.mb_bulk_remove_text' : 'admin.mb_bulk_text', { name: p.name, n: todo.length }),
    ok: label,
    danger: !!body.remove,
  });
  if (!ok) return;
  S.mbBusy = true;
  let done = 0;
  const fails = [];
  for (const r of todo) {
    $('mb-status').textContent = t('admin.mb_bulk_progress', { done, n: todo.length });
    renderMembersByAgent();
    try {
      await postMember(r.th.id, p, body);
      done++;
    } catch (e) {
      fails.push(`${r.label}: ${e.message}`);
    }
  }
  S.mbBusy = false;
  $('mb-status').textContent = t('admin.mb_bulk_done', { done, n: todo.length }) + (fails.length ? ` · ${t('admin.change_failed', { error: fails.join(' / ') })}` : '');
  announce($('mb-status').textContent);
  renderMembersByAgent();
}

/** 알림이 오면(대화 바뀜·재접속) 열려 있는 관리 화면을 다시 읽는다 */
let adminReloadTimer = null;
function refreshAdminPage(threadId) {
  if (S.mode !== 'members' && S.mode !== 'agents') return;
  clearTimeout(adminReloadTimer);
  adminReloadTimer = setTimeout(() => {
    if (S.mode === 'members' && S.mbBy === 'agent') {
      if (!S.mbBusy) loadMembersByAgent();
    } else if (S.mode === 'members') {
      fillMemberThreads();
      if (!threadId || threadId === S.mbThread) loadMembers();
    } else if (S.mode === 'agents') loadConnections();
  }, 150);
}

function initAdmin() {
  $('au-filters').addEventListener('submit', (e) => {
    e.preventDefault();
    onAuditFilter();
  });
  for (const id of ['af-action', 'af-actor', 'af-result', 'af-since']) $(id).addEventListener('change', () => onAuditFilter());
  let qTimer = null;
  $('af-q').addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => onAuditFilter(), 300);
  });
  $('au-reload').addEventListener('click', () => loadAudit());
  $('ag-reload').addEventListener('click', () => loadConnections());
  $('ag-hide-revoked').addEventListener('change', (e) => {
    store(AG_HIDE_KEY, e.target.checked ? '1' : '0');
    renderConnections();
  });
  $('mb-by-thread').addEventListener('click', () => {
    S.mbBy = 'thread';
    location.hash = `members?thread=${encodeURIComponent(S.mbThread || S.cur || room()?.id || '')}`;
  });
  $('mb-by-agent').addEventListener('click', () => {
    S.mbBy = 'agent';
    const a = mbAgents()[0];
    location.hash = `members?agent=${encodeURIComponent(S.mbAgent || a?.id || '')}`;
  });
  $('mb-agent').addEventListener('change', () => {
    S.mbAgent = $('mb-agent').value;
    history.replaceState(null, '', `#members?agent=${encodeURIComponent(S.mbAgent)}`);
    $('mb-status').textContent = '';
    loadMembersByAgent();
  });
  $('mb-thread').addEventListener('change', () => {
    S.mbThread = $('mb-thread').value;
    history.replaceState(null, '', `#members?thread=${encodeURIComponent(S.mbThread)}`);
    $('mb-status').textContent = '';
    loadMembers();
  });
  // 연결 화면이 열려 있으면 15초마다(마지막 접속 «N초 전»이 낡지 않게)
  setInterval(() => {
    if (S.mode === 'agents' && !$('app-view').hidden) loadConnections();
  }, 15000);
}

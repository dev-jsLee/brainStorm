// brainStorm 실행 화면(기획 대조 2단계): 실행 상태 목록(n43) · 실행 상세(n46) · 취소 결과(n50 + 변형).
// app.js 보다 먼저 읽히지만 함수만 정의한다 — 실제 호출은 app.js 의 라우터(route)가 한다. app.js 의 전역($·S·el·api…)을 쓴다.
// 판정은 서버가 한다(run.cancel_outcome). 화면은 그 값과 시각 칸을 그대로 보여 준다.
'use strict';

/** 서버 이벤트 이름 → 화면 문구 */
const RUN_EVENT = {
  created: t('runs.ev_created'),
  started: t('runs.ev_started'),
  cancel_requested: t('runs.cancel_request'),
  cancel_repeat: t('runs.ev_cancel_repeat'),
  stop_sent: t('runs.ev_stop_sent'),
  stop_ack: t('runs.stop_ack'),
  completed: t('runs.ev_completed'),
  failed: t('runs.ev_failed'),
  lease_expired: t('runs.ev_lease_expired'),
  cancel_ack_timeout: t('runs.ev_cancel_ack_timeout'),
  finalized: t('runs.ev_finalized'),
  late_complete: t('runs.ev_late_complete'),
  late_fail: t('runs.ev_late_fail'),
  late_stop_ack: t('runs.ev_late_stop_ack'),
  cancel_after_final: t('runs.ev_cancel_after_final'),
  checked: t('runs.ev_checked'),
  withdrawn: t('runs.ev_withdrawn'),
  rotated: t('runs.ev_rotated'),
};

function rpQuery() {
  return S.rp ?? (S.rp = { state: '', agent: '', thread: '', since: store('bs.runs-since') ?? '3600000' });
}
const ackSec = () => Math.round((S.cancelAckMs ?? 30000) / 1000);
const shortId = (id) => (id.length > 14 ? `${id.slice(0, 12)}…` : id);
function convLabel(kind, title) {
  return el('span', { class: 'conv' }, el('span', { class: `pill ${kind === 'room' ? 'room' : ''}` }, kind === 'room' ? t('runs.room') : t('runs.thread')), ' ', title);
}
function countdown(until) {
  return el('span', { 'data-until': String(until) }, t('runs.sec', { n: Math.max(0, Math.ceil((until - Date.now()) / 1000)) }));
}
function outcomeEl(r) {
  if (!r.cancel_outcome) return el('span', { class: 'faint' }, '—');
  const o = el('span', { class: `oc oc-${r.cancel_outcome}` }, OUTCOME[r.cancel_outcome] ?? r.cancel_outcome);
  if (r.cancel_outcome === 'requested' && r.cancel_deadline_at) return el('span', {}, o, el('span', { class: 'faint' }, t('runs.left_sep')), countdown(r.cancel_deadline_at));
  return o;
}
function elapsedEl(r) {
  if (r.state === 'queued') return el('span', { class: 'faint' }, t('runs.not_started'));
  if (r.state === 'running') return el('span', { 'data-since': String(r.started_at ?? r.created_at) }, dur(Date.now() - (r.started_at ?? r.created_at)));
  return r.ended_at ? dur(r.ended_at - (r.started_at ?? r.created_at)) : '—';
}
/** 오늘이면 HH:MM:SS, 아니면 YYYY-MM-DD HH:MM:SS (시안 n46 꼴) */
const when = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  const p2 = (n) => String(n).padStart(2, '0');
  const hms = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  if (new Date().toDateString() === d.toDateString()) return hms;
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hms}`;
};
function runBadge(r) {
  return el('span', { class: `badge st-${runStateKey(r)}` }, stateLabel(r));
}

// ───── 실행 상태 목록 (n43) ─────
async function showRuns(params) {
  const q = rpQuery();
  if (params) for (const k of ['state', 'agent', 'thread', 'since']) if (params.has(k)) q[k] = params.get(k) ?? '';
  showRunsPane('list');
  fillRunFilters();
  $('rp-h').focus();
  await loadRunsPage();
}
function showRunsPane(which) {
  $('rp-list').hidden = which !== 'list';
  $('rp-detail').hidden = which !== 'detail';
  $('rp-result').hidden = which !== 'result';
  S.runsPane = which;
}
function fillRunFilters() {
  const q = rpQuery();
  const agents = [...S.participants.values()].filter((p) => p.kind === 'agent' && !p.disabled);
  $('rf-agent').replaceChildren(el('option', { value: '' }, t('runs.all')), ...agents.map((a) => el('option', { value: a.id }, a.name)));
  $('rf-thread').replaceChildren(
    el('option', { value: '' }, t('runs.all')),
    ...S.threads.map((th) => el('option', { value: th.id }, `${th.kind === 'room' ? t('runs.room_prefix') : ''}${th.title}`)),
  );
  $('rf-state').value = q.state;
  $('rf-agent').value = q.agent;
  $('rf-thread').value = q.thread;
  $('rf-since').value = q.since;
}
function onRunFilter() {
  const q = rpQuery();
  q.state = $('rf-state').value;
  q.agent = $('rf-agent').value;
  q.thread = $('rf-thread').value;
  q.since = $('rf-since').value;
  store('bs.runs-since', q.since);
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  history.replaceState(null, '', `#runs${qs ? `?${qs}` : ''}`);
  loadRunsPage();
}
let runsPageSeq = 0;
async function loadRunsPage() {
  const q = rpQuery();
  const qs = new URLSearchParams();
  if (q.state) qs.set('state', q.state);
  if (q.agent) qs.set('agent', q.agent);
  if (q.thread) qs.set('thread', q.thread);
  if (q.since) qs.set('since', String(Date.now() - Number(q.since)));
  const my = ++runsPageSeq;
  let r;
  try {
    r = await api('GET', `/api/runs?${qs}`);
  } catch (e) {
    if (my === runsPageSeq) $('rp-table').replaceChildren(el('p', { class: 'err' }, t('runs.list_load_failed', { msg: e.message })));
    return;
  }
  if (my !== runsPageSeq) return;
  S.cancelAckMs = r.cancel_ack_ms;
  S.rpData = r;
  renderRunsTable();
}
function renderRunsTable() {
  const r = S.rpData;
  if (!r) return;
  const n = r.total + r.waiting.length;
  $('rp-total').textContent = t('runs.total', { n }) + (r.waiting.length ? t('runs.total_waiting', { n: r.waiting.length }) : '') + (r.runs.length < r.total ? t('runs.total_shown', { n: r.runs.length }) : '');
  if (!n) return $('rp-table').replaceChildren(el('p', { class: 'muted empty-runs' }, t('runs.empty')));
  const narrow = isNarrow();
  const waitRow = (d) => {
    const cancel = el('button', { type: 'button', class: 'danger small-btn', onclick: () => cancelDeliveryAsk(d) }, t('runs.cancel_delivery'));
    const cells = {
      id: el('code', { class: 'rid', title: d.id }, shortId(d.id)),
      st: el('span', { class: `badge st-${d.status}` }, d.status === 'leased' ? t('runs.leased') : t('runs.pending_delivery')),
      agent: pname(d.recipient_id),
      conv: el('a', { href: `#${d.thread_id}` }, convLabel(d.thread_kind, d.thread_title)),
      start: el('span', { class: 'faint' }, t('runs.message_seq', { seq: d.message_seq })),
      dur: el('span', {}, t('runs.waiting_prefix'), el('span', { 'data-since': String(d.created_at) }, dur(Date.now() - d.created_at))),
      oc: el('span', { class: 'faint' }, '—'),
      act: cancel,
    };
    return narrow ? card(cells, 'waiting') : row(cells, 'waiting');
  };
  const runRow = (x) => {
    const cells = {
      id: el('code', { class: 'rid', title: x.id }, shortId(x.id)),
      st: runBadge(x),
      agent: pname(x.agent_id),
      conv: el('a', { href: `#${x.thread_id}` }, convLabel(x.thread_kind, x.thread_title)),
      start: when(x.started_at ?? x.created_at),
      dur: elapsedEl(x),
      oc: outcomeEl(x),
      act: el('a', { href: `#run/${encodeURIComponent(x.id)}`, class: 'detail-link' }, narrow ? t('runs.view_status') : t('runs.detail')),
    };
    const bad = ['failed', 'unknown', 'cancelled'].includes(x.state) || x.cancel_outcome === 'requested';
    return narrow ? card(cells, bad ? `bad st-row-${x.state}` : '') : row(cells, bad ? `bad st-row-${x.state}` : '');
  };
  const row = (c, cls) => el('tr', { class: cls }, ...['id', 'st', 'agent', 'conv', 'start', 'dur', 'oc', 'act'].map((k) => el('td', { class: `c-${k}` }, c[k])));
  const card = (c, cls) =>
    el(
      'li',
      { class: `rcard ${cls}` },
      el('div', { class: 'rc1' }, c.st, el('b', {}, c.agent), el('span', { class: 'faint' }, '·'), c.conv),
      el('div', { class: 'rc2 muted small' }, c.start, ' · ', c.dur, t('runs.card_outcome'), c.oc),
      el('div', { class: 'rc3' }, c.act),
    );
  if (narrow) {
    $('rp-table').replaceChildren(el('ul', { class: 'rcards' }, ...r.waiting.map(waitRow), ...r.runs.map(runRow)));
  } else {
    $('rp-table').replaceChildren(
      el(
        'table',
        { class: 'rtable' },
        el('thead', {}, el('tr', {}, ...[t('runs.col_id'), t('runs.col_state'), t('runs.col_agent'), t('runs.conversation'), t('runs.started_at'), t('runs.elapsed'), t('runs.col_outcome'), t('runs.detail')].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, ...r.waiting.map(waitRow), ...r.runs.map(runRow)),
      ),
    );
  }
}
async function cancelDeliveryAsk(d) {
  const ok = await ask({
    title: t('runs.cancel_delivery'),
    text: t('runs.cancel_delivery_text', { agent: pname(d.recipient_id), seq: d.message_seq }),
    ok: t('runs.cancel_delivery'),
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api('POST', `/api/deliveries/${encodeURIComponent(d.id)}/cancel`);
    announce(r.outcome === 'cancelled' ? t('runs.delivery_withdrawn') : t('runs.delivery_done'));
  } catch (e) {
    await notify(t('runs.cancel_delivery_failed'), e.code === 'has_run' ? t('runs.delivery_has_run') : e.message);
  }
  if (S.mode === 'runs') await loadRunsPage();
  if (S.cur) loadRuns().catch(() => {});
}

// ───── 실행 상세 (n46) ─────
async function showRun(id) {
  S.rdId = id;
  showRunsPane('detail');
  if (!S.rd || S.rd.run.id !== id) $('rp-detail').replaceChildren(el('p', { class: 'muted' }, t('runs.loading_run')));
  await loadRunDetail(id);
}
async function loadRunDetail(id, how = 'GET') {
  let d;
  try {
    d = how === 'refresh' ? await api('POST', `/api/runs/${encodeURIComponent(id)}/refresh`) : await api('GET', `/api/runs/${encodeURIComponent(id)}`);
  } catch (e) {
    if (S.mode === 'runs' && S.runsPane !== 'list')
      (S.runsPane === 'result' ? $('rp-result') : $('rp-detail')).replaceChildren(
        backLink(),
        el('p', { class: 'err' }, e.status === 404 ? t('runs.run_not_found') : t('runs.load_failed', { msg: e.message })),
      );
    return null;
  }
  S.cancelAckMs = d.cancel_ack_ms;
  if (id !== S.rdId) return d; // 그사이 다른 실행을 열었다 — 늦게 온 응답은 화면에 쓰지 않는다
  S.rd = d;
  if (S.mode === 'runs' && S.runsPane === 'detail') renderRunDetail();
  if (S.mode === 'runs' && S.runsPane === 'result') renderCancelResult();
  return d;
}
function backLink() {
  return el('a', { href: '#runs', class: 'back' }, t('runs.back'));
}
function kvList(...pairs) {
  return el('dl', { class: 'kv' }, ...pairs.filter(Boolean).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
}
function excerpt(m, n = 160) {
  if (!m) return el('span', { class: 'faint' }, t('runs.none'));
  const b = m.body.length > n ? `${m.body.slice(0, n)}…` : m.body;
  return el('span', {}, el('span', { class: 'faint' }, `#${m.seq} · ${pname(m.author_id)} · ${when(m.created_at)} — `), b);
}
function renderRunDetail() {
  const d = S.rd;
  const r = d.run;
  const active = r.state === 'queued' || r.state === 'running';
  const canCancel = active && !r.cancel_requested_at;
  const head = el(
    'div',
    { class: 'page-head' },
    el('h2', { id: 'rd-h', tabindex: '-1' }, t('runs.detail_title')),
    runBadge(r),
    el('span', { class: 'spacer' }),
    el('button', { type: 'button', id: 'rd-refresh', onclick: () => refreshRunAsk(r.id) }, t('runs.refresh')),
    el('button', { type: 'button', id: 'rd-cancel', class: 'primary danger-fill', disabled: !canCancel, title: canCancel ? '' : active ? t('runs.already_requested_title') : t('runs.already_ended_title'), onclick: () => cancelRunAsk(r, { from: 'detail' }) }, r.cancel_requested_at && active ? t('runs.cancel_requested') : t('runs.request_cancel')),
  );
  const tokens = r.usage && typeof r.usage === 'object' ? r.usage.tokens : null;
  const outTok = tokens && typeof tokens === 'object' ? tokens.completion_tokens ?? tokens.output_tokens ?? null : null;
  const th = d.thread;
  const conv = el('a', { href: `#${th.id}` }, convLabel(th.kind, threadById(th.id) ? pathOf(threadById(th.id)) : th.title));
  const basic = el(
    'section',
    { class: 'dcard' },
    el('h3', {}, t('runs.basic_info')),
    kvList(
      [t('runs.col_id'), el('code', {}, r.id)],
      [t('runs.agent'), d.agent.name],
      [t('runs.conversation'), conv],
      [t('runs.trigger_msg'), `#${r.trigger_seq}`],
      [t('runs.called_at'), when(r.created_at)],
      [t('runs.started_at'), r.started_at ? when(r.started_at) : el('span', { class: 'faint' }, t('runs.not_started'))],
      [t('runs.ended_at'), r.ended_at ? when(r.ended_at) : el('span', { class: 'faint' }, active ? t('runs.not_ended') : '—')],
      [t('runs.elapsed'), elapsedEl(r)],
      [t('runs.current_state'), runBadge(r)],
      [t('runs.adapter_signal'), r.heartbeat_at ? t('runs.last_at', { time: when(r.heartbeat_at) }) : el('span', { class: 'faint' }, t('runs.no_record'))],
      [t('runs.progress'), r.progress ? `${r.progress} (${when(r.progress_at)})` : el('span', { class: 'faint' }, t('runs.no_record'))],
      [t('runs.last_checked'), r.last_checked_at ? when(r.last_checked_at) : el('span', { class: 'faint' }, t('runs.not_yet'))],
    ),
  );
  const seqs = d.input.seqs;
  const input = el(
    'section',
    { class: 'dcard' },
    el('h3', {}, t('runs.input')),
    kvList(
      [t('runs.input_msg'), excerpt(d.input.trigger)],
      [t('runs.passed_msgs'), seqs.length ? t('runs.passed_list', { list: `${seqs.slice(0, 12).map((s) => `#${s}`).join(', ')}${seqs.length > 12 ? ' …' : ''}`, n: seqs.length }) : el('span', { class: 'faint' }, t('runs.none'))],
      [t('runs.ctx_generation'), d.session ? t('runs.session_gen', { gen: d.session.generation, status: d.session.status === 'active' ? t('runs.active') : t('runs.closed') }) : t('runs.gen_n', { gen: r.generation })],
      [t('runs.worker'), d.input.worker ?? '—'],
    ),
  );
  const output = el(
    'section',
    { class: 'dcard' },
    el('h3', {}, t('runs.output')),
    kvList(
      [t('runs.reply_msg'), excerpt(d.output.message)],
      [t('runs.actual_model'), d.session?.actual_model ?? el('span', { class: 'faint' }, t('runs.no_record'))],
      [t('runs.runtime_config'), `${d.session?.runtime ?? '—'} · ${d.session?.config_version ?? '—'}`],
      [t('runs.output_tokens'), outTok != null ? t('runs.tokens_n', { n: Number(outTok).toLocaleString(I18N.locale) }) : el('span', { class: 'faint' }, t('runs.not_reported'))],
      r.error ? [t('runs.reason'), RUN_ERR[r.error] ?? r.error] : null,
    ),
  );
  $('rp-detail').replaceChildren(
    backLink(),
    head,
    statusBlock(r, 'detail'),
    el('div', { class: 'dgrid' }, basic, el('div', { class: 'dcol' }, input, output)),
    cancelSteps(d),
    eventLog(d),
  );
}
/** 상태별 안내 띠: 중단 요청됨 / 상태 미확인(자동 재실행 안 됨) / 완료 우선 확정 */
function statusBlock(r, where) {
  if (r.cancel_outcome === 'requested')
    return el(
      'div',
      { class: 'banner warn', role: 'status' },
      el('b', {}, t('runs.cancel_requested')),
      el('span', {}, t('runs.banner_requested', { sec: ackSec() }), countdown(r.cancel_deadline_at)),
    );
  if (r.state === 'unknown')
    return el(
      'div',
      { class: 'banner bad', role: 'status' },
      el('b', {}, t('runs.state_unknown')),
      el(
        'span',
        {},
        r.error === 'cancel_ack_timeout' ? t('runs.ack_timeout', { sec: ackSec() }) : t('runs.lease_lost'),
        t('runs.no_rerun_last'),
        el('b', {}, r.last_checked_at ? when(r.last_checked_at) : t('runs.judged_at', { time: when(r.finalized_at ?? r.ended_at) })),
      ),
      where === 'detail' ? null : el('button', { type: 'button', onclick: () => refreshRunAsk(r.id) }, t('runs.refresh')),
    );
  if (r.cancel_outcome === 'completed_first')
    return el('div', { class: 'banner warn', role: 'status' }, el('b', {}, t('runs.completed_first')), el('span', {}, t('runs.completed_first_banner')));
  return null;
}
function cancelSteps(d) {
  const r = d.run;
  const ev = d.events;
  const st = (word, cls = '') => el('span', { class: `step-st ${cls}` }, word);
  const step = (name, status, note) => el('li', {}, el('span', { class: 'step-name' }, name), status, note ? el('span', { class: 'faint small' }, note) : null);
  const o = r.cancel_outcome;
  const active = r.state === 'queued' || r.state === 'running';
  const req = r.cancel_requested_at
    ? step(t('runs.cancel_request'), st(t('runs.requested_done'), 'done'), `${when(r.cancel_requested_at)} · ${r.cancel_requested_by ? pname(r.cancel_requested_by) : ''}`)
    : o === 'legacy'
      ? step(t('runs.cancel_request'), st(t('runs.requested_done'), 'done'), t('runs.legacy_no_time'))
      : step(t('runs.cancel_request'), st(active ? t('runs.before_request') : t('runs.no_request'), 'none'));
  const block = step(t('runs.step_block'), st(t('runs.na'), 'none'), t('runs.block_note'));
  let ack;
  if (!o) ack = step(t('runs.stop_ack'), st('—', 'none'));
  else if (o === 'queued_cancelled') ack = step(t('runs.stop_ack'), st(t('runs.na'), 'none'), t('runs.queued_cancel_note'));
  else if (o === 'acked') ack = step(t('runs.stop_ack'), st(t('runs.acked'), 'done'), when(r.stop_ack_at));
  else if (o === 'requested')
    ack = step(
      t('runs.stop_ack'),
      st(t('runs.waiting'), 'wait'),
      el('span', {}, r.stop_sent_at ? t('runs.stop_sent_at', { time: when(r.stop_sent_at) }) : t('runs.stop_next_hb'), t('runs.left_sep'), countdown(r.cancel_deadline_at)),
    );
  else if (o === 'no_ack') ack = step(t('runs.stop_ack'), st(t('runs.no_response'), 'bad'), r.stop_sent_at ? t('runs.no_ack_sent', { sec: ackSec(), time: when(r.stop_sent_at) }) : t('runs.no_ack_unsent', { sec: ackSec() }));
  else if (o === 'completed_first' || o === 'failed_first') ack = step(t('runs.stop_ack'), st(t('runs.ended_before_ack'), 'wait'), t('runs.ended_before_ack_note'));
  else ack = step(t('runs.stop_ack'), st(t('runs.na'), 'none'), OUTCOME[o]);
  const late = ev.filter((e) => e.event.startsWith('late_'));
  const after = ev.find((e) => e.event === 'cancel_after_final');
  let race;
  if (o === 'completed_first') race = step(t('runs.step_race'), st(t('runs.recorded'), 'done'), t('runs.race_completed'));
  else if (o === 'failed_first') race = step(t('runs.step_race'), st(t('runs.recorded'), 'done'), t('runs.race_failed'));
  else if (late.length) race = step(t('runs.step_race'), st(t('runs.recorded'), 'done'), t('runs.race_late', { n: late.length, events: late.map((e) => RUN_EVENT[e.event]).join(', ') }));
  else if (after) race = step(t('runs.step_race'), st(t('runs.recorded'), 'done'), t('runs.race_after', { state: STATE[after.detail?.state] ?? '' }));
  else race = step(t('runs.step_race'), st(o === 'requested' ? t('runs.none_yet') : t('runs.none'), 'none'));
  const fin = r.finalized_at
    ? step(t('runs.step_final'), st(stateLabel(r), r.state === 'succeeded' ? 'done' : r.state === 'cancelled' ? 'done' : 'bad'), when(r.finalized_at))
    : active
      ? step(t('runs.step_final'), st(t('runs.unsettled'), 'wait'))
      : step(t('runs.step_final'), st(stateLabel(r), 'done'), t('runs.final_no_time'));
  return el(
    'section',
    { class: 'dcard' },
    el('h3', {}, t('runs.cancel_steps')),
    el('ol', { class: 'steps' }, req, block, ack, race, fin),
    el('p', { class: 'muted small' }, t('runs.cancel_steps_note', { sec: ackSec() })),
  );
}
function evDetail(e) {
  const x = e.detail ?? {};
  if (e.event === 'finalized') return `${STATE[x.state] ?? x.state}${x.completed_first ? t('runs.sfx_completed_first') : x.failed_first ? t('runs.sfx_failed_first') : x.before_start ? t('runs.sfx_before_start') : ''}`;
  if (e.event === 'failed') return x.error ?? '';
  if (e.event === 'completed') return t('runs.ev_reply', { seq: x.result_seq }) + (x.during_cancel ? t('runs.ev_during_cancel') : '');
  if (e.event.startsWith('late_') || e.event === 'cancel_after_final' || e.event === 'checked') return t('runs.ev_state_then', { state: STATE[x.state] ?? x.state });
  if (e.event === 'cancel_ack_timeout') return t('runs.ev_waited', { sec: Math.round((x.waited_ms ?? 0) / 1000) });
  if (e.event === 'stop_ack' && x.waited_ms != null) return t('runs.ev_after_request', { dur: dur(x.waited_ms) });
  if (e.event === 'created') return t('runs.ev_created_detail', { gen: x.generation, worker: x.worker ?? '?', n: x.context ?? '?' });
  if (e.event === 'started') return [x.runtime, x.config_version].filter(Boolean).join(' · ');
  return '';
}
function evSource(s) {
  if (s === 'server') return t('runs.server');
  const p = S.participants.get(s);
  return p ? t('runs.source_by', { name: p.name, role: p.kind === 'agent' ? t('runs.adapter') : t('runs.master') }) : s;
}
function eventLog(d) {
  const r = d.run;
  let rows = d.events.map((e) => [e.at, `${RUN_EVENT[e.event] ?? e.event}${evDetail(e) ? ` — ${evDetail(e)}` : ''}`, evSource(e.source), e.event]);
  let note = null;
  if (!rows.length) {
    // 마이그레이션 4 전 실행: 이벤트가 없다 — 시각 칸에서 복원해 보여 준다
    rows = [
      [r.created_at, RUN_EVENT.created, t('runs.server'), 'created'],
      r.started_at ? [r.started_at, RUN_EVENT.started, pname(r.agent_id), 'started'] : null,
      r.ended_at ? [r.ended_at, t('runs.ev_ended', { state: STATE[r.state] }) + (r.error ? ` (${RUN_ERR[r.error] ?? r.error})` : ''), '—', 'ended'] : null,
    ].filter(Boolean);
    note = el('p', { class: 'muted small' }, t('runs.legacy_events'));
  }
  return el(
    'section',
    { class: 'dcard' },
    el('h3', {}, t('runs.event_log')),
    note,
    el(
      'table',
      { class: 'hist evlog' },
      el('thead', {}, el('tr', {}, el('th', {}, t('runs.col_time')), el('th', {}, t('runs.col_event')), el('th', {}, t('runs.col_source')))),
      el('tbody', {}, ...rows.map(([at, txt, src, ev]) => el('tr', { class: /^late_|timeout|lease/.test(ev) ? 'evbad' : '' }, el('td', {}, when(at)), el('td', {}, txt), el('td', {}, src)))),
    ),
  );
}

// ───── 취소 요청 · 결과 (n50 + 변형) ─────
/** 메시지 행·보조 패널·상세 공통. 상세에서 부르면 결과 화면으로 간다 */
async function cancelRunAsk(r, opt = {}) {
  const ok = await ask({
    title: t('runs.cancel_run_title'),
    text: t('runs.cancel_run_text', { agent: pname(r.agent_id), state: stateLabel(r), seq: r.trigger_seq, sec: ackSec() }),
    ok: t('runs.cancel_run'),
    danger: true,
  });
  if (!ok) return null;
  let res;
  try {
    res = await api('POST', `/api/runs/${encodeURIComponent(r.id)}/cancel`);
  } catch (e) {
    await notify(t('runs.cancel_run_failed'), e.message);
    return null;
  }
  S.cancelResult = { id: r.id, outcome: res.outcome, prevState: res.state };
  const msg = {
    cancelled: t('runs.msg_cancelled'),
    requested: t('runs.msg_requested'),
    already_requested: t('runs.msg_already_requested'),
    already_final: t('runs.msg_already_final', { state: STATE[res.state] ?? res.state }),
  }[res.outcome];
  announce(msg);
  if (opt.from === 'detail') location.hash = `run/${encodeURIComponent(r.id)}/cancel`;
  else if (res.outcome === 'already_final') notify(t('runs.already_ended'), t('runs.already_final_notify', { msg }));
  if (S.cur) loadRuns().catch(() => {});
  return res;
}
async function refreshRunAsk(id) {
  const before = S.rd?.run;
  const d = await loadRunDetail(id, 'refresh');
  if (!d) return;
  const same = before && before.id === id && before.state === d.run.state;
  announce(same ? t('runs.state_unchanged', { state: stateLabel(d.run), time: fmtHm(d.run.last_checked_at) }) : t('runs.state_now', { state: stateLabel(d.run) }));
  if (S.cur) loadRuns().catch(() => {});
}
async function showCancelResult(id) {
  S.rdId = id;
  showRunsPane('result');
  $('rp-result').replaceChildren(el('p', { class: 'muted' }, t('runs.loading_result')));
  await loadRunDetail(id);
}
function renderCancelResult() {
  const d = S.rd;
  if (!d) return;
  const r = d.run;
  const cr = S.cancelResult && S.cancelResult.id === r.id ? S.cancelResult : null;
  const o = cr?.outcome === 'already_final' ? 'already_final' : r.cancel_outcome ?? (r.state === 'unknown' ? 'unknown' : null);
  const s = ackSec();
  const V = {
    acked: ['ok', '✓', t('runs.r_acked_title'), t('runs.r_acked_text')],
    queued_cancelled: ['ok', '✓', t('runs.r_queued_title'), t('runs.r_queued_text')],
    requested: ['wait', '…', t('runs.cancel_requested'), t('runs.r_requested_text', { sec: s })],
    no_ack: ['bad', '?', t('runs.state_unknown'), t('runs.r_no_ack_text', { sec: s })],
    unknown: ['bad', '?', t('runs.state_unknown'), t('runs.r_unknown_text')],
    completed_first: ['warn', '!', t('runs.completed_first'), t('runs.r_completed_first_text')],
    failed_first: ['warn', '!', t('runs.r_failed_first_title'), t('runs.r_failed_first_text')],
    already_final: ['warn', '!', r.state === 'succeeded' ? t('runs.r_already_succeeded') : t('runs.already_ended'), t('runs.r_already_final_text', { state: STATE[r.state] })],
    withdrawn: ['ok', '✓', t('runs.r_withdrawn_title'), t('runs.r_withdrawn_text')],
    rotated: ['ok', '✓', t('runs.r_rotated_title'), t('runs.r_rotated_text')],
    legacy: ['ok', '✓', t('runs.r_legacy_title'), t('runs.r_legacy_text')],
  }[o] ?? ['wait', '·', t('runs.r_none_title'), t('runs.r_none_text')];
  const [cls, icon, title, text] = V;
  const proc = r.cancel_requested_at && r.finalized_at ? dur(r.finalized_at - r.cancel_requested_at) : null;
  const rows = kvList(
    [t('runs.final_state'), r.finalized_at || !(r.state === 'queued' || r.state === 'running') ? runBadge(r) : el('span', {}, runBadge(r), el('span', { class: 'faint' }, t('runs.unsettled_sfx')))],
    r.cancel_requested_at ? [t('runs.cancel_requested_at'), when(r.cancel_requested_at)] : null,
    [t('runs.cancel_proc_time'), proc ?? (o === 'requested' ? el('span', {}, t('runs.in_progress_left'), countdown(r.cancel_deadline_at)) : '—')],
    [t('runs.affected_agent'), d.agent.name],
    [t('runs.conversation'), el('a', { href: `#${d.thread.id}` }, convLabel(d.thread.kind, d.thread.title))],
    o === 'no_ack' || o === 'unknown' ? [t('runs.last_checked'), r.last_checked_at ? when(r.last_checked_at) : t('runs.judged_at', { time: when(r.finalized_at ?? r.ended_at) })] : null,
  );
  $('rp-result').replaceChildren(
    backLink(),
    el(
      'div',
      { class: `result-card ${cls}`, role: 'status', 'aria-live': 'polite', 'data-outcome': o ?? '' },
      el('div', { class: 'result-icon', 'aria-hidden': 'true' }, icon),
      el('h2', { id: 'rr-h', tabindex: '-1' }, title),
      el('p', {}, text),
      rows,
      el(
        'div',
        { class: 'modal-actions' },
        o === 'no_ack' || o === 'unknown' ? el('button', { type: 'button', id: 'rr-refresh', onclick: () => refreshRunAsk(r.id) }, t('runs.refresh')) : null,
        el('a', { href: `#${d.thread.id}`, class: 'btnlike' }, t('runs.to_conversation')),
        el('a', { href: `#run/${encodeURIComponent(r.id)}`, class: 'btnlike primary' }, t('runs.to_detail')),
      ),
    ),
  );
}

/** 실행 화면이 열려 있을 때 알림이 오면 다시 읽는다(짧게 묶음) */
let runsReloadTimer = null;
function refreshRunsPage() {
  if (S.mode !== 'runs') return;
  clearTimeout(runsReloadTimer);
  runsReloadTimer = setTimeout(() => {
    if (S.mode !== 'runs') return;
    if (S.runsPane === 'list') loadRunsPage();
    else if (S.rdId) loadRunDetail(S.rdId);
  }, 150);
}

function initRuns() {
  for (const id of ['rf-state', 'rf-agent', 'rf-thread', 'rf-since']) $(id).addEventListener('change', onRunFilter);
  // 남은 시간: 1초마다. 0 이 되면 서버 판정(무응답 → unknown)을 다시 읽는다
  setInterval(() => {
    let expired = false;
    for (const e of document.querySelectorAll('[data-until]')) {
      const left = Math.ceil((Number(e.dataset.until) - Date.now()) / 1000);
      e.textContent = t('runs.sec', { n: Math.max(0, left) });
      if (left <= 0 && !e.dataset.fired) {
        e.dataset.fired = '1';
        expired = true;
      }
    }
    if (expired) {
      setTimeout(() => {
        refreshRunsPage();
        if (S.cur && S.mode === 'convo') loadRuns().catch(() => {});
      }, 400);
    }
  }, 1000);
}

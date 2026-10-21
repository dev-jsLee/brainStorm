// brainStorm 실행 화면(기획 대조 2단계): 실행 상태 목록(n43) · 실행 상세(n46) · 취소 결과(n50 + 변형).
// app.js 보다 먼저 읽히지만 함수만 정의한다 — 실제 호출은 app.js 의 라우터(route)가 한다. app.js 의 전역($·S·el·api…)을 쓴다.
// 판정은 서버가 한다(run.cancel_outcome). 화면은 그 값과 시각 칸을 그대로 보여 준다.
'use strict';

/** 서버 이벤트 이름 → 화면 문구 */
const RUN_EVENT = {
  created: '실행 만들어짐(전달 받음)',
  started: '실행 시작',
  cancel_requested: '취소 요청',
  cancel_repeat: '취소 요청 반복 — 이미 요청됨',
  stop_sent: '중단 명령 전달(heartbeat 응답)',
  stop_ack: '어댑터 중단 확인',
  completed: '완료 보고',
  failed: '실패 보고',
  lease_expired: '어댑터 응답 끊김(lease 만료)',
  cancel_ack_timeout: '중단 확인 없음 — 무응답 제한 경과',
  finalized: '최종 상태 확정',
  late_complete: '늦게 온 완료 — 반영 안 함',
  late_fail: '늦게 온 실패 — 반영 안 함',
  late_stop_ack: '늦게 온 중단 확인 — 반영 안 함',
  cancel_after_final: '취소 요청 — 이미 끝난 실행(상태 유지)',
  checked: '상태 새로 확인',
  withdrawn: '«새 호출 금지»로 거둠',
  rotated: '세션 교체로 취소',
};

function rpQuery() {
  return S.rp ?? (S.rp = { state: '', agent: '', thread: '', since: store('bs.runs-since') ?? '3600000' });
}
const ackSec = () => Math.round((S.cancelAckMs ?? 30000) / 1000);
const shortId = (id) => (id.length > 14 ? `${id.slice(0, 12)}…` : id);
function convLabel(kind, title) {
  return el('span', { class: 'conv' }, el('span', { class: `pill ${kind === 'room' ? 'room' : ''}` }, kind === 'room' ? '채팅방' : '스레드'), ' ', title);
}
function countdown(until) {
  return el('span', { 'data-until': String(until) }, `${Math.max(0, Math.ceil((until - Date.now()) / 1000))}초`);
}
function outcomeEl(r) {
  if (!r.cancel_outcome) return el('span', { class: 'faint' }, '—');
  const o = el('span', { class: `oc oc-${r.cancel_outcome}` }, OUTCOME[r.cancel_outcome] ?? r.cancel_outcome);
  if (r.cancel_outcome === 'requested' && r.cancel_deadline_at) return el('span', {}, o, el('span', { class: 'faint' }, ' · 남은 '), countdown(r.cancel_deadline_at));
  return o;
}
function elapsedEl(r) {
  if (r.state === 'queued') return el('span', { class: 'faint' }, '시작 전');
  if (r.state === 'running') return el('span', { 'data-since': String(r.started_at ?? r.created_at) }, dur(Date.now() - (r.started_at ?? r.created_at)));
  return r.ended_at ? dur(r.ended_at - (r.started_at ?? r.created_at)) : '—';
}
/** 오늘이면 HH:MM:SS, 아니면 YYYY-MM-DD HH:MM:SS (시안 n46 꼴) */
const when = (t) => {
  if (!t) return '—';
  const d = new Date(t);
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
  $('rf-agent').replaceChildren(el('option', { value: '' }, '전체'), ...agents.map((a) => el('option', { value: a.id }, a.name)));
  $('rf-thread').replaceChildren(
    el('option', { value: '' }, '전체'),
    ...S.threads.map((t) => el('option', { value: t.id }, `${t.kind === 'room' ? '[채팅방] ' : ''}${t.title}`)),
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
    if (my === runsPageSeq) $('rp-table').replaceChildren(el('p', { class: 'err' }, `실행 목록을 불러오지 못했습니다: ${e.message}`));
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
  $('rp-total').textContent = `총 ${n}건${r.waiting.length ? ` (전달 대기 ${r.waiting.length})` : ''}${r.runs.length < r.total ? ` · 최근 ${r.runs.length}건 표시` : ''}`;
  if (!n) return $('rp-table').replaceChildren(el('p', { class: 'muted empty-runs' }, '조건에 맞는 실행이 없습니다.'));
  const narrow = isNarrow();
  const waitRow = (d) => {
    const cancel = el('button', { type: 'button', class: 'danger small-btn', onclick: () => cancelDeliveryAsk(d) }, '전달 취소');
    const cells = {
      id: el('code', { class: 'rid', title: d.id }, shortId(d.id)),
      st: el('span', { class: `badge st-${d.status}` }, d.status === 'leased' ? '받는 중' : '전달 대기'),
      agent: pname(d.recipient_id),
      conv: el('a', { href: `#${d.thread_id}` }, convLabel(d.thread_kind, d.thread_title)),
      start: el('span', { class: 'faint' }, `메시지 #${d.message_seq}`),
      dur: el('span', {}, '대기 ', el('span', { 'data-since': String(d.created_at) }, dur(Date.now() - d.created_at))),
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
      act: el('a', { href: `#run/${encodeURIComponent(x.id)}`, class: 'detail-link' }, narrow ? '상태 보기' : '상세'),
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
      el('div', { class: 'rc2 muted small' }, c.start, ' · ', c.dur, ' · 중단 결과 ', c.oc),
      el('div', { class: 'rc3' }, c.act),
    );
  if (narrow) {
    $('rp-table').replaceChildren(el('ul', { class: 'rcards' }, ...r.waiting.map(waitRow), ...r.runs.map(runRow)));
  } else {
    $('rp-table').replaceChildren(
      el(
        'table',
        { class: 'rtable' },
        el('thead', {}, el('tr', {}, ...['실행 ID', '상태', '대상 에이전트', '대화', '시작 시각', '소요 시간', '중단 결과', '상세'].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, ...r.waiting.map(waitRow), ...r.runs.map(runRow)),
      ),
    );
  }
}
async function cancelDeliveryAsk(d) {
  const ok = await ask({
    title: '전달 취소',
    text: `${pname(d.recipient_id)} 앞 전달(메시지 #${d.message_seq})을 거둡니다. 아직 실행이 생기지 않았으므로 어댑터는 이 메시지를 받지 않습니다.`,
    ok: '전달 취소',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api('POST', `/api/deliveries/${encodeURIComponent(d.id)}/cancel`);
    announce(r.outcome === 'cancelled' ? '전달을 거뒀습니다' : '이미 끝난 전달입니다');
  } catch (e) {
    await notify('전달 취소 안 됨', e.code === 'has_run' ? '어댑터가 이미 받아 실행이 생겼습니다 — 실행 목록에서 그 실행을 취소하세요.' : e.message);
  }
  if (S.mode === 'runs') await loadRunsPage();
  if (S.cur) loadRuns().catch(() => {});
}

// ───── 실행 상세 (n46) ─────
async function showRun(id) {
  S.rdId = id;
  showRunsPane('detail');
  if (!S.rd || S.rd.run.id !== id) $('rp-detail').replaceChildren(el('p', { class: 'muted' }, '실행을 불러오는 중…'));
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
        el('p', { class: 'err' }, e.status === 404 ? '이 실행을 열 수 없습니다(없거나 권한 밖).' : `불러오지 못했습니다: ${e.message}`),
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
  return el('a', { href: '#runs', class: 'back' }, '← 실행 상태');
}
function kvList(...pairs) {
  return el('dl', { class: 'kv' }, ...pairs.filter(Boolean).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
}
function excerpt(m, n = 160) {
  if (!m) return el('span', { class: 'faint' }, '없음');
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
    el('h2', { id: 'rd-h', tabindex: '-1' }, '실행 상세'),
    runBadge(r),
    el('span', { class: 'spacer' }),
    el('button', { type: 'button', id: 'rd-refresh', onclick: () => refreshRunAsk(r.id) }, '상태 새로 확인'),
    el('button', { type: 'button', id: 'rd-cancel', class: 'primary danger-fill', disabled: !canCancel, title: canCancel ? '' : active ? '이미 중단을 요청했습니다' : '이미 끝난 실행입니다', onclick: () => cancelRunAsk(r, { from: 'detail' }) }, r.cancel_requested_at && active ? '중단 요청됨' : '실행 취소 요청'),
  );
  const tokens = r.usage && typeof r.usage === 'object' ? r.usage.tokens : null;
  const outTok = tokens && typeof tokens === 'object' ? tokens.completion_tokens ?? tokens.output_tokens ?? null : null;
  const t = d.thread;
  const conv = el('a', { href: `#${t.id}` }, convLabel(t.kind, threadById(t.id) ? pathOf(threadById(t.id)) : t.title));
  const basic = el(
    'section',
    { class: 'dcard' },
    el('h3', {}, '기본 정보'),
    kvList(
      ['실행 ID', el('code', {}, r.id)],
      ['에이전트', d.agent.name],
      ['대화', conv],
      ['원인 메시지', `#${r.trigger_seq}`],
      ['호출 시각', when(r.created_at)],
      ['시작 시각', r.started_at ? when(r.started_at) : el('span', { class: 'faint' }, '시작 전')],
      ['종료 시각', r.ended_at ? when(r.ended_at) : el('span', { class: 'faint' }, active ? '아직 안 끝남' : '—')],
      ['소요 시간', elapsedEl(r)],
      ['현재 상태', runBadge(r)],
      ['어댑터 신호', r.heartbeat_at ? `마지막 ${when(r.heartbeat_at)}` : el('span', { class: 'faint' }, '기록 없음')],
      ['최근 경과', r.progress ? `${r.progress} (${when(r.progress_at)})` : el('span', { class: 'faint' }, '기록 없음')],
      ['마지막 상태 확인', r.last_checked_at ? when(r.last_checked_at) : el('span', { class: 'faint' }, '아직 안 함')],
    ),
  );
  const seqs = d.input.seqs;
  const input = el(
    'section',
    { class: 'dcard' },
    el('h3', {}, '실행 입력'),
    kvList(
      ['입력 메시지', excerpt(d.input.trigger)],
      ['넘긴 메시지', seqs.length ? `${seqs.slice(0, 12).map((s) => `#${s}`).join(', ')}${seqs.length > 12 ? ' …' : ''} (${seqs.length}개)` : el('span', { class: 'faint' }, '없음')],
      ['전달된 맥락 세대', d.session ? `세션 세대 ${d.session.generation} (${d.session.status === 'active' ? '활성' : '종료'})` : `${r.generation}세대`],
      ['작업자', d.input.worker ?? '—'],
    ),
  );
  const output = el(
    'section',
    { class: 'dcard' },
    el('h3', {}, '실행 출력'),
    kvList(
      ['응답 메시지', excerpt(d.output.message)],
      ['실제 모델', d.session?.actual_model ?? el('span', { class: 'faint' }, '기록 없음')],
      ['런타임 · 설정 버전', `${d.session?.runtime ?? '—'} · ${d.session?.config_version ?? '—'}`],
      ['출력 토큰 수', outTok != null ? `${Number(outTok).toLocaleString('ko-KR')} 토큰` : el('span', { class: 'faint' }, '어댑터가 보고하지 않음')],
      r.error ? ['사유', RUN_ERR[r.error] ?? r.error] : null,
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
      el('b', {}, '중단 요청됨'),
      el('span', {}, `어댑터의 중단 확인을 기다립니다. ${ackSec()}초 안에 확인이 없으면 ‘상태 미확인’으로 두고 자동 재실행하지 않습니다 · 남은 `, countdown(r.cancel_deadline_at)),
    );
  if (r.state === 'unknown')
    return el(
      'div',
      { class: 'banner bad', role: 'status' },
      el('b', {}, '실행 상태 미확인'),
      el(
        'span',
        {},
        r.error === 'cancel_ack_timeout' ? `어댑터가 ${ackSec()}초 안에 중단을 확인하지 않았습니다.` : '어댑터 응답이 끊겨 결과를 확인하지 못했습니다.',
        ' 자동 재실행되지 않았습니다. 마지막 상태 확인: ',
        el('b', {}, r.last_checked_at ? when(r.last_checked_at) : `${when(r.finalized_at ?? r.ended_at)} (판정 시각)`),
      ),
      where === 'detail' ? null : el('button', { type: 'button', onclick: () => refreshRunAsk(r.id) }, '상태 새로 확인'),
    );
  if (r.cancel_outcome === 'completed_first')
    return el('div', { class: 'banner warn', role: 'status' }, el('b', {}, '완료 우선 확정'), el('span', {}, '취소 요청 중에 실행이 먼저 완료되었습니다. 답 메시지는 대화에 그대로 남습니다.'));
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
    ? step('취소 요청', st('요청 완료', 'done'), `${when(r.cancel_requested_at)} · ${r.cancel_requested_by ? pname(r.cancel_requested_by) : ''}`)
    : o === 'legacy'
      ? step('취소 요청', st('요청 완료', 'done'), '이전 방식(즉시 취소) — 시각 기록 없음')
      : step('취소 요청', st(active ? '요청 전' : '요청 없음', 'none'));
  const block = step('새 호출 차단', st('해당 없음', 'none'), '에이전트 간 호출이 꺼져 있어 이 실행에서 파생되는 호출이 없습니다');
  let ack;
  if (!o) ack = step('어댑터 중단 확인', st('—', 'none'));
  else if (o === 'queued_cancelled') ack = step('어댑터 중단 확인', st('해당 없음', 'none'), '시작 전에 취소 — 어댑터는 실행하지 않습니다');
  else if (o === 'acked') ack = step('어댑터 중단 확인', st('확인됨', 'done'), when(r.stop_ack_at));
  else if (o === 'requested')
    ack = step(
      '어댑터 중단 확인',
      st('대기 중', 'wait'),
      el('span', {}, r.stop_sent_at ? `중단 명령 전달 ${when(r.stop_sent_at)}` : '다음 heartbeat 에 중단 명령이 실립니다', ' · 남은 ', countdown(r.cancel_deadline_at)),
    );
  else if (o === 'no_ack') ack = step('어댑터 중단 확인', st('응답 없음', 'bad'), `${ackSec()}초 경과${r.stop_sent_at ? ` · 중단 명령 전달 ${when(r.stop_sent_at)}` : ' · 중단 명령도 전달되지 못함'}`);
  else if (o === 'completed_first' || o === 'failed_first') ack = step('어댑터 중단 확인', st('확인 전 종료', 'wait'), '중단 확인보다 종료 보고가 먼저 왔습니다');
  else ack = step('어댑터 중단 확인', st('해당 없음', 'none'), OUTCOME[o]);
  const late = ev.filter((e) => e.event.startsWith('late_'));
  const after = ev.find((e) => e.event === 'cancel_after_final');
  let race;
  if (o === 'completed_first') race = step('완료 결과 경합', st('기록됨', 'done'), '완료가 중단 확인보다 먼저 도착 — 완료 우선 확정');
  else if (o === 'failed_first') race = step('완료 결과 경합', st('기록됨', 'done'), '실패가 중단 확인보다 먼저 도착 — 실패 유지');
  else if (late.length) race = step('완료 결과 경합', st('기록됨', 'done'), `확정 뒤 늦게 온 결과 ${late.length}건(${late.map((e) => RUN_EVENT[e.event]).join(', ')}) — 상태는 바꾸지 않음`);
  else if (after) race = step('완료 결과 경합', st('기록됨', 'done'), `취소 요청 전에 이미 끝남(${STATE[after.detail?.state] ?? ''}) — 상태 유지`);
  else race = step('완료 결과 경합', st(o === 'requested' ? '아직 없음' : '없음', 'none'));
  const fin = r.finalized_at
    ? step('최종 실행 상태 확정', st(stateLabel(r), r.state === 'succeeded' ? 'done' : r.state === 'cancelled' ? 'done' : 'bad'), when(r.finalized_at))
    : active
      ? step('최종 실행 상태 확정', st('미확정', 'wait'))
      : step('최종 실행 상태 확정', st(stateLabel(r), 'done'), '확정 시각 기록 전(이전 실행)');
  return el(
    'section',
    { class: 'dcard' },
    el('h3', {}, '취소 처리 상태'),
    el('ol', { class: 'steps' }, req, block, ack, race, fin),
    el('p', { class: 'muted small' }, `서버는 어댑터의 중단 확인과 완료 보고 가운데 먼저 도착한 것으로 최종 상태를 한 번만 확정합니다. ${ackSec()}초 안에 둘 다 없으면 ‘상태 미확인’으로 두고 자동 재실행하지 않습니다.`),
  );
}
function evDetail(e) {
  const x = e.detail ?? {};
  if (e.event === 'finalized') return `${STATE[x.state] ?? x.state}${x.completed_first ? ' (완료 우선)' : x.failed_first ? ' (실패 우선)' : x.before_start ? ' (시작 전)' : ''}`;
  if (e.event === 'failed') return x.error ?? '';
  if (e.event === 'completed') return `답 #${x.result_seq}${x.during_cancel ? ' · 취소 요청 중' : ''}`;
  if (e.event.startsWith('late_') || e.event === 'cancel_after_final' || e.event === 'checked') return `그때 상태: ${STATE[x.state] ?? x.state}`;
  if (e.event === 'cancel_ack_timeout') return `${Math.round((x.waited_ms ?? 0) / 1000)}초 기다림`;
  if (e.event === 'stop_ack' && x.waited_ms != null) return `요청 뒤 ${dur(x.waited_ms)}`;
  if (e.event === 'created') return `${x.generation}세대 · 작업자 ${x.worker ?? '?'} · 맥락 ${x.context ?? '?'}개`;
  if (e.event === 'started') return [x.runtime, x.config_version].filter(Boolean).join(' · ');
  return '';
}
function evSource(s) {
  if (s === 'server') return '서버';
  const p = S.participants.get(s);
  return p ? `${p.name} (${p.kind === 'agent' ? '어댑터' : '마스터'})` : s;
}
function eventLog(d) {
  const r = d.run;
  let rows = d.events.map((e) => [e.at, `${RUN_EVENT[e.event] ?? e.event}${evDetail(e) ? ` — ${evDetail(e)}` : ''}`, evSource(e.source), e.event]);
  let note = null;
  if (!rows.length) {
    // 마이그레이션 4 전 실행: 이벤트가 없다 — 시각 칸에서 복원해 보여 준다
    rows = [
      [r.created_at, RUN_EVENT.created, '서버', 'created'],
      r.started_at ? [r.started_at, RUN_EVENT.started, pname(r.agent_id), 'started'] : null,
      r.ended_at ? [r.ended_at, `종료 — ${STATE[r.state]}${r.error ? ` (${RUN_ERR[r.error] ?? r.error})` : ''}`, '—', 'ended'] : null,
    ].filter(Boolean);
    note = el('p', { class: 'muted small' }, '이 실행은 이벤트 기록이 생기기 전(마이그레이션 4 전)에 만들어졌습니다 — 시각 칸에서 복원한 줄입니다.');
  }
  return el(
    'section',
    { class: 'dcard' },
    el('h3', {}, '이벤트 로그'),
    note,
    el(
      'table',
      { class: 'hist evlog' },
      el('thead', {}, el('tr', {}, el('th', {}, '시각'), el('th', {}, '이벤트'), el('th', {}, '출처'))),
      el('tbody', {}, ...rows.map(([at, txt, src, ev]) => el('tr', { class: /^late_|timeout|lease/.test(ev) ? 'evbad' : '' }, el('td', {}, when(at)), el('td', {}, txt), el('td', {}, src)))),
    ),
  );
}

// ───── 취소 요청 · 결과 (n50 + 변형) ─────
/** 메시지 행·보조 패널·상세 공통. 상세에서 부르면 결과 화면으로 간다 */
async function cancelRunAsk(r, opt = {}) {
  const ok = await ask({
    title: '에이전트 실행 취소',
    text: `${pname(r.agent_id)}의 ${stateLabel(r)} 실행(원인 #${r.trigger_seq})을 취소합니다. 대기 중이거나 실행 중인 에이전트 호출을 취소합니다. 완료된 실행은 되돌릴 수 없습니다. 실행 중이면 어댑터에 중단을 요청하고, ${ackSec()}초 안에 확인이 없으면 ‘상태 미확인’으로 둡니다(자동 재실행 없음).`,
    ok: '실행 취소',
    danger: true,
  });
  if (!ok) return null;
  let res;
  try {
    res = await api('POST', `/api/runs/${encodeURIComponent(r.id)}/cancel`);
  } catch (e) {
    await notify('실행 취소 안 됨', e.message);
    return null;
  }
  S.cancelResult = { id: r.id, outcome: res.outcome, prevState: res.state };
  const msg = {
    cancelled: '대기 중 실행을 취소했습니다',
    requested: '중단을 요청했습니다 — 어댑터 확인 대기',
    already_requested: '이미 중단을 요청한 실행입니다',
    already_final: `이미 끝난 실행입니다(${STATE[res.state] ?? res.state}) — 상태를 바꾸지 않았습니다`,
  }[res.outcome];
  announce(msg);
  if (opt.from === 'detail') location.hash = `run/${encodeURIComponent(r.id)}/cancel`;
  else if (res.outcome === 'already_final') notify('이미 끝난 실행', `${msg}. 실행 상세에서 최종 상태와 이벤트를 볼 수 있습니다.`);
  if (S.cur) loadRuns().catch(() => {});
  return res;
}
async function refreshRunAsk(id) {
  const before = S.rd?.run;
  const d = await loadRunDetail(id, 'refresh');
  if (!d) return;
  const same = before && before.id === id && before.state === d.run.state;
  announce(same ? `상태가 바뀌지 않았습니다 — ${stateLabel(d.run)} · 마지막 확인 ${fmtHm(d.run.last_checked_at)}` : `현재 상태: ${stateLabel(d.run)}`);
  if (S.cur) loadRuns().catch(() => {});
}
async function showCancelResult(id) {
  S.rdId = id;
  showRunsPane('result');
  $('rp-result').replaceChildren(el('p', { class: 'muted' }, '결과를 불러오는 중…'));
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
    acked: ['ok', '✓', '실행 취소 요청 완료', '에이전트 작업이 안전하게 종료되었습니다. 어댑터가 중단을 확인했습니다.'],
    queued_cancelled: ['ok', '✓', '대기 중 취소 완료', '실행이 시작되기 전에 취소했습니다. 어댑터는 이 실행을 돌리지 않습니다.'],
    requested: ['wait', '…', '중단 요청됨', `어댑터에 중단을 요청했습니다. 어댑터가 확인하면 ‘취소됨’으로, ${s}초 안에 확인이 없으면 ‘상태 미확인’으로 확정합니다.`],
    no_ack: ['bad', '?', '실행 상태 미확인', `어댑터가 ${s}초 안에 중단을 확인하지 않았습니다. 자동 재실행되지 않았습니다.`],
    unknown: ['bad', '?', '실행 상태 미확인', '어댑터 응답이 끊겨 실행 결과를 확인하지 못했습니다. 자동 재실행되지 않았습니다.'],
    completed_first: ['warn', '!', '완료 우선 확정', '취소 요청 중에 실행이 먼저 완료되었습니다. 최종 상태는 ‘완료’이고 답 메시지는 대화에 그대로 남습니다.'],
    failed_first: ['warn', '!', '실패 우선 확정', '취소 요청 중에 실행이 먼저 실패로 끝났습니다. 최종 상태는 ‘실행 실패’입니다.'],
    already_final: ['warn', '!', r.state === 'succeeded' ? '이미 완료된 실행' : '이미 끝난 실행', `취소 요청 전에 실행이 이미 ‘${STATE[r.state]}’ 상태로 끝났습니다. 상태를 바꾸지 않았습니다.`],
    withdrawn: ['ok', '✓', '«새 호출 금지»로 거둔 실행', '시작 전에 거뒀습니다. 어댑터는 이 실행을 돌리지 않습니다.'],
    rotated: ['ok', '✓', '세션 교체로 취소된 실행', '옛 세대의 실행이라 교체 때 닫혔습니다.'],
    legacy: ['ok', '✓', '취소된 실행', '이전 방식(즉시 취소)으로 취소된 실행입니다.'],
  }[o] ?? ['wait', '·', '취소 요청 기록 없음', '이 실행에는 취소 요청이 없습니다. 실행 상세에서 상태를 보세요.'];
  const [cls, icon, title, text] = V;
  const proc = r.cancel_requested_at && r.finalized_at ? dur(r.finalized_at - r.cancel_requested_at) : null;
  const rows = kvList(
    ['최종 상태', r.finalized_at || !(r.state === 'queued' || r.state === 'running') ? runBadge(r) : el('span', {}, runBadge(r), el('span', { class: 'faint' }, ' (미확정)'))],
    r.cancel_requested_at ? ['취소 요청 시각', when(r.cancel_requested_at)] : null,
    ['취소 처리 시간', proc ?? (o === 'requested' ? el('span', {}, '진행 중 · 남은 ', countdown(r.cancel_deadline_at)) : '—')],
    ['영향받은 에이전트', d.agent.name],
    ['대화', el('a', { href: `#${d.thread.id}` }, convLabel(d.thread.kind, d.thread.title))],
    o === 'no_ack' || o === 'unknown' ? ['마지막 상태 확인', r.last_checked_at ? when(r.last_checked_at) : `${when(r.finalized_at ?? r.ended_at)} (판정 시각)`] : null,
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
        o === 'no_ack' || o === 'unknown' ? el('button', { type: 'button', id: 'rr-refresh', onclick: () => refreshRunAsk(r.id) }, '상태 새로 확인') : null,
        el('a', { href: `#${d.thread.id}`, class: 'btnlike' }, '대화로'),
        el('a', { href: `#run/${encodeURIComponent(r.id)}`, class: 'btnlike primary' }, '실행 상세로'),
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
      e.textContent = `${Math.max(0, left)}초`;
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

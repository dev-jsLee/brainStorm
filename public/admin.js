// brainStorm 관리 화면(기획 대조 3단계): 감사 기록(n76) · 에이전트 연결(기획서 2.1 → «에이전트 연결 상태», 마스터 결정 1·2) · 멤버 권한.
// runs.js 처럼 함수만 정의한다 — 호출은 app.js 의 라우터가 한다. app.js 의 전역($·S·el·api·ask·notify·announce…)을 쓴다.
// 토큰 발급은 화면에 없다(결정 2 — CT 안 CLI → 600 파일). 연결 화면은 조회·폐기만.
'use strict';

/** 작업 유형 → 화면 문구 */
const AUDIT_ACTION = {
  'auth.login': '로그인',
  'auth.token': '토큰 인증',
  'credential.create': '토큰 발급',
  'credential.revoke': '토큰 폐기',
  'participant.create': '참여자 등록',
  'participant.rename': '참여자 이름 변경',
  'passphrase.set': '패스프레이즈 변경',
  'websession.create': '웹 세션 발급',
  'websession.revoke': '웹 세션 끊기',
  'websession.revoke_all': '웹 세션 모두 끊기',
  'thread.create': '스레드 생성',
  'thread.fork': '스레드 분기',
  'thread.read': '대화 열람',
  'thread.post': '게시·호출',
  'thread.stop': '새 호출 금지·현재 실행 취소',
  'thread.resume': '호출 재개',
  'thread.archive': '스레드 보관',
  'thread.unarchive': '스레드 보관 해제',
  'thread.hide': '스레드 숨김',
  'thread.unhide': '스레드 숨김 해제',
  'thread.trash': '스레드 휴지통',
  'thread.restore': '스레드 복구',
  'thread.purge': '스레드 영구 삭제',
  'member.set': '멤버 권한 부여·변경',
  'member.remove': '멤버 회수',
  'session.rotate': '세션 교체',
  'run.cancel': '실행 취소·중단',
  'run.read': '실행 열람',
  'run.refresh': '실행 상태 확인',
  'runs.view': '실행 목록 조회',
  'delivery.cancel': '전달 취소',
  'request.create': '에이전트 간 요청',
  'request.hold': '요청 보류',
  'request.hold_ack': '보류된 요청 확인',
  'request.holds_view': '보류된 요청 조회',
  'request_pair.add': '요청 허용 짝 추가',
  'request_pair.remove': '요청 허용 짝 삭제',
  'audit.view': '감사 기록 조회',
  'connections.view': '연결 상태 조회',
  'agents.view': '에이전트 상태 조회',
  'attachment.add': '첨부 올리기',
  'attachment.read': '첨부 받기',
  'adapter.claim': '어댑터 작업 가져오기',
  'adapter.ack': '어댑터 전달 확인',
  'adapter.run': '어댑터 실행 보고',
};
/** 이벤트 유형 필터의 묶음(정책 9 적용 범위 순) */
const AUDIT_GROUPS = [
  ['credential.*', '자격 증명 발급·폐기'],
  ['member.*', '멤버 권한 부여·회수'],
  ['session.rotate', '세션 교체'],
  ['run.cancel', '실행 취소·중단'],
  ['request.*', '에이전트 간 요청·보류'],
  ['auth.*', '인증(로그인·토큰 거절)'],
  ['audit.view', '감사 기록 조회'],
];
const AUDIT_RESULT = { ok: '성공', requested: '요청됨', noop: '변화 없음', denied: '거부', failed: '실패' };
/** 사유 코드 → 화면 문구. 모르는 코드는 코드 그대로 */
const AUDIT_REASON = {
  token_revoked: '폐기된 토큰',
  token_expired: '만료된 토큰',
  token_unknown: '모르는 토큰',
  token_malformed: '토큰 형식 오류',
  participant_disabled: '비활성 참여자',
  not_member: '멤버 아님(열람 권한 없음)',
  master_only: '마스터 전용',
  adapter_scope_required: '어댑터 권한 없음',
  impersonation: '사칭(다른 작성자로)',
  no_post_permission: '게시 권한 없음',
  no_invoke_permission: '호출 권한 없음',
  agent_invocation_disabled: '에이전트 간 호출 꺼짐',
  request_pair_not_allowed: '허용 짝이 아닌 요청',
  request_chain_limit: '요청 연쇄 상한 — 마스터 확인 필요',
  invoke_paused: '새 호출 금지 중',
  already_acked: '이미 확인함',
  already_allowed: '이미 허용됨',
  not_allowed: '허용 짝 아님',
  source_kind_forbidden: '에이전트는 «지시»로 못 씀',
  bad_input_mode: '입력 방식 거부',
  not_owner: '남의 작업',
  not_author: '작성자 아님',
  bad_passphrase: '패스프레이즈 틀림',
  too_many_attempts: '시도 초과(잠김)',
  already_revoked: '이미 폐기됨',
  no_credential: '없는 자격 증명',
  unchanged: '바뀐 것 없음',
  duplicate: '같은 요청 재시도(처음 결과)',
  already_requested: '이미 중단 요청됨',
  already_final: '이미 끝난 실행',
  queued_cancelled: '대기 중 취소',
  acked: '어댑터 중단 확인',
  no_ack: '중단 확인 없음 → 상태 미확인',
  completed_first: '완료 우선 확정',
  failed_first: '실패 우선 확정',
  lease_expired: '어댑터 응답 끊김',
  rotated: '세션 교체로 닫힘',
  has_run: '이미 실행이 생김',
  bad_member: '없는 참여자',
  bad_agent: '멤버가 아닌 에이전트',
  weak_passphrase: '패스프레이즈가 짧음',
  not_agent: '에이전트가 아님',
  stop_new: '새 호출 금지',
  cancel_current: '현재 실행 취소',
  no_session: '없는 세션',
};
/** 상태 칸(before/after) 키 → 화면 문구 */
const AUDIT_KEY = {
  state: '실행 상태',
  status: '상태',
  member: '멤버',
  can_read: '읽기',
  can_post: '게시',
  can_invoke: '호출',
  generation: '세대',
  session_id: '세션',
  cancelled_runs: '닫힌 실행',
  cancel_requested_runs: '중단 요청한 실행',
  withdrawn_deliveries: '거둔 전달',
  invoke_paused: '새 호출 금지',
  participant_id: '참여자',
  label: '라벨',
  scope: '범위',
  expires_at: '만료',
  revoked_at: '폐기 시각',
  members: '멤버',
  default_recipient: '기본 수신자',
  parent_thread_id: '부모 대화',
  fork_seq: '분기 시점',
  included: '가져온 메시지',
  reason: '사유',
  confirmed_by: '확인한 어댑터',
  ack_limit_ms: '무응답 제한',
  cancel_requested: '중단 요청',
  via: '경로',
  ip: '주소',
  filters: '조건',
  page: '쪽',
  kind: '구분',
  is_master: '마스터',
  room_member: '메인 채팅방 멤버',
  name: '이름',
  minutes: '유효(분)',
  removed: '끊은 세션',
  web_sessions_removed: '끊은 웹 세션',
  run_id: '실행',
  recipient_id: '수신자',
  message_seq: '메시지',
  status_code: '응답 코드',
};

function actorLabel(id, kind) {
  if (kind === 'cli' || id === 'cli:root') return '관리 CLI (root)';
  if (kind === 'server' || id === 'server') return '서버';
  if (kind === 'anonymous' || id === 'anonymous') return '알 수 없음';
  const p = S.participants.get(id);
  if (!p) return id;
  return p.is_master ? `${p.name} (마스터)` : p.name;
}
function auditActionLabel(a) {
  return AUDIT_ACTION[a] ?? a;
}
function fmtVal(k, v) {
  if (v === null || v === undefined) return '없음';
  if (typeof v === 'boolean') return v ? '예' : '아니오';
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'string' ? pname(x) : String(x))).join(', ') : '없음';
  if (typeof v === 'object') return Object.entries(v).map(([kk, vv]) => `${AUDIT_KEY[kk] ?? kk} ${fmtVal(kk, vv)}`).join(' · ');
  if (typeof v === 'number' && /_at$/.test(k)) return when(v);
  if (k === 'ack_limit_ms') return `${Math.round(v / 1000)}초`;
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
  if (e.target_type === 'credential') parts.push(`자격 증명 ${e.target_id}${owner ? ` · ${pname(owner)}` : ''}`);
  else if (e.target_type === 'participant' || e.target_type === 'agent') parts.push(e.target_id ? `${e.target_type === 'agent' ? '에이전트' : '참여자'} ${pname(e.target_id)}` : '참여자');
  else if (e.target_type === 'thread') parts.push(th ? '' : `대화 ${e.target_id}`);
  else if (e.target_type === 'run') parts.push(`실행 ${shortId(e.target_id)}`);
  else if (e.target_type === 'delivery') parts.push(`전달 ${shortId(e.target_id)}`);
  else if (e.target_type === 'audit') parts.push('감사 기록');
  else if (e.target_type === 'web_session') parts.push('웹 세션');
  else if (e.target_type) parts.push(`${e.target_type} ${e.target_id ?? ''}`);
  const scope = th ? convLabel(th.kind, th.title) : e.thread_id ? el('span', { class: 'faint' }, `대화 ${shortId(e.thread_id)}`) : null;
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
    if (my === auSeq) $('au-table').replaceChildren(el('p', { class: 'err' }, `감사 기록을 불러오지 못했습니다: ${e.message}`));
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
    el('option', { value: '' }, '전체'),
    el('optgroup', { label: '묶음' }, ...AUDIT_GROUPS.map(([v, t]) => el('option', { value: v }, t))),
    el('optgroup', { label: '개별 유형' }, ...acts.map((a) => el('option', { value: a }, `${auditActionLabel(a)} (${a})`))),
  );
  const actors = [...(r?.actors ?? [])];
  if (q.actor && !actors.some((a) => a.id === q.actor)) actors.push({ id: q.actor, kind: '' });
  $('af-actor').replaceChildren(el('option', { value: '' }, '전체'), ...actors.map((a) => el('option', { value: a.id }, actorLabel(a.id, a.kind))));
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
    const t = threadById(q.thread);
    chips.push(el('span', { class: 'chip on' }, `대화: ${t ? t.title : q.thread}`, el('button', { type: 'button', class: 'icon', 'aria-label': '대화 조건 지우기', onclick: drop('thread') }, '×')));
  }
  if (q.corr) chips.push(el('span', { class: 'chip on' }, `감사 식별자: ${q.corr}`, el('button', { type: 'button', class: 'icon', 'aria-label': '감사 식별자 조건 지우기', onclick: drop('corr') }, '×')));
  $('af-chips').replaceChildren(...chips);
}
function auditWhen(e) {
  return el(
    'span',
    {},
    when(e.requested_at),
    e.repeat_count > 1 ? el('div', { class: 'faint small' }, `외 ${e.repeat_count - 1}회 · 마지막 ${when(e.last_at)}`) : null,
  );
}
function auditDetail(e) {
  return el(
    'div',
    { class: 'au-detail' },
    kvList(
      ['감사 식별자', el('span', {}, el('code', {}, e.corr_id), ' ', el('a', { href: `#audit?corr=${encodeURIComponent(e.corr_id)}&since=` }, '연결된 기록 보기'))],
      ['작업 유형', `${auditActionLabel(e.action)} (${e.action})`],
      ['수행자', `${actorLabel(e.actor_id, e.actor_kind)} — ${e.actor_id}`],
      ['대상', e.target_id ? `${e.target_type} ${e.target_id}` : e.target_type ?? '—'],
      e.thread_id ? ['대화 범위', el('a', { href: `#${e.thread_id}` }, threadById(e.thread_id)?.title ?? e.thread_id)] : null,
      ['요청 시각', when(e.requested_at)],
      ['처리 시각', when(e.processed_at)],
      ['결과', el('span', {}, resultBadge(e), e.reason ? ` ${AUDIT_REASON[e.reason] ?? e.reason} (${e.reason})` : '')],
      e.repeat_count > 1 ? ['묶음', `${e.repeat_count}회 — 같은 수행자·유형·결과·사유가 1분 안에 반복됨 · 마지막 ${when(e.last_at)}`] : null,
      ['이전 상태', stateKv(e.before)],
      ['결과 상태', stateKv(e.after)],
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
  $('au-total').textContent = `총 ${r.total.toLocaleString('ko-KR')}건`;
  const narrow = isNarrow();
  if (!r.entries.length) {
    $('au-table').replaceChildren(el('p', { class: 'muted empty-runs' }, '조건에 맞는 기록이 없습니다.'));
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
        el('thead', {}, el('tr', {}, ...['타임스탬프', '이벤트 유형', '수행자', '대상·범위', '결과', '상세'].map((h) => el('th', { scope: 'col' }, h)))),
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
    open ? '접기' : '보기',
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
  items.push(el('button', { type: 'button', disabled: r.page <= 1, onclick: go(r.page - 1) }, '이전'));
  list.forEach((n, i) => {
    if (i && n - list[i - 1] > 1) items.push(el('span', { class: 'faint' }, '…'));
    items.push(el('button', { type: 'button', class: n === r.page ? 'cur' : '', 'aria-current': n === r.page ? 'page' : null, onclick: go(n) }, String(n)));
  });
  items.push(el('button', { type: 'button', disabled: r.page >= r.pages, onclick: go(r.page + 1) }, '다음'));
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
    if (my === agSeq) $('ag-list').replaceChildren(el('p', { class: 'err' }, `연결 상태를 불러오지 못했습니다: ${e.message}`));
    return;
  }
  if (my !== agSeq) return;
  S.conn = r;
  S.agents = new Map(r.agents.map((a) => [a.id, a]));
  $('ag-checked').textContent = `마지막 확인 ${when(r.now)}`;
  renderConnections();
}
const DENY_TXT = { token_revoked: '폐기된 토큰으로 접속 시도', token_expired: '만료된 토큰으로 접속 시도', participant_disabled: '비활성 참여자의 토큰' };
/** 연결 준비 상태(2.1 «초기 설정 · 연결 중 · 준비 완료 · 연결 실패»를 서버가 아는 신호로) */
function readiness(a) {
  if (a.state === 'no_credential') return { cls: 'off', word: '토큰 없음', text: '발급된 토큰이 없어 어댑터가 붙을 수 없습니다 — CT 안에서 발급하세요' };
  if (a.state === 'revoked') return { cls: 'off', word: '폐기됨', text: `유효한 토큰이 없습니다(폐기·만료)${a.last_seen_at ? ` · 마지막 접속 ${rel(a.last_seen_at)}` : ''}` };
  if (a.state === 'never') return { cls: '', word: '연결 대기', text: '유효한 토큰은 있지만 한 번도 접속하지 않았습니다 — 어댑터 설정·실행을 확인하세요' };
  const age = Date.now() - a.last_seen_at;
  if (age < 60_000) return { cls: 'on', word: '연결됨', text: `마지막 접속 ${Math.max(1, Math.floor(age / 1000))}초 전(어댑터는 폴링마다 인증합니다)` };
  return { cls: 'stale', word: '오래 조용함', text: `마지막 접속 ${rel(a.last_seen_at)} — 어댑터가 꺼졌거나 멈췄을 수 있습니다` };
}
/** «폐기된 에이전트 숨기기» — 유효한 토큰이 하나도 없는(state revoked) 에이전트를 목록에서 뺀다. 이 브라우저에만 기억(기본 숨김) */
const AG_HIDE_KEY = 'bs.agents.hideRevoked';
const agHideRevoked = () => store(AG_HIDE_KEY) !== '0';
function renderConnections() {
  const r = S.conn;
  if (!r) return;
  if (!r.agents.length) return $('ag-list').replaceChildren(el('p', { class: 'muted' }, '등록된 에이전트가 없습니다. CT 안에서 brainstorm-admin participant add 로 등록합니다.'));
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
      ? el('p', { class: 'muted small ag-hidden-note' }, `폐기된 에이전트 ${hidden.length}개 숨김(${hidden.map((a) => a.name).join(', ')}) `, el('button', { type: 'button', class: 'small-btn', onclick: showAll }, '보기'))
      : null,
    shown.length ? null : el('p', { class: 'muted' }, '보이는 에이전트가 없습니다 — 모두 폐기됐습니다.'),
    ...shown.map((a) => {
      const rd = readiness(a);
      const credRows = a.credential_list.map((c) =>
        el(
          'tr',
          { class: c.status === 'active' ? '' : 'dim', 'data-cred': c.id },
          el('td', {}, c.label ?? el('span', { class: 'faint' }, '라벨 없음'), el('div', { class: 'faint small' }, el('code', {}, c.id))),
          el('td', {}, el('span', { class: `badge cr-${c.status}` }, { active: '유효', revoked: '폐기됨', expired: '만료됨' }[c.status])),
          el('td', {}, when(c.created_at)),
          el('td', {}, c.status === 'revoked' ? when(c.revoked_at) : c.expires_at ? when(c.expires_at) : el('span', { class: 'faint' }, '없음')),
          el('td', {}, c.last_used_at ? `${when(c.last_used_at)} (${rel(c.last_used_at)})` : el('span', { class: 'faint' }, '한 번도 안 씀')),
          el('td', {}, c.status === 'active' ? el('button', { type: 'button', class: 'danger small-btn', onclick: () => revokeAsk(a, c) }, '폐기') : el('span', { class: 'faint' }, '—')),
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
          el('a', { href: `#audit?actor=${encodeURIComponent(a.id)}&since=`, class: 'small' }, '감사 기록'),
        ),
        el('p', { class: 'ag-ready small' }, rd.text),
        kvList(
          ['메인 채팅방', a.room_member ? '멤버' : el('span', { class: 'alertish' }, '멤버 아님(방에서 빠짐)')],
          ['읽을 수 있는 대화', `${a.threads}개`],
          ['실행', a.runs.last_at ? `진행 ${a.runs.active} · 마지막 ${rel(a.runs.last_at)} ${a.runs.last_state ? `(${STATE[a.runs.last_state] ?? a.runs.last_state})` : ''}` : '아직 없음'],
          [
            '서버가 거절한 마지막 연결',
            a.last_denied
              ? el('span', { class: 'alertish' }, `${DENY_TXT[a.last_denied.reason] ?? AUDIT_REASON[a.last_denied.reason] ?? a.last_denied.reason} · ${rel(a.last_denied.at)}${a.last_denied.count > 1 ? ` · 그 1분 묶음에 ${a.last_denied.count}회` : ''} `, el('a', { href: deniedLink }, '기록'))
              : el('span', { class: 'faint' }, '없음'),
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
                  el('div', { class: 'rc1' }, el('span', { class: `badge cr-${c.status}` }, { active: '유효', revoked: '폐기됨', expired: '만료됨' }[c.status]), el('b', {}, c.label ?? '라벨 없음'), el('code', { class: 'faint small' }, c.id)),
                  el(
                    'div',
                    { class: 'rc2 muted small' },
                    `발급 ${when(c.created_at)} · ${c.status === 'revoked' ? `폐기 ${when(c.revoked_at)}` : c.expires_at ? `만료 ${when(c.expires_at)}` : '만료 없음'} · ${c.last_used_at ? `마지막 사용 ${rel(c.last_used_at)}` : '한 번도 안 씀'}`,
                  ),
                  c.status === 'active' ? el('div', { class: 'rc3' }, el('button', { type: 'button', class: 'danger small-btn', onclick: () => revokeAsk(a, c) }, '폐기')) : null,
                ),
              ),
            )
          : a.credential_list.length
          ? el(
              'table',
              { class: 'hist ag-creds' },
              el('thead', {}, el('tr', {}, ...['라벨 · ID', '상태', '발급', '만료·폐기', '마지막 사용', ''].map((h) => el('th', { scope: 'col' }, h)))),
              el('tbody', {}, ...credRows),
            )
          : el('p', { class: 'muted small' }, '발급된 토큰이 없습니다.'),
      );
    }),
  );
}
async function revokeAsk(a, c) {
  const ok = await ask({
    title: '토큰 폐기',
    text: `${a.name}의 토큰 «${c.label ?? c.id}»을 폐기합니다. 이 토큰을 쓰는 어댑터는 바로 401을 받고, 붙어 있던 실시간 연결도 몇 초 안에 끊깁니다. 되돌릴 수 없습니다 — 다시 붙이려면 CT 안에서 새 토큰을 발급해야 합니다.`,
    ok: '폐기',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api('POST', `/api/credentials/${encodeURIComponent(c.id)}/revoke`);
    announce(r.outcome === 'revoked' ? `${a.name} 토큰을 폐기했습니다` : '이미 폐기된 토큰입니다');
  } catch (e) {
    await notify('폐기 안 됨', e.message);
  }
  await loadConnections();
}

// ───── 멤버 권한 ─────
async function showMembers(params) {
  const want = params?.get('thread') || S.mbThread || S.cur || room()?.id;
  S.mbThread = want && threadById(want) ? want : room()?.id ?? S.threads[0]?.id ?? null;
  fillMemberThreads();
  $('mb-status').textContent = '';
  $('mb-h').focus();
  await loadMembers();
}
function fillMemberThreads() {
  $('mb-thread').replaceChildren(...S.threads.map((t) => el('option', { value: t.id }, `${t.kind === 'room' ? '[채팅방] ' : ''}${pathOf(t)}`)));
  if (S.mbThread) $('mb-thread').value = S.mbThread;
}
let mbSeq = 0;
async function loadMembers() {
  if (!S.mbThread) return $('mb-table').replaceChildren(el('p', { class: 'muted' }, '대화가 없습니다.'));
  const my = ++mbSeq;
  const th = S.mbThread;
  try {
    const d = await api('GET', `/api/threads/${encodeURIComponent(th)}`);
    if (my !== mbSeq) return;
    S.mbDetail = d;
  } catch (e) {
    if (my === mbSeq) $('mb-table').replaceChildren(el('p', { class: 'err' }, `불러오지 못했습니다: ${e.message}`));
    return;
  }
  renderMembers();
}
function renderMembers() {
  const d = S.mbDetail;
  if (!d || S.mode !== 'members') return;
  const t = d.thread;
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
    const isDefault = t.default_recipient === p.id;
    const cells = [
      el('span', {}, el('b', {}, p.name), ' ', el('code', { class: 'faint' }, p.id), isDefault ? el('div', { class: 'faint small' }, '기본 수신자') : null),
      cb(`${p.name} 멤버`, !!m, false, (i) => changeMember(p, i.checked ? { can_read: true, can_post: true } : { remove: true }), { 'data-k': 'member' }),
      cb(`${p.name} 읽기`, !!m?.can_read, !m, (i) => changeMember(p, { can_read: i.checked, can_post: i.checked ? !!m.can_post : false }), { 'data-k': 'read' }),
      cb(`${p.name} 게시`, !!m?.can_post, !m || !m.can_read, (i) => changeMember(p, { can_read: true, can_post: i.checked }), { 'data-k': 'post' }),
      el('span', { class: 'faint small' }, '꺼짐(에이전트 간 호출 없음)'),
    ];
    return narrow
      ? el(
          'li',
          { class: `rcard mb-row${m ? '' : ' dim'}`, 'data-pid': p.id },
          el('div', { class: 'rc1' }, cells[0]),
          el('div', { class: 'mb-toggles' }, el('label', {}, cells[1], ' 멤버'), el('label', {}, cells[2], ' 읽기'), el('label', {}, cells[3], ' 게시')),
          el('div', { class: 'faint small' }, '호출: 꺼짐(에이전트 간 호출 없음)'),
        )
      : el('tr', { class: `mb-row${m ? '' : ' dim'}`, 'data-pid': p.id }, ...cells.map((c) => el('td', {}, c)));
  };
  const masterCells = [
    el('span', {}, el('b', {}, master?.name ?? '마스터'), ' ', el('span', { class: 'faint small' }, '마스터 — 항상 멤버')),
    cb('마스터 멤버', true, true),
    cb('마스터 읽기', true, true),
    cb('마스터 게시', true, true),
    el('span', { class: 'small' }, '호출 가능'),
  ];
  const head = el('div', { class: 'mb-head small' }, convLabel(t.kind, pathOf(threadById(t.id) ?? t)), ' · ', el('a', { href: `#${t.id}` }, '대화 열기'), ' · ', el('a', { href: `#audit?thread=${encodeURIComponent(t.id)}&action=member.*&since=` }, '이 대화의 권한 변경 기록'));
  if (narrow) {
    $('mb-table').replaceChildren(
      head,
      el('ul', { class: 'rcards' }, el('li', { class: 'rcard mb-row master' }, el('div', { class: 'rc1' }, masterCells[0]), el('div', { class: 'faint small' }, '읽기·게시·호출 모두 가능')), ...agents.map(rowFor)),
    );
  } else {
    $('mb-table').replaceChildren(
      head,
      el(
        'table',
        { class: 'rtable mbtable' },
        el('thead', {}, el('tr', {}, ...['참여자', '멤버', '읽기', '게시', '호출'].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, el('tr', { class: 'mb-row master' }, ...masterCells.map((c) => el('td', {}, c))), ...agents.map(rowFor)),
      ),
    );
  }
}
async function changeMember(p, body) {
  const th = S.mbThread;
  const t = threadById(th);
  if (body.remove) {
    const ok = await ask({
      title: '멤버에서 빼기',
      text: `${p.name}을(를) «${t?.title ?? th}»에서 뺍니다. 이 대화를 더 이상 읽거나 쓰지 못하고, 이 에이전트 앞으로 남은 전달은 거둬집니다. 다시 넣으면 권한이 돌아옵니다. 지난 기록은 그대로입니다.`,
      ok: '빼기',
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
    const now = m ? `읽기 ${m.can_read ? '켬' : '끔'} · 게시 ${m.can_post ? '켬' : '끔'}` : '멤버 아님';
    $('mb-status').replaceChildren(`${p.name} → ${now}. 감사 기록에 남았습니다 `, el('a', { href: `#audit?thread=${encodeURIComponent(th)}&action=member.*&since=` }, '(기록 보기)'));
    announce(`${p.name} 권한 변경: ${now}`);
  } catch (e) {
    $('mb-status').textContent = `바꾸지 못했습니다: ${e.message}`;
  }
  S.mbBusy = false;
  renderMembers();
}

/** 알림이 오면(대화 바뀜·재접속) 열려 있는 관리 화면을 다시 읽는다 */
let adminReloadTimer = null;
function refreshAdminPage(threadId) {
  if (S.mode !== 'members' && S.mode !== 'agents') return;
  clearTimeout(adminReloadTimer);
  adminReloadTimer = setTimeout(() => {
    if (S.mode === 'members') {
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

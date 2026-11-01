// brainStorm 작업 화면. 빌드 단계 없음.
// 원칙: REST 가 원본, WebSocket 은 «새 것 있음» 알림. 재접속하면 커서(seq) 이후를 다시 읽는다.
// 화면: 메뉴 · 대화 목록(채팅방/스레드) · 대화 · 보조 패널(실행·세션·참여자). 좁은 화면은 목록=서랍, 보조 패널=아래 시트.
// 실행 상태 목록·상세·취소 결과는 runs.js, 감사 기록·에이전트 연결·멤버 권한은 admin.js, 선점 레인(보조 패널 «선점» 탭)은 claims.js(같은 전역을 쓴다).
// 주소: #<대화 id> · #runs[?…] · #run/<id> · #run/<id>/cancel · #audit[?…] · #agents · #members[?thread=…]
'use strict';

const $ = (id) => document.getElementById(id);
const S = {
  me: null,
  participants: new Map(),
  agents: new Map(), // id → 연결 상태(/api/agents)
  threads: [],
  roomDetail: null,
  cur: null, // 현재 대화 id
  detail: null, // {thread, members, sessions}
  messages: [], // 현재 대화 메시지 (seq 오름차순)
  seen: new Set(), // 이미 표시한 seq
  context: [], // 분기 때 가져온 메시지
  cursor: 0,
  runs: [],
  deliveries: [],
  replyTo: null,
  replyAuthor: null,
  outbox: [], // 이 화면에서 보낸 것 — {id, thread, payload, file, state: sending|unknown|failed|stored, error, retryable, seq}
  sentKeys: new Set(), // 이 화면에서 저장이 확인된 client_key
  ws: null,
  wsBackoff: 1000,
  wsOpen: false,
  everConnected: false,
  lastSync: null,
  auxOpen: false,
  live: new Map(), // 대화 id → 실행 중(대기·실행) 에이전트 이름들 — 목록의 깜빡이는 점(디자인 #782)
  tab: 'runs',
  fork: null,
  pendingCompose: null,
  prefillTo: null,
  roomDirty: false,
  mode: 'convo', // 'convo' = 대화 작업 · 'runs' = 실행 화면(목록·상세·취소 결과) · 'audit' · 'agents' · 'members' (admin.js)
  runsPane: null,
  rp: null, // 실행 목록 필터
  rpData: null,
  rd: null, // 열린 실행 상세
  rdId: null, // 지금 화면이 보여 줄 실행 id(늦게 온 응답 거르기)
  cancelResult: null, // 방금 한 취소 요청의 결과(취소 결과 화면용)
  cancelAckMs: 30000,
  dlg: null, // 위임 대장 목록(선점 탭 · claims.js) — null 이면 탭을 열 때 읽는다
  claimScene: null, // 지난 장면(연출은 장면 차이로)
  claimSig: null, // 지난 장면 서명(같으면 다시 그리지 않는다)
  claimSel: null, // 고른 위임 id
  face: null, // 대면 모드 보기(GET /api/threads/:id/face · face.js)
  faceTab: 'doc', // 좁은 화면 탭(doc · left · right)
};

// ───── 안전한 렌더: 먼저 이스케이프, 그다음 최소 마크다운 ─────
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
// 마크다운(마스터 #477): 이스케이프한 글을 줄 단위로 읽어 블록을 고르고, 인라인은 코드 조각을 먼저 떼어 둔다.
//   링크는 http(s)·mailto 만 — 그 밖의 주소는 글자로 남긴다. 원문 보기는 이스케이프만 한다(renderPlain).
const MD_LINK_OK = /^(https?:\/\/|mailto:)/i;
function mdInline(t) {
  const keep = [];
  const hold = (h) => `\u0000${keep.push(h) - 1}\u0000`;
  t = t.replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g, (_, _q, c) => hold(`<code>${c.trim() || c}</code>`));
  t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (all, label, url) =>
    MD_LINK_OK.test(url) ? hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`) : all,
  );
  t = t.replace(/(^|[\s(]|&lt;)(https?:\/\/(?:(?!&(?:lt|gt|quot|#39);)[^\s<])+)/g, (_, pre, url) => {
    const tail = url.match(/[.,;:!?)]+$/)?.[0] ?? '';
    const u = url.slice(0, url.length - tail.length);
    return pre + hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`) + tail;
  });
  t = t
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([^\n]*?\S)__/g, '<strong>$1</strong>')
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, '<del>$1</del>')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, '$1<em>$2</em>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
}
const MD_LIST = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const MD_TSEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const mdCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
function mdBlocks(lines) {
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(mdInline).join('<br>')}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^ {0,3}(```+|~~~+)\s*([\w+-]*)\s*$/))) {
      flush();
      const fence = m[1];
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
      i++;
      out.push(`<pre><code${m[2] ? ` data-lang="${m[2]}"` : ''}>${code.join('\n')}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    if ((m = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      flush();
      out.push(`<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`);
      i++;
      continue;
    }
    if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) {
      flush();
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^ {0,3}&gt; ?/.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && /^ {0,3}&gt; ?/.test(lines[i])) q.push(lines[i++].replace(/^ {0,3}&gt; ?/, ''));
      out.push(`<blockquote>${mdBlocks(q)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && MD_TSEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const head = mdCells(line);
      const align = mdCells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(mdCells(lines[i++]));
      const td = (tag, c, k) => `<${tag}${align[k] ? ` class="al-${align[k]}"` : ''}>${mdInline(c ?? '')}</${tag}>`;
      out.push(
        `<div class="tbl"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => td('td', r[k], k)).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    if (MD_LIST.test(line)) {
      flush();
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const lm = l.match(MD_LIST);
        if (lm) {
          items.push({ ind: lm[1].length, ord: /\d/.test(lm[2]), start: parseInt(lm[2], 10), text: [lm[3]] });
          i++;
        } else if (l.trim() && /^\s{2,}/.test(l) && items.length) {
          items.at(-1).text.push(l.trim());
          i++;
        } else break;
      }
      out.push(mdList(items, 0, items.length));
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out.join('');
}
/** items[a..b) — 첫 항목의 들여쓰기가 이 목록의 단, 더 깊은 항목은 앞 항목 안의 하위 목록 */
function mdList(items, a, b) {
  const base = items[a].ind;
  const ord = items[a].ord;
  let html = ord ? `<ol${items[a].start > 1 ? ` start="${items[a].start}"` : ''}>` : '<ul>';
  for (let k = a; k < b; ) {
    let e = k + 1;
    while (e < b && items[e].ind > base) e++;
    const it = items[k];
    html += `<li>${it.text.map(mdInline).join('<br>')}${e > k + 1 ? mdList(items, k + 1, e) : ''}</li>`;
    k = e;
  }
  return html + (ord ? '</ol>' : '</ul>');
}
function renderBody(text) {
  return mdBlocks(esc(text).replace(/\r\n?/g, '\n').split('\n'));
}
function renderPlain(text) {
  return esc(text);
}
/** 대화마다 «원문 보기»(마스터 #477) — 기본은 마크다운, 원문으로 바꾼 대화만 이 브라우저에 기억 */
const isPlain = (threadId) => !!threadId && store(`bs.plain.${threadId}`) === '1';
function fillBody(body, text, plain) {
  body.classList.toggle('plain', plain);
  body.classList.toggle('md', !plain);
  body.innerHTML = plain ? renderPlain(text) : renderBody(text); // 둘 다 이스케이프 후에만 태그를 넣는다
}
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v; // CSP: style 속성 대신 CSSOM
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
function store(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch {}
  return null;
}
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString(I18N.locale, { hour12: false }) : '');
const fmtHm = (ts) => (ts ? new Date(ts).toLocaleTimeString(I18N.locale, { hour12: false, hour: '2-digit', minute: '2-digit' }) : '');
function rel(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60_000) return t('app.just_now');
  if (d < 3_600_000) return t('app.min_ago', { n: Math.floor(d / 60_000) });
  if (d < 86_400_000) return t('app.hours_ago', { n: Math.floor(d / 3_600_000) });
  if (d < 2 * 86_400_000) return t('app.yesterday');
  return new Date(ts).toLocaleDateString(I18N.locale);
}
function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t('app.secs', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('app.dur_ms', { m, s: s % 60 });
  return t('app.dur_hm', { h: Math.floor(m / 60), m: m % 60 });
}
const pname = (id) => S.participants.get(id)?.name ?? id;
const initials = (id) => {
  const n = pname(id).trim();
  if (isAgent(id)) return n.slice(0, 1).toUpperCase();
  return /^[A-Za-z0-9]/.test(n) ? n.slice(0, 2).toUpperCase() : n.slice(0, 1);
};
const isAgent = (id) => S.participants.get(id)?.kind === 'agent';
/** 에이전트 작성자 색(디자인 #782) — 에이전트 이름 순서로 tone-0~3. 같은 에이전트는 화면마다 같은 색 */
const agentTone = (id) => {
  const ids = [...S.participants.values()].filter((p) => p.kind === 'agent').map((p) => p.id).sort();
  const i = ids.indexOf(id);
  return i < 0 ? '' : ` tone-${i % 4}`;
};
const KIND = { instruction: t('app.kind_instruction'), quote: t('app.kind_quote'), observation: t('app.kind_observation'), proposal: t('app.kind_proposal'), request: t('app.kind_request') };
// 공통 상태 라벨 — 화면마다 같은 뜻으로 쓴다(정책 3)
const STATE = { queued: t('app.state_queued'), running: t('app.state_running'), succeeded: t('app.state_succeeded'), failed: t('app.state_failed'), cancelled: t('app.state_cancelled'), unknown: t('app.state_unknown') };
const RUN_ERR = {
  cancelled_by_master: t('app.runerr_cancelled_by_master'),
  stop_new: t('app.runerr_stop_new'),
  generation_rotated: t('app.runerr_generation_rotated'),
  lease_expired: t('app.runerr_lease_expired'),
  cancel_ack_timeout: t('app.runerr_cancel_ack_timeout'),
};
// 취소 처리 결과(서버 판정 run.cancel_outcome) — 정책 1 «화면 안내»의 구분
const OUTCOME = {
  queued_cancelled: t('app.outcome_queued_cancelled'),
  requested: t('app.cancel_requested'),
  acked: t('app.outcome_acked'),
  no_ack: t('app.outcome_no_ack'),
  completed_first: t('app.outcome_completed_first'),
  failed_first: t('app.outcome_failed_first'),
  withdrawn: t('app.outcome_withdrawn'),
  rotated: t('app.outcome_rotated'),
  legacy: t('app.outcome_legacy'),
};
/** «중단 요청됨»은 상태가 아니라 running + 요청 기록 — 화면에서는 따로 보인다 */
const runStateKey = (r) => (r.state === 'running' && r.cancel_requested_at ? 'requested' : r.state);
const stateLabel = (r) => (runStateKey(r) === 'requested' ? t('app.cancel_requested') : STATE[r.state] ?? r.state);
const SEND_ERR = {
  thread_closed: t('app.senderr_thread_closed'),
  no_thread: t('app.senderr_no_thread'),
  no_post_permission: t('app.senderr_no_post_permission'),
  bad_recipient: t('app.senderr_bad_recipient'),
  call_budget_exceeded: t('app.senderr_call_budget_exceeded'),
  bad_call_budget: t('app.senderr_bad_call_budget'),
  client_key_reused: t('app.senderr_client_key_reused'),
  too_large: t('app.senderr_too_large'),
  bad_request: t('app.senderr_bad_request'),
  bad_attachment: t('app.senderr_bad_attachment'),
  too_many_attachments: t('app.senderr_too_many_attachments'),
};
const ATT_MAX = 5;
const ATT_MAX_BYTES = 20 * 1024 * 1024;
const ATT_ICON = { image: '🖼', pdf: '📕', text: '📄', file: '📦' };
function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const kindLabel = (th) => (th?.kind === 'room' ? t('app.kind_room') : t('app.kind_thread'));
const threadById = (id) => S.threads.find((t) => t.id === id);
const room = () => S.threads.find((t) => t.kind === 'room') ?? null;
function pathOf(t) {
  // 상위 경로: 메인 채팅방 › 부모 › 이 스레드
  const parts = [];
  let p = t;
  const guard = new Set();
  while (p && !guard.has(p.id)) {
    guard.add(p.id);
    parts.unshift(p.title);
    p = p.parent_thread_id ? threadById(p.parent_thread_id) : null;
  }
  return parts.join(' › ');
}
function announce(text) {
  const sr = $('sr');
  sr.textContent = '';
  setTimeout(() => (sr.textContent = text), 30);
}

// ───── API ─────
async function api(method, path, body, raw) {
  const opts = { method, headers: { 'X-BS-Lang': I18N.lang }, credentials: 'same-origin' };
  if (raw) {
    opts.headers['Content-Type'] = 'application/octet-stream';
    opts.body = raw;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const json = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/api/auth/login') {
    showLogin();
    throw Object.assign(new Error(t('app.login_required')), { status: 401 });
  }
  if (!res.ok) throw Object.assign(new Error(json?.message || json?.error || res.statusText), { status: res.status, code: json?.error, json });
  return Object.assign(json ?? {}, { _status: res.status });
}

// ───── 확인 상자 ─────
let confirmResolve = null;
function ask({ title, text, ok, danger, extra }) {
  $('confirm-h').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-extra').replaceChildren(...(extra ? [extra] : []));
  $('confirm-ok').textContent = ok;
  $('confirm-ok').className = danger ? 'primary danger-fill' : 'primary';
  $('confirm').hidden = false;
  const back = document.activeElement;
  $('confirm-ok').focus();
  return new Promise((resolve) => {
    confirmResolve = (v) => {
      $('confirm').hidden = true;
      confirmResolve = null;
      if (back && back.focus) back.focus();
      resolve(v);
    };
  });
}
$('confirm-ok').addEventListener('click', () => confirmResolve && confirmResolve(true));
$('confirm-no').addEventListener('click', () => confirmResolve && confirmResolve(false));
$('confirm-x').addEventListener('click', () => confirmResolve && confirmResolve(false));
function notify(title, text) {
  return ask({ title, text, ok: t('app.ok') });
}

// ───── 로그인 ─────
function showLogin() {
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  $('logout-btn').hidden = true;
  $('top-aux-btn').hidden = true;
  $('me').textContent = '';
  if (S.ws) S.ws.close();
}
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-err').textContent = '';
  try {
    await api('POST', '/api/auth/login', { passphrase: $('login-pass').value });
    $('login-pass').value = '';
    await boot();
  } catch (err) {
    $('login-err').textContent = err.status === 429 ? t('app.login_too_many') : t('app.login_bad_pass');
  }
});
$('logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => {});
  showLogin();
});

// ───── 좁은 화면: 서랍·시트는 동시에 하나만 ─────
const isNarrow = () => (typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)').matches : false);
/** 보조 패널이 대화 위를 덮는 폭(작성란 전송 버튼이 가려질 수 있음) */
const listDrawer = () => (typeof matchMedia === 'function' ? matchMedia('(max-width: 999px)').matches : false); // 대화 목록이 서랍인 폭(디자인 #782)
const auxOverlays = () => (typeof matchMedia === 'function' ? matchMedia('(max-width: 1279px)').matches : false); // 보조 패널이 대화를 덮는 폭(디자인 #782 · 1279 아래는 서랍)
function setDrawer(open) {
  document.body.classList.toggle('show-sidebar', open);
  $('menu-btn').setAttribute('aria-expanded', String(open));
  if (open && listDrawer()) setAux(false);
  syncBackdrop();
}
function syncBackdrop() {
  $('backdrop').hidden = !(listDrawer() && document.body.classList.contains('show-sidebar'));
}
$('menu-btn').addEventListener('click', () => {
  const open = !document.body.classList.contains('show-sidebar');
  setDrawer(open);
  if (open) focusList();
});
$('side-close').addEventListener('click', () => setDrawer(false));
$('context-box').addEventListener('toggle', syncContextLast);
// 미리보기는 세 줄로 잘려 있다 — 누르면 맥락을 펼친다(마스터 #721 · #751 부터 모든 폭 · 링크 누름은 그대로)
$('context-last').addEventListener('click', (e) => {
  if (e.target.closest?.('a, button')) return;
  $('context-box').open = true;
  syncContextLast();
});
$('backdrop').addEventListener('click', () => setDrawer(false));

// ───── 메뉴 ─────
for (const b of document.querySelectorAll('.menu-item')) {
  b.addEventListener('click', () => {
    const m = b.dataset.menu;
    // 좁은 화면에서 메뉴는 서랍 안에 있다(디자인 #782) — 고르면 서랍을 닫는다
    if (isNarrow() && document.body.classList.contains('show-sidebar')) setDrawer(false);
    if (m === 'logout') return $('logout-btn').click();
    if (m === 'runs' || m === 'audit' || m === 'agents') {
      location.hash = m;
      return;
    }
    if (m === 'members') {
      location.hash = S.cur ? `members?thread=${encodeURIComponent(S.cur)}` : 'members';
      return;
    }
    if (S.mode !== 'convo') location.hash = S.cur ?? '';
    if (m === 'convo') {
      setAux(false);
      $('body').focus();
    } else setAux(true, m);
  });
}
// ───── 메뉴 접기(디자인 #782): 넓은 화면에서 메뉴를 아이콘 줄(64px)로 · 이 브라우저에 기억 · 기억이 없으면 1280px 아래에서 접힘 ─────
function setRail(collapsed, remember) {
  document.body.classList.toggle('rail-collapsed', collapsed);
  const b = $('rail-btn');
  b.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? t('app.menu_expand') : t('app.menu_collapse');
  b.setAttribute('aria-label', label);
  b.title = label;
  if (remember) store('bs.rail', collapsed ? 'collapsed' : 'open');
}
$('rail-btn').addEventListener('click', () => setRail(!document.body.classList.contains('rail-collapsed'), true));
{
  const saved = store('bs.rail');
  setRail(saved ? saved === 'collapsed' : typeof matchMedia === 'function' && matchMedia('(max-width: 1279px)').matches, false);
}
function syncMenu() {
  // 실행 화면이면 «실행 상태». 대화 작업 중에는 보조 패널의 세션·참여자 탭을 따른다(실행 탭은 대화 작업의 일부)
  const active = S.mode !== 'convo' ? S.mode : S.auxOpen && S.tab !== 'runs' ? S.tab : 'convo';
  for (const b of document.querySelectorAll('.menu-item')) {
    const on = b.dataset.menu === active;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
}

// ───── 보조 패널 ─────
function setAux(open, tab) {
  if (tab) S.tab = tab;
  S.auxOpen = open;
  store('bs.aux-tab', S.tab);
  store('bs.aux-open', open ? '1' : '0');
  $('aux').hidden = !open;
  $('app-view').classList.toggle('aux-open', open);
  $('aux-btn').textContent = open ? t('app.aux_close') : t('app.aux_open');
  $('aux-btn').setAttribute('aria-expanded', String(open));
  $('top-aux-btn').setAttribute('aria-expanded', String(open));
  if (open && listDrawer()) setDrawer(false);
  for (const b of document.querySelectorAll('.tabs [role=tab]')) {
    const on = b.dataset.tab === S.tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    $(`tab-${b.dataset.tab}`).hidden = !on;
  }
  syncMenu();
  syncSendable();
  if (open) renderAux();
  if (open && S.tab === 'people') loadAgents();
  if (open && S.tab === 'claims') loadClaims().catch(() => {});
}
$('aux-btn').addEventListener('click', () => setAux(!S.auxOpen));
$('top-aux-btn').addEventListener('click', () => setAux(!S.auxOpen));
$('aux-close').addEventListener('click', () => setAux(false));
for (const b of document.querySelectorAll('.tabs [role=tab]')) {
  b.addEventListener('click', () => setAux(true, b.dataset.tab));
  b.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...document.querySelectorAll('.tabs [role=tab]')];
    const i = tabs.indexOf(b) + (e.key === 'ArrowRight' ? 1 : -1);
    const nb = tabs[(i + tabs.length) % tabs.length];
    setAux(true, nb.dataset.tab);
    nb.focus();
  });
}
function renderAux() {
  if (!S.auxOpen) return;
  const t = S.detail?.thread;
  $('aux-ctx').textContent = t ? `· ${t.title}` : '';
  if (S.tab === 'runs') renderRunsTab();
  else if (S.tab === 'sessions') renderSessionsTab();
  else if (S.tab === 'claims') renderClaims();
  else renderPeopleTab();
}

// ───── 대화 목록 ─────
async function loadThreads() {
  S.threads = (await api('GET', '/api/threads')).threads;
  const r = room();
  if (r && (S.roomDirty || !S.roomDetail || S.roomDetail.thread.id !== r.id)) {
    S.roomDirty = false;
    S.roomDetail = await api('GET', `/api/threads/${r.id}`).catch(() => null);
  }
  renderList();
}
// 스레드 상태 이름(목록 배지·필터)
function stateOf(t) {
  if (t.kind === 'room') return 'room';
  if (t.deleted_at) return 'trash';
  if (t.hidden) return 'hidden';
  return t.status === 'archived' ? 'archived' : 'open';
}
const STATE_LABEL = { room: t('app.active'), open: t('app.tstate_open'), archived: t('app.tstate_archived'), hidden: t('app.tstate_hidden'), trash: t('app.tstate_trash') };
// 필터: 진행 중(열림·안 숨김) · 보관 포함 · 보관 · 숨김 · 휴지통 — 휴지통은 휴지통 필터에서만 보인다
const FILTERS = {
  open: (t) => !t.deleted_at && !t.hidden && t.status === 'open',
  all: (t) => !t.deleted_at && !t.hidden,
  archived: (t) => !t.deleted_at && !t.hidden && t.status === 'archived',
  hidden: (t) => !t.deleted_at && t.hidden,
  trash: (t) => !!t.deleted_at,
};
// 접힌 분기(브라우저에만 저장 — 화면 취향이라 서버에 안 둔다)
function collapsedSet() {
  try {
    return new Set(JSON.parse(store('bs.collapsed') || '[]'));
  } catch {
    return new Set();
  }
}
function saveCollapsed(set) {
  store('bs.collapsed', JSON.stringify([...set]));
}
function toggleCollapsed(id) {
  const c = collapsedSet();
  if (c.has(id)) c.delete(id);
  else c.add(id);
  saveCollapsed(c);
  renderList();
}
// ───── 안 본 답 N 배지 (마스터 #535) ─────
// 받는 이를 골라 보낸 대화에 그 뒤 글(답)이 생겼는데 그 대화를 화면에 띄워 받지 않았으면 왼쪽 목록에 N.
// 열어서 그 글까지 받으면 지운다. 보낸 뒤 열어 봤어도 답이 오기 전이면 그대로 기다린다. 이 브라우저에만(localStorage bs.await = {대화: 내가 보낸 seq})
function awaitMap() {
  try {
    const m = JSON.parse(store('bs.await') || '{}');
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}
function markAwait(thread, seq) {
  const m = awaitMap();
  m[thread] = Math.max(m[thread] ?? 0, seq);
  store('bs.await', JSON.stringify(m));
}
const viewing = (id) => id === S.cur && S.mode === 'convo' && document.visibilityState !== 'hidden';
/** 지금 보는 대화가 기다리던 답까지 받았으면 기다림을 지운다 */
function clearSeenAwait() {
  const m = awaitMap();
  if (!S.cur || m[S.cur] == null || !viewing(S.cur) || S.cursor <= m[S.cur]) return false;
  delete m[S.cur];
  store('bs.await', JSON.stringify(m));
  return true;
}
function hasNew(t) {
  const s = awaitMap()[t.id];
  return s != null && (t.last_seq ?? 0) > s && !viewing(t.id);
}
const newBadge = (inner) => el('span', { class: `new-badge${inner ? ' inner' : ''}`, title: inner ? t('app.new_badge_inner_title') : t('app.new_badge_title'), 'aria-label': t('app.new_badge_aria') }, 'N');
function convItem(th, depth, tree) {
  const active = th.id === S.cur;
  const paused = th.invoke_paused ? t('app.paused_prefix') : '';
  let l2;
  if (th.kind === 'room') {
    const n = S.roomDetail?.members.filter((m) => m.kind === 'agent').length ?? 0;
    l2 = t('app.room_line', { paused, n, time: rel(th.updated_at) });
  } else {
    const parent = th.parent_thread_id ? threadById(th.parent_thread_id) : null;
    const from = parent ? t('app.forked_from', { parent: parent.kind === 'room' ? t('app.main_room') : parent.title, seq: th.fork_seq }) : t('app.standalone_thread');
    l2 = `${paused}${from} · ${rel(th.updated_at)}`;
  }
  const st = stateOf(th);
  const n = tree?.kids ?? 0;
  const a = el(
    'a',
    { href: `#${th.id}`, class: `conv-item${active ? ' active' : ''}${st !== 'open' && st !== 'room' ? ' dimmed' : ''}`, 'aria-current': active ? 'true' : null, 'data-id': th.id },
    el(
      'div',
      { class: 'l1' },
      el('span', { class: 'ttl' }, th.title),
      hasNew(th) ? newBadge(false) : tree?.kidsNew ? newBadge(true) : null,
      tree?.collapsed && n ? el('span', { class: 'kids', title: t('app.collapsed_branches', { n }) }, `+${n}`) : null,
      S.live.has(th.id)
        ? el('span', { class: 'live', title: t('app.running_names', { names: S.live.get(th.id).join(', ') }) }, S.live.get(th.id)[0] + (S.live.get(th.id).length > 1 ? ` +${S.live.get(th.id).length - 1}` : ''))
        : el('span', { class: `pill st-${st}` }, STATE_LABEL[st]),
    ),
    el('div', { class: 'l2' }, l2),
  );
  if (!tree) return a;
  const tw = n
    ? el(
        'button',
        {
          type: 'button',
          class: 'twisty',
          'aria-expanded': tree.collapsed ? 'false' : 'true',
          'aria-label': t(tree.collapsed ? 'app.branch_expand_aria' : 'app.branch_collapse_aria', { title: th.title, n }),
          onclick: () => toggleCollapsed(th.id),
        },
        tree.collapsed ? '▸' : '▾',
      )
    : el('span', { class: 'twisty-sp', 'aria-hidden': 'true' });
  return el('div', { class: `conv-row depth${Math.min(depth, 3)}` }, tw, a);
}
function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const filter = FILTERS[$('thread-filter').value] ? $('thread-filter').value : 'open';
  const r = room();
  const rl = $('room-list');
  rl.replaceChildren(...(r && (!q || r.title.toLowerCase().includes(q)) ? [convItem(r, 0)] : [el('div', { class: 'empty-list' }, r ? t('app.no_search_results') : t('app.no_room_yet'))]));
  const threads = S.threads.filter((t) => t.kind !== 'room' && FILTERS[filter](t));
  const nav = $('thread-list');
  const items = [];
  let parents = 0;
  if (q) {
    for (const t of threads.filter((t) => t.title.toLowerCase().includes(q)).sort((a, b) => b.updated_at - a.updated_at)) items.push(convItem(t, 0));
  } else {
    // 트리: 방에서 갈라진 것과 부모 없는 옛 스레드(또는 부모가 이 필터에 없는 것)가 맨 위, 그 아래 재분기 — 폴더처럼 접는다
    const ids = new Set(threads.map((t) => t.id));
    const kids = new Map();
    for (const t of threads) {
      const k = t.parent_thread_id && ids.has(t.parent_thread_id) ? t.parent_thread_id : '';
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k).push(t);
    }
    const coll = collapsedSet();
    const count = (id) => (kids.get(id) ?? []).reduce((n, c) => n + 1 + count(c.id), 0);
    const anyNew = (id) => (kids.get(id) ?? []).some((c) => hasNew(c) || anyNew(c.id));
    const walk = (k, depth) => {
      for (const t of (kids.get(k) ?? []).sort((a, b) => b.updated_at - a.updated_at)) {
        const n = count(t.id);
        if (n) parents++;
        const closed = n > 0 && coll.has(t.id);
        items.push(convItem(t, depth, { kids: n, collapsed: closed, kidsNew: closed && anyNew(t.id) }));
        if (!closed) walk(t.id, depth + 1);
      }
    };
    walk('', 0);
  }
  const empty = q ? t('app.no_search_results') : filter === 'open' ? t('app.no_threads_hint') : t('app.no_threads_filter', { filter: $('thread-filter').selectedOptions[0]?.textContent ?? '' });
  nav.replaceChildren(...(items.length ? items : [el('div', { class: 'empty-list' }, empty)]));
  const tb = $('tree-toggle-all');
  tb.hidden = !!q || parents === 0;
  const anyOpen = threads.some((t) => !collapsedSet().has(t.id) && threads.some((c) => c.parent_thread_id === t.id));
  tb.textContent = anyOpen ? t('app.collapse_all') : t('app.expand_all');
  tb.dataset.mode = anyOpen ? 'close' : 'open';
}
$('tree-toggle-all').addEventListener('click', () => {
  const c = collapsedSet();
  const parentsHere = S.threads.filter((t) => S.threads.some((x) => x.parent_thread_id === t.id)).map((t) => t.id);
  if ($('tree-toggle-all').dataset.mode === 'close') for (const id of parentsHere) c.add(id);
  else for (const id of parentsHere) c.delete(id);
  saveCollapsed(c);
  renderList();
});
$('search').addEventListener('input', renderList);
$('thread-filter').addEventListener('change', () => {
  store('bs.filter', $('thread-filter').value);
  renderList();
});
{
  const f = store('bs.filter');
  if (f && FILTERS[f]) $('thread-filter').value = f;
}
function focusList() {
  const a = document.querySelector('.conv-item.active') ?? document.querySelector('.conv-item');
  if (a) a.focus();
  else $('search').focus();
}

// ───── 대화 열기 ─────
window.addEventListener('hashchange', () => route());

/** 주소 → 화면. 대화(#th_…) · 실행 목록(#runs?…) · 실행 상세(#run/<id>) · 취소 결과(#run/<id>/cancel) */
function parseHash() {
  const h = location.hash.slice(1);
  if (h === 'runs' || h.startsWith('runs?')) return { page: 'runs', q: new URLSearchParams(h.slice(5)) };
  for (const pg of ['audit', 'agents', 'members']) if (h === pg || h.startsWith(`${pg}?`)) return { page: pg, q: new URLSearchParams(h.slice(pg.length + 1)) };
  const m = /^run\/([^/?]+)(\/cancel)?$/.exec(h);
  if (m) return { page: m[2] ? 'cancel' : 'run', id: decodeURIComponent(m[1]) };
  return { page: 'convo', id: h };
}
/** 화면 전환: 'convo' 는 대화 목록·대화·보조 패널, 그 밖은 한 장짜리 화면(실행·감사·연결·멤버 권한)이 그 자리를 쓴다 */
function setMode(mode) {
  S.mode = mode;
  const page = mode !== 'convo';
  for (const x of [$('app-view'), document.body]) {
    x.classList.toggle('mode-page', page);
    x.classList.toggle('mode-runs', mode === 'runs');
  }
  $('runs-page').hidden = mode !== 'runs';
  $('audit-page').hidden = mode !== 'audit';
  $('agents-page').hidden = mode !== 'agents';
  $('members-page').hidden = mode !== 'members';
  if (page) setDrawer(false);
  syncMenu();
}
async function route() {
  const r = parseHash();
  if (r.page === 'convo') {
    const was = S.mode;
    setMode('convo');
    if (was !== 'convo' && r.id && r.id === S.cur && S.detail) {
      // 실행 화면에서 같은 대화로 돌아오면 다시 읽지 않고 실행 상태만 새로
      loadRuns().catch(() => {});
      return;
    }
    return openThread(r.id);
  }
  if (r.page === 'audit' || r.page === 'agents' || r.page === 'members') {
    setMode(r.page);
    if (r.page === 'audit') return showAudit(r.q);
    if (r.page === 'agents') return showAgents();
    return showMembers(r.q);
  }
  setMode('runs');
  if (r.page === 'runs') return showRuns(r.q);
  if (r.page === 'run') return showRun(r.id);
  return showCancelResult(r.id);
}

async function openThread(id) {
  if (!id) {
    const r = room();
    const last = store('bs.cur');
    id = last && threadById(last) ? last : r?.id;
    if (!id) {
      $('thread').hidden = true;
      $('empty').hidden = false;
      $('empty').textContent = t('app.no_main_room');
      return;
    }
    history.replaceState(null, '', `#${id}`);
  }
  setDrawer(false);
  S.cur = id;
  store('bs.cur', id);
  syncMdToggle();
  S.messages = [];
  S.seen = new Set();
  S.cursor = 0;
  S.runs = [];
  S.deliveries = [];
  S.detail = null;
  S.face = null;
  clearReply();
  $('messages').replaceChildren();
  $('empty').hidden = true;
  $('thread').hidden = false;
  $('empty-thread').hidden = true;
  setBanner(null);
  renderList();
  try {
    await Promise.all([loadDetail(), loadContext(), fetchNew(), loadRuns()]);
    syncEmpty();
    const th = S.detail.thread;
    announce(t('app.thread_opened', { kind: kindLabel(th), title: th.title, path: pathOf(th) }));
    renderList();
  } catch (err) {
    if (id !== S.cur) return;
    S.detail = null;
    $('messages').replaceChildren(
      el(
        'div',
        { class: 'empty-thread' },
        el('p', {}, el('b', {}, t('app.cannot_open_dot'))),
        el('p', { class: 'muted small' }, err.status === 404 ? t('app.cannot_open_404') : t('app.error_msg', { msg: err.message })),
        room() && room().id !== id ? el('button', { type: 'button', class: 'primary', onclick: () => (location.hash = room().id) }, t('app.to_main_room')) : null,
      ),
    );
    $('c-target').textContent = t('app.unopenable');
    syncSendable();
    announce(t('app.cannot_open'));
  }
}

async function loadDetail() {
  const th = S.cur;
  const d = await api('GET', `/api/threads/${th}`);
  if (th !== S.cur) return;
  S.detail = d;
  if (d.thread.kind === 'room') S.roomDetail = d;
  const i = S.threads.findIndex((t) => t.id === d.thread.id);
  if (i >= 0) S.threads[i] = { ...S.threads[i], ...d.thread };
  renderHead();
  faceSync(); // 대면 모드면 세 열(face.js)
  renderRunLines(); // 보류된 요청 줄(request_holds)은 상세에서 온다
  renderComposerTarget();
  renderRecipients();
  syncSendable();
  renderAux();
}

function renderHead() {
  const d = S.detail;
  if (!d) return;
  const th = d.thread;
  $('t-kind').textContent = kindLabel(th);
  $('t-kind').className = `pill ${th.kind === 'room' ? 'room' : ''}`;
  $('t-title').textContent = th.title;
  renderStateMenu(th);
  $('t-audit').href = `#audit?thread=${encodeURIComponent(th.id)}&since=`;
  $('people-perm').href = `#members?thread=${encodeURIComponent(th.id)}`;
  const parent = th.parent_thread_id ? threadById(th.parent_thread_id) : null;
  if (th.kind === 'room') $('t-path').textContent = t('app.room_path');
  else if (parent) {
    const fp = [...S.context, ...S.messages].find((m) => m.seq === th.fork_seq);
    $('t-path').textContent = `${t('app.branched_from', { parent: parent.kind === 'room' ? t('app.main_chat') : parent.title, seq: th.fork_seq })}${fp ? t('app.branch_point_suffix', { time: fmtTime(fp.created_at), author: pname(fp.author_id) }) : ''}`;
  } else $('t-path').textContent = t('app.orphan_thread');
  // 합치기(#706): 하위 스레드면 머리에 «⤴ 상위로 합치기 (안 합친 글 N)» · 지난 합침은 경로 줄 끝에
  const mb = $('t-merge');
  mb.hidden = !(S.modules?.has('merge') && S.me?.is_master && parent && th.kind !== 'room');
  if (!mb.hidden) {
    const n = d.unmerged ?? 0;
    mb.textContent = n ? t('app.merge_up_n', { n }) : t('app.merge_up_btn');
    mb.disabled = !n;
    mb.title = n ? t('app.merge_up_title', { n, parent: parent.kind === 'room' ? t('app.main_room') : parent.title }) : t('app.no_new_since_merge');
    const ms = d.merges ?? [];
    if (ms.length) $('t-path').textContent += t('app.merged_up_suffix', { n: ms.length, seq: ms[ms.length - 1].to_seq });
  }
  renderSummary();
}
$('t-merge').addEventListener('click', async () => {
  const d = S.detail;
  const parent = d?.thread.parent_thread_id ? threadById(d.thread.parent_thread_id) : null;
  if (!parent || !d.unmerged) return;
  const where = parent.kind === 'room' ? t('app.main_room') : `«${parent.title}»`;
  const again = (d.merges ?? []).length ? t('app.merge_again') : '';
  if (!(await ask({ title: t('app.merge_up'), text: t('app.merge_up_text', { n: d.unmerged, where, again }), ok: t('app.merge') }))) return;
  try {
    const r = await api('POST', `/api/threads/${d.thread.id}/merge`);
    announce(t('app.merged_done', { title: r.parent.title }));
    location.hash = r.parent.id;
  } catch (e) {
    notify(t('app.merge_failed'), e.message);
  }
});
function renderSummary() {
  const d = S.detail;
  if (!d) return;
  const agents = d.members.filter((m) => m.kind === 'agent');
  const active = S.runs.filter((r) => r.state === 'queued' || r.state === 'running').length;
  const waiting = S.deliveries.filter((x) => (x.status === 'pending' || x.status === 'leased') && !S.runs.some((r) => r.trigger_seq === x.message_seq && r.agent_id === x.recipient_id)).length;
  const unknown = S.runs.filter((r) => r.state === 'unknown').length;
  const gens = d.sessions.filter((s) => s.status === 'active').map((s) => `${pname(s.agent_id)} ${t('app.gen_n', { n: s.generation })}${s.metrics?.ctx_tokens ? ` · ${ctxK(s.metrics.ctx_tokens)}` : ''}`);
  const th = d.thread;
  $('t-summary').replaceChildren(
    el('span', {}, t('app.sum_targets'), el('b', {}, agents.length ? agents.map((a) => a.name).join(', ') : t('app.no_agents'))),
    el('span', {}, t('app.sum_current'), el('b', {}, pathOf(th))),
    el('span', {}, t('app.sum_runs'), el('b', {}, t('app.in_progress_n', { n: active + waiting })), unknown ? el('span', { class: 'alertish' }, t('app.unknown_n_suffix', { n: unknown })) : null),
    el('span', {}, t('app.sum_gens'), el('b', {}, gens.length ? gens.join(', ') : t('app.none_yet'))),
    ...(th.invoke_paused ? [el('span', { class: 'alertish' }, t('app.paused_badge'))] : []),
  );
  // 머리에는 손이 필요한 경고만 남긴다(새 호출 금지 · 미확인 실행 · 보류된 요청) — 나머지 정보는 보조 패널(#325)
  const held = openHolds().length;
  const alerts = [
    ...(th.invoke_paused ? [el('span', { class: 'alertish' }, t('app.paused_badge'))] : []),
    ...(unknown ? [el('span', { class: 'alertish' }, t('app.unknown_runs_alert', { n: unknown }))] : []),
    ...(held
      ? [el('button', { type: 'button', class: 'alertish linkish', id: 't-holds', title: t('app.holds_alert_title'), onclick: () => setAux(true, 'runs') }, t('app.holds_alert', { n: held }))]
      : []),
  ];
  $('t-alert').replaceChildren(...alerts);
  $('t-alert').hidden = !alerts.length;
}
function renderComposerTarget() {
  const t = S.detail?.thread;
  if (!t) return;
  $('c-target').replaceChildren(el('span', { class: `pill ${t.kind === 'room' ? 'room' : ''}` }, kindLabel(t)), el('span', { class: 'path' }, pathOf(t)));
}

// ───── 수신 칩 ─────
function renderRecipients() {
  const d = S.detail;
  // 대면 모드: 받는 이는 서버가 정한다 — 칩 대신 한 줄(face.js)
  if (faceActive()) return $('recipients').replaceChildren(...faceRecipientsNote());
  const agents = d.members.filter((m) => m.kind === 'agent' && m.can_read);
  const box = $('recipients');
  // 참여자가 마스터와 에이전트 하나뿐이면 그 에이전트가 기본 수신 대상(대화에 정해 둔 기본 수신자가 있으면 그것이 먼저)
  const sole = d.members.filter((m) => m.kind === 'agent').length === 1 && agents.length === 1 ? agents[0].participant_id : null;
  const def = d.thread.default_recipient ?? sole;
  const chip = (value, label, checked, { key, ...extra } = {}) => {
    const input = el('input', { type: 'checkbox', value, checked, ...extra });
    const c = el('label', { class: `chip${checked ? ' on' : ''}`, title: key ? t('app.shortcut', { key }) : null }, input, label);
    input.addEventListener('change', () => onChip(input));
    return c;
  };
  box.replaceChildren(
    el('span', { class: 'lbl' }, t('app.recipients')),
    ...(agents.length
      ? [
          // «메모» = 명시적으로 아무에게도 안 보냄(마스터 #271) — 에이전트를 고르면 꺼지고, 메모를 켜면 에이전트가 다 꺼진다
          chip('*memo', t('app.memo'), false, { 'data-memo': '1', title: t('app.memo_title') }),
          chip('*all', t('app.all'), agents.length > 0 && agents.every((a) => a.participant_id === def), { 'data-all': '1', title: t('app.all_title'), key: 'Alt+0' }),
          ...agents.map((a, i) => chip(a.participant_id, a.name, a.participant_id === def, { 'data-agent': '1', ...(i < 9 ? { key: `Alt+${i + 1}` } : {}), ...(S.onCallOnly?.has(a.participant_id) ? { 'data-oncall': '1' } : {}) })),
        ]
      : [el('span', { class: 'small faint' }, t('app.no_member_agents_saved'))]),
    el('span', { class: 'small faint', id: 'rcpt-note' }),
  );
  applyPrefillTo();
  syncChips();
}
// 주소로 고른 수신 대상(?to=)은 사람이 칩을 만지거나 보낼 때까지 남는다 — 채운 뒤 실시간 연결이 붙으며 칩을 다시 그려도 지워지지 않게(마스터 #323)
function applyPrefillTo() {
  const p = S.prefillTo;
  if (!p || p.thread !== S.cur) return;
  const chips = [...$('recipients').querySelectorAll('input[data-agent]')];
  if (!chips.some((i) => p.to.includes(i.value))) return;
  for (const i of chips) i.checked = p.to.includes(i.value);
  const all = $('recipients').querySelector('input[data-all]');
  if (all) all.checked = false;
  const memo = $('recipients').querySelector('input[data-memo]');
  if (memo) memo.checked = false;
}
function onChip(input) {
  S.prefillTo = null;
  const all = $('recipients').querySelector('input[data-all]');
  const memo = $('recipients').querySelector('input[data-memo]');
  const each = [...$('recipients').querySelectorAll('input[data-agent]')];
  // 메모와 에이전트는 함께 켜지지 않는다
  if (input === memo) {
    if (memo.checked) {
      for (const i of each) i.checked = false;
      if (all) all.checked = false;
    }
    syncChips();
    return;
  }
  if (memo && input.checked) memo.checked = false;
  // «전체»는 이름을 골라야만 부르는 에이전트(사서 등 · on_call_only)를 건드리지 않는다
  const group = each.filter((i) => !i.dataset.oncall);
  if (input === all) for (const i of group) i.checked = all.checked;
  else if (all) all.checked = group.length > 0 && group.every((i) => i.checked);
  syncChips();
}
function selectedRecipients() {
  return [...$('recipients').querySelectorAll('input[data-agent]:checked')].map((i) => i.value);
}
/** «메모»가 켜졌나 — 명시적으로 아무에게도 안 보냄 */
function memoChosen() {
  return !!$('recipients').querySelector('input[data-memo]:checked');
}
function syncChips() {
  for (const i of $('recipients').querySelectorAll('input')) i.parentElement.classList.toggle('on', i.checked);
  renderReplyInfo();
  const n = selectedRecipients().length;
  const b = $('budget');
  // «전체»가 예산보다 많으면 예산을 수신자 수로 올린다(서버는 수신자 > 예산이면 거절) — 보이게 바꾼다
  if (n > Number(b.value)) b.value = String(Math.min(n, Number(b.max)));
  const note = $('rcpt-note');
  if (note) {
    note.classList.remove('rcpt-warn');
    const hasAgents = !!$('recipients').querySelector('input[data-agent]');
    note.textContent = n ? t('app.calling_n', { n }) : memoChosen() || !hasAgents ? t('app.calling_none') : t('app.pick_recipient');
  }
  syncMore();
}
function syncMore() {
  const sk = $('source-kind');
  const parts = [t('app.more_source', { kind: sk.options[sk.selectedIndex].text })];
  if (selectedRecipients().length) parts.push(t('app.more_budget', { n: $('budget').value }));
  $('more-sum').textContent = parts.join(' · ');
}
$('source-kind').addEventListener('change', syncMore);
$('budget').addEventListener('input', syncMore);

// ───── 첨부: 고르기 · 끌어다 놓기 · 붙여넣기 → 보낼 때 먼저 올리고(업로드) 메시지에 묶는다 ─────
S.attach = []; // {file, url(그림 미리보기 objectURL)}
function addFiles(files) {
  const list = [...(files ?? [])];
  const skipped = [];
  for (const f of list) {
    if (S.attach.length >= ATT_MAX) {
      skipped.push(t('app.att_skip_count', { name: f.name, max: ATT_MAX }));
      continue;
    }
    if (f.size === 0) skipped.push(t('app.att_skip_empty', { name: f.name }));
    else if (f.size > ATT_MAX_BYTES) skipped.push(t('app.att_skip_size', { name: f.name, size: fmtSize(f.size) }));
    else S.attach.push({ file: f, url: /^image\/(png|jpeg|gif|webp)$/.test(f.type) && URL.createObjectURL ? URL.createObjectURL(f) : null });
  }
  if (skipped.length) notify(t('app.att_skipped'), skipped.join(', '));
  renderAttach();
}
function removeAttach(x) {
  if (x.url) URL.revokeObjectURL(x.url);
  S.attach = S.attach.filter((y) => y !== x);
  renderAttach();
}
function renderAttach() {
  const box = $('att-list');
  box.hidden = !S.attach.length;
  box.replaceChildren(
    ...S.attach.map((x) =>
      el(
        'span',
        { class: 'att-chip', title: x.file.name },
        x.url ? el('img', { class: 'att-thumb', src: x.url, alt: '' }) : el('span', { 'aria-hidden': 'true' }, '📄'),
        el('span', { class: 'att-name' }, x.file.name),
        el('span', { class: 'faint' }, fmtSize(x.file.size)),
        el('button', { type: 'button', class: 'att-x', 'aria-label': t('app.att_remove', { name: x.file.name }), onclick: () => removeAttach(x) }, '✕'),
      ),
    ),
  );
}
$('attach-btn').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', () => {
  addFiles($('file').files);
  $('file').value = '';
});
$('composer').addEventListener('dragover', (e) => {
  if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
  e.preventDefault();
  $('composer').classList.add('dragover');
});
$('composer').addEventListener('dragleave', (e) => {
  if (!$('composer').contains(e.relatedTarget)) $('composer').classList.remove('dragover');
});
$('composer').addEventListener('drop', (e) => {
  $('composer').classList.remove('dragover');
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  addFiles(e.dataTransfer.files);
});
/** 지역 시각 YYYYMMDD-HHMMSS */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
$('body').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return; // 글자 붙여넣기는 그대로
  e.preventDefault();
  // 캡처 붙여넣기는 이름이 늘 image.png — 시각을 붙여 가른다
  addFiles(files.map((f) => (f.name === 'image.png' ? new File([f], t('app.paste_filename', { stamp: stamp() }), { type: f.type }) : f)));
});

function syncSendable() {
  const blocked = auxOverlays() && S.auxOpen; // 패널이 대화를 덮는 폭: 패널을 닫은 뒤에만 전송
  const ok = !!S.detail && S.detail.thread.status === 'open' && !S.detail.thread.deleted_at;
  $('send-btn').disabled = blocked || !ok;
  $('fork-btn').disabled = !S.detail;
  $('send-hint').hidden = !blocked;
}

async function loadContext() {
  const th = S.cur;
  const ctx = (await api('GET', `/api/threads/${th}/context`)).messages;
  if (th !== S.cur) return;
  S.context = ctx;
  $('context-box').hidden = S.context.length === 0;
  $('context-count').textContent = `(${S.context.length})`;
  $('context').replaceChildren(...S.context.map((m) => msgEl(m, true)));
  // 맥락의 마지막 글은 접힌 채로도 보인다(마스터 #448) — 펼치면 목록에 있으니 숨긴다(두 번 안 보이게)
  const last = S.context[S.context.length - 1];
  const prev = last ? msgEl(last, true) : null;
  if (prev) prev.removeAttribute('id');
  $('context-last').replaceChildren(...(prev ? [prev] : []));
  syncContextLast();
}
function syncContextLast() {
  $('context-last').hidden = $('context-box').hidden || $('context-box').open || !S.context?.length;
}

// ───── 메시지 ─────
function insertMsg(m) {
  if (S.seen.has(m.seq)) return false;
  S.seen.add(m.seq);
  const node = msgEl(m, false);
  const i = S.messages.findIndex((x) => x.seq > m.seq);
  if (i === -1) {
    S.messages.push(m);
    $('messages').append(node);
  } else {
    const nextEl = $(`m${S.messages[i].seq}`);
    S.messages.splice(i, 0, m);
    $('messages').insertBefore(node, nextEl);
  }
  return true;
}
function syncEmpty() {
  const empty = S.messages.length === 0 && !!S.detail;
  $('empty-thread').hidden = !empty;
}
$('first-msg-btn').addEventListener('click', () => $('body').focus());

/** 커서 이후만 가져온다. 재접속·알림 모두 이 한 길로. onPage(받은 수, 커서) 는 복구 진행률용 */
let fetching = null;
let fetchingThread = null;
let fetchAgain = false;
async function fetchNew(onPage) {
  if (!S.cur) return;
  if (fetching && fetchingThread === S.cur) {
    fetchAgain = true; // 도중에 온 알림을 놓치지 않게 한 번 더
    return fetching;
  }
  const th = S.cur;
  fetchingThread = th;
  let added = 0;
  fetching = (async () => {
    for (;;) {
      const r = await api('GET', `/api/threads/${th}/messages?after=${S.cursor}&limit=200`);
      if (th !== S.cur) return;
      for (const m of r.messages) if (insertMsg(m)) added++;
      S.cursor = Math.max(S.cursor, r.next_cursor);
      if (onPage) onPage(added, S.cursor, r.has_more);
      if (!r.has_more) break;
    }
    S.lastSync = Date.now();
  })().finally(() => {
    fetching = null;
    if (fetchAgain && th === S.cur) {
      fetchAgain = false;
      fetchNew();
    }
  });
  const atBottom = nearBottom();
  await fetching;
  if (th !== S.cur) return added;
  if (clearSeenAwait()) renderList();
  settleOutbox();
  syncEmpty();
  renderRunLines();
  if (S.detail) renderHead();
  if (added && faceActive()) renderFace();
  if (atBottom || added) scrollBottom();
  if (S.auxOpen && S.tab === 'people') renderPeopleTab();
  return added;
}
function nearBottom() {
  const m = $('messages');
  return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
}
function scrollBottom() {
  const m = $('messages');
  m.scrollTop = m.scrollHeight;
}

function msgEl(m, inherited) {
  const agent = isAgent(m.author_id);
  const mine = S.me && m.author_id === S.me.id;
  const head = el(
    'div',
    { class: 'head' },
    el('b', {}, pname(m.author_id)),
    el('span', { class: `badge${m.source_kind === 'request' ? ' req' : ''}`, title: m.source_kind === 'request' ? t('app.badge_request_title') : t('app.source') }, KIND[m.source_kind] ?? m.source_kind),
    m.input_mode === 'voice' ? el('span', { class: 'badge' }, t('app.voice')) : null,
    el('span', {}, `#${m.seq}`),
    el('time', { datetime: new Date(m.created_at).toISOString(), title: fmtTime(m.created_at) }, fmtHm(m.created_at)),
    m.recipients.length
      ? el('span', { class: m.source_kind === 'request' ? 'req-route' : null }, m.source_kind === 'request' ? `${pname(m.author_id)} → ${m.recipients.map(pname).join(', ')}` : `→ ${m.recipients.map(pname).join(', ')}`)
      : null,
    m.reply_to_seq ? el('a', { href: `#m${m.reply_to_seq}`, onclick: (e) => (e.preventDefault(), jumpTo(m.reply_to_seq)) }, `↩ #${m.reply_to_seq}`) : null,
    mine && !inherited && S.sentKeys.has(m.client_key) ? el('span', { class: 'sendst ok' }, t('app.sent_ok')) : null,
  );
  // 답장·복사·분기는 머리가 아니라 글 아래 한 줄에 «전달…» 과 나란히(마스터 #327) — 전달 칸(.fwdslot)은 renderRunLines 가 채운다
  const bar = el(
    'div',
    { class: 'msgbar' },
    inherited ? null : el('span', { class: 'fwdslot' }),
    el(
      'span',
      { class: 'actions' },
      inherited ? null : el('button', { type: 'button', onclick: () => setReply(m) }, t('app.reply')),
      el('button', { type: 'button', title: t('app.copy_msg_title'), onclick: () => copyMessage(m) }, t('app.copy')),
      el('button', { type: 'button', onclick: () => openFork(m.seq) }, t('app.branch_here')),
    ),
  );
  const body = el('div', { class: 'body' });
  body._src = m.body;
  if (m.merge) body.append(mergeBox(m));
  else fillBody(body, m.body, isPlain(S.cur));
  const list = m.attachments ?? [];
  const imgs = list.filter((a) => a.kind === 'image');
  const files = list.filter((a) => a.kind !== 'image');
  const atts = [
    imgs.length
      ? el(
          'div',
          { class: 'att-imgs' },
          ...imgs.map((a) => {
            const src = `/api/attachments/${encodeURIComponent(a.id)}?inline=1`;
            return el('a', { href: src, target: '_blank', rel: 'noopener', title: `${a.name} · ${fmtSize(a.size)}` }, el('img', { class: 'att-img', src, alt: a.name, loading: 'lazy' }));
          }),
        )
      : null,
    files.length
      ? el(
          'div',
          { class: 'att-files' },
          ...files.map((a) =>
            el('a', { class: 'att-file', href: `/api/attachments/${encodeURIComponent(a.id)}`, title: t('app.download') }, `${ATT_ICON[a.kind] ?? '📦'} ${a.name}`, el('span', { class: 'faint' }, ` ${fmtSize(a.size)}`)),
          ),
        )
      : null,
  ];
  return el(
    'article',
    { class: `msg${agent ? ' agent' + agentTone(m.author_id) : ''}${mine ? ' mine' : ''}${inherited ? ' inherited' : ''}`, id: inherited ? `c${m.seq}` : `m${m.seq}`, 'aria-label': `${pname(m.author_id)} #${m.seq}` },
    el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(m.author_id)),
    el('div', { class: 'main' }, head, body, ...atts, inherited ? null : el('div', { class: 'runlines', 'data-seq': String(m.seq) }), bar),
  );
}
// ───── 합침 묶음(#706): 하위 스레드에서 옮긴 글을 한 상자로 · 펼치면 그 글들을 하위 스레드에서 읽어 온다 ─────
function mergeBox(m) {
  const g = m.merge;
  const list = el('div', { class: 'merge-list', hidden: true });
  const tog = el('button', { type: 'button', class: 'small', 'aria-expanded': 'false' }, t('app.expand'));
  let loaded = false;
  tog.onclick = async () => {
    const open = list.hidden;
    list.hidden = !open;
    tog.textContent = open ? t('app.collapse') : t('app.expand');
    tog.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open || loaded) return;
    loaded = true;
    list.replaceChildren(el('div', { class: 'faint' }, t('app.loading')));
    try {
      const got = [];
      let after = g.from_seq - 1;
      for (;;) {
        const r = await api('GET', `/api/threads/${encodeURIComponent(g.child_thread_id)}/messages?after=${after}&limit=200`);
        for (const x of r.messages) if (x.seq <= g.to_seq) got.push(x);
        after = r.next_cursor;
        if (!r.has_more || after >= g.to_seq) break;
      }
      list.replaceChildren(
        ...got.map((x) => {
          const b = el('div', { class: 'body' });
          fillBody(b, x.body, isPlain(S.cur));
          return el(
            'div',
            { class: 'merge-item' },
            el('div', { class: 'head' }, el('b', {}, pname(x.author_id)), el('span', { class: 'badge' }, KIND[x.source_kind] ?? x.source_kind), el('span', {}, `#${x.seq}`), el('time', { title: fmtTime(x.created_at) }, fmtHm(x.created_at))),
            b,
          );
        }),
      );
    } catch (e) {
      loaded = false;
      list.replaceChildren(el('div', { class: 'faint' }, t('app.child_read_failed', { msg: e.message })));
    }
  };
  const known = threadById(g.child_thread_id);
  return el(
    'div',
    { class: 'merge-box' },
    el(
      'div',
      { class: 'merge-h' },
      el('span', {}, t('app.merged_from_child', { title: g.child_title, n: g.count, from: g.from_seq, to: g.to_seq })),
      tog,
      known ? el('a', { class: 'small', href: `#${g.child_thread_id}` }, t('app.open_thread')) : null,
    ),
    list,
  );
}
// ───── 복사: 메시지 하나 · 대화 전체(마크다운) ─────
/** 클립보드에 쓴다. http(보안 문맥 아님)에서는 navigator.clipboard 가 없다 — 숨은 textarea + execCommand 로 */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const ta = el('textarea', { readonly: true, 'aria-hidden': 'true', style: 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0' });
  ta.value = text;
  const back = document.activeElement;
  document.body.append(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  ta.remove();
  back?.focus?.();
  return ok;
}
function attLine(a) {
  return `📎 ${a.name} (${fmtSize(a.size)})`;
}
async function copyMessage(m) {
  const text = [m.body, ...(m.attachments ?? []).map(attLine)].filter(Boolean).join('\n');
  const ok = await copyText(text);
  ok ? announce(t('app.copied_seq', { seq: m.seq })) : notify(t('app.copy_failed'), t('app.clipboard_blocked'));
}
/** 한 메시지 → 마크다운 덩어리(작성자 · 시각 · 번호 · 본문 · 첨부) */
function messageMd(m) {
  const p = S.participants.get(m.author_id);
  const who = p?.is_master ? t('app.who_master', { name: pname(m.author_id) }) : pname(m.author_id);
  const to = m.recipients?.length ? ` → ${m.recipients.map(pname).join(', ')}` : '';
  const re = m.reply_to_seq ? ` · ↩ #${m.reply_to_seq}` : '';
  return [`**${who}**${to} · ${fmtTime(m.created_at)} · #${m.seq}${re}`, m.body, ...(m.attachments ?? []).map(attLine)].filter(Boolean).join('\n');
}
/** 대화 전체를 서버에서 끝까지 받아(화면에 안 불러온 옛 글까지) 마크다운으로 복사 */
async function copyThread() {
  const th = S.detail?.thread;
  if (!th) return;
  const all = [];
  let after = 0;
  for (;;) {
    const r = await api('GET', `/api/threads/${th.id}/messages?after=${after}&limit=500`);
    all.push(...r.messages);
    if (!r.has_more || !r.messages.length) break;
    after = r.next_cursor;
  }
  const head = t('app.copy_head', { title: th.title, kind: kindLabel(th), n: all.length, time: fmtTime(Date.now()) });
  const ok = await copyText([head, ...all.map(messageMd)].join('\n\n---\n\n'));
  ok ? announce(t('app.thread_copied', { n: all.length })) : notify(t('app.copy_failed'), t('app.clipboard_blocked'));
  const b = $('t-copy');
  if (ok && b) {
    b.textContent = t('app.copied_n', { n: all.length });
    setTimeout(() => (b.textContent = t('app.copy_thread')), 2000);
  }
}
$('t-copy').addEventListener('click', () => copyThread().catch((e) => notify(t('app.copy_failed'), e.message)));

// ───── 마크다운 ↔ 원문 (대화 단위 · 마스터 #477) ─────
function syncMdToggle() {
  const plain = isPlain(S.cur);
  const b = $('t-md');
  b.textContent = plain ? t('app.view_markdown') : t('app.view_raw');
  b.setAttribute('aria-pressed', plain ? 'true' : 'false');
  b.title = plain ? t('app.view_markdown_title') : t('app.view_raw_title');
}
$('t-face').addEventListener('click', () => toggleFace());
$('face-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) setFaceTab(b.dataset.tab);
});
$('t-md').addEventListener('click', () => {
  if (!S.cur) return;
  const plain = !isPlain(S.cur);
  try {
    plain ? localStorage.setItem(`bs.plain.${S.cur}`, '1') : localStorage.removeItem(`bs.plain.${S.cur}`);
  } catch {}
  for (const b of document.querySelectorAll('#thread .msg .body')) if (typeof b._src === 'string') fillBody(b, b._src, plain);
  if (faceActive()) renderFace();
  syncMdToggle();
  announce(plain ? t('app.view_raw') : t('app.view_markdown'));
});

function jumpTo(seq) {
  const e = $(`m${seq}`) ?? $(`c${seq}`);
  if (e) {
    if (e.closest('details')) e.closest('details').open = true;
    e.scrollIntoView({ block: 'center' });
  }
}
function setReply(m) {
  S.replyTo = m.seq;
  S.replyAuthor = m.author_id;
  // 에이전트 글에 답장하면 그 에이전트를 받는 쪽으로 켠다(마스터 #271) — 빼고 싶으면 칩을 끄면 된다
  const chip = isAgent(m.author_id) ? [...$('recipients').querySelectorAll('input[data-agent]')].find((i) => i.value === m.author_id) : null;
  if (chip && !chip.checked) {
    chip.checked = true;
    onChip(chip);
  }
  renderReplyInfo();
  $('body').focus();
}
function clearReply() {
  S.replyTo = null;
  S.replyAuthor = null;
  $('reply-info').hidden = true;
}
/** 답장은 «어느 글에 대한 것인가» 표시일 뿐 전달이 아니다 — 서버는 수신 대상(recipients)에게만 전달한다.
 *  원글이 에이전트 글인데 그 에이전트가 수신 대상에 없으면 작게 알린다. */
function renderReplyInfo() {
  if (S.replyTo == null) return;
  const info = $('reply-info');
  const a = S.replyAuthor;
  let warn = null;
  if (a && isAgent(a) && !selectedRecipients().includes(a)) {
    const chip = [...$('recipients').querySelectorAll('input[data-agent]')].some((i) => i.value === a);
    warn = el(
      'span',
      { class: 'reply-warn' },
      chip
        ? t('app.reply_warn_chip', { name: pname(a) })
        : t('app.reply_warn_nonmember', { name: pname(a) }),
    );
  }
  info.hidden = false;
  // 빈 값(null)은 넣지 않는다 — replaceChildren 은 null 을 «null» 글자로 그린다(마스터 #325)
  info.replaceChildren(...[t('app.replying_to', { seq: S.replyTo }), el('button', { type: 'button', class: 'link', onclick: clearReply }, t('app.cancel')), warn ? el('br') : null, warn].filter((x) => x != null));
}

// ───── 실행 상태: 메시지 행 · 대기 띠 · 보조 패널 ─────
async function loadRuns() {
  const th = S.cur;
  if (!th) return;
  const [r, d] = await Promise.all([api('GET', `/api/threads/${th}/runs`), api('GET', `/api/threads/${th}/deliveries`)]);
  if (th !== S.cur) return;
  S.runs = r.runs;
  S.deliveries = d.deliveries;
  renderRunLines();
  renderSummary();
  renderWait();
  if (S.auxOpen && S.tab === 'runs') renderRunsTab();
}
const activeRun = (r) => r.state === 'queued' || r.state === 'running';
/** 전달만 있고 아직 실행이 안 생긴 것(«전달 대기») */
function waitingDeliveries() {
  return S.deliveries.filter(
    (x) => (x.status === 'pending' || x.status === 'leased') && !S.runs.some((r) => r.trigger_seq === x.message_seq && r.agent_id === x.recipient_id),
  );
}
const runHref = (r) => `#run/${encodeURIComponent(r.id)}`;
/** 어댑터가 읽었나(시작 뒤 박동·경과가 왔나) — 읽음 반응은 기계적이라도 «반응 없음»과 가른다 */
const readAck = (r) => r.state === 'running' && (r.heartbeat_at != null || r.progress != null);
/** 경과 한 줄(첫 기계적 반응은 «✓ 읽음»으로 이미 보이므로 뺀다) + 그 뒤 지난 시간 */
function progressEl(r) {
  if (!r.progress || /^읽었음 — /.test(r.progress)) return null;
  return el('span', { class: 'progress', title: r.progress }, t('app.progress_recent', { text: r.progress }), el('span', { 'data-since': String(r.progress_at) }, dur(Date.now() - r.progress_at)), t('app.ago_close'));
}
function runLineEl(r) {
  const since = r.started_at ?? r.created_at;
  const err = r.error ? RUN_ERR[r.error] ?? r.error : '';
  const narrow = isNarrow();
  const look = el('a', { href: runHref(r), class: 'look' }, narrow ? t('app.view_status') : t('app.details'));
  if (r.state === 'running' && r.cancel_requested_at)
    return el(
      'div',
      { class: 'runline cancel' },
      el('span', { class: 'badge st-requested' }, t('app.cancel_requested')),
      el('span', {}, t('app.awaiting_stop_ack_left', { name: pname(r.agent_id) }), el('span', { 'data-until': String(r.cancel_deadline_at) }, t('app.secs', { n: Math.max(0, Math.ceil((r.cancel_deadline_at - Date.now()) / 1000)) }))),
      look,
    );
  if (activeRun(r))
    return el(
      'div',
      { class: 'runline' },
      el('span', { class: `badge st-${r.state}` }, STATE[r.state]),
      el(
        'span',
        {},
        t('app.run_active_line', { name: pname(r.agent_id), state: readAck(r) ? t('app.read_working') : r.state === 'running' ? t('app.generating') : t('app.waiting_start') }),
        el('span', { 'data-since': String(since) }, dur(Date.now() - since)),
        progressEl(r),
      ),
      // 좁은 화면은 한 줄 요약 + 상태 보기. 중단은 상세 화면에서만(기획서 3.1 표시)
      narrow ? null : el('button', { type: 'button', class: 'danger', onclick: () => cancelRunAsk(r) }, t('app.cancel_run')),
      look,
    );
  if (r.state === 'failed')
    return el(
      'div',
      { class: 'runline bad' },
      el('span', { class: 'badge st-failed' }, STATE.failed),
      t('app.run_failed_line', { name: pname(r.agent_id), err: err || t('app.failed'), extra: r.cancel_outcome === 'failed_first' ? t('app.failed_first_suffix') : '' }),
      look,
    );
  if (r.state === 'unknown')
    return el(
      'div',
      { class: 'runline bad' },
      el('span', { class: 'badge st-unknown' }, STATE.unknown),
      t('app.run_unknown_line', {
        name: pname(r.agent_id),
        reason: r.error === 'cancel_ack_timeout' ? t('app.ack_timeout_reason', { n: Math.round(S.cancelAckMs / 1000) }) : t('app.result_unknown_reason', { err: err ? `(${err})` : '' }),
        time: fmtHm(r.last_checked_at ?? r.finalized_at ?? r.ended_at),
      }),
      look,
    );
  if (r.state === 'cancelled')
    return el(
      'div',
      { class: 'runline cancel' },
      el('span', { class: 'badge st-cancelled' }, STATE.cancelled),
      `${pname(r.agent_id)}${r.cancel_outcome && OUTCOME[r.cancel_outcome] ? ` — ${OUTCOME[r.cancel_outcome]}` : err ? ` — ${err}` : ''}${r.cancel_outcome === 'acked' ? t('app.adapter_ack_at', { time: fmtHm(r.stop_ack_at) }) : ''}`,
      look,
    );
  // 완료는 메시지 행에 반복하지 않는다(정책 3) — 답 글이 곧 결과. 다만 취소 요청 중 완료는 알린다(완료 우선 확정)
  if (r.cancel_outcome === 'completed_first')
    return el('div', { class: 'runline cancel' }, el('span', { class: 'badge st-succeeded' }, t('app.outcome_completed_first')), t('app.completed_first_line', { name: pname(r.agent_id) }), look);
  return null;
}
function renderRunLines() {
  for (const box of document.querySelectorAll('#messages .runlines')) {
    const seq = Number(box.dataset.seq);
    const lines = [];
    const byAgent = new Map();
    for (const r of S.runs) if (r.trigger_seq === seq && (!byAgent.has(r.agent_id) || byAgent.get(r.agent_id).generation < r.generation)) byAgent.set(r.agent_id, r);
    for (const r of byAgent.values()) {
      const l = runLineEl(r);
      if (l) lines.push(l);
    }
    for (const x of S.deliveries.filter((x) => x.message_seq === seq && !byAgent.has(x.recipient_id))) {
      if (x.status === 'pending' || x.status === 'leased')
        lines.push(
          el(
            'div',
            { class: 'runline' },
            el('span', { class: `badge st-${x.status}` }, t('app.pending_delivery')),
            `${pname(x.recipient_id)} — ${x.status === 'leased' ? t('app.adapter_receiving') : t('app.not_taken_yet')}`,
            fwdNoteEl(x),
            // 수동 전달의 되돌리기: 대기면 «전달 취소», 실행이 생겼으면 위 실행 줄의 «실행 취소»(중단)
            x.forwarded_by && S.me?.is_master ? el('button', { type: 'button', class: 'danger', onclick: () => cancelForward(x) }, t('app.cancel_forward')) : null,
          ),
        );
      else if (x.status === 'dead') lines.push(el('div', { class: 'runline bad' }, el('span', { class: 'badge st-dead' }, t('app.delivery_failed')), `${pname(x.recipient_id)} — ${t('app.too_many_attempts')}`));
      else if (x.status === 'cancelled') lines.push(el('div', { class: 'runline cancel' }, el('span', { class: 'badge st-cancelled' }, t('app.delivery_withdrawn')), `${pname(x.recipient_id)}${x.last_error ? ` — ${RUN_ERR[x.last_error] ?? x.last_error}` : ''}`));
    }
    for (const h of (S.detail?.request_holds ?? []).filter((x) => x.request_seq === seq))
      lines.push(
        el(
          'div',
          { class: `runline ${h.acked_at ? 'cancel' : 'bad'}` },
          el('span', { class: 'badge st-failed' }, h.kind === 'held' ? t('app.request_held') : t('app.request_not_sent')),
          h.kind === 'held' ? `${pname(h.recipient_id)} — ${h.reason}` : t('app.chain_limit_line', { name: pname(h.recipient_id) }),
          h.acked_at ? el('span', { class: 'muted small' }, t('app.acked_suffix')) : null,
        ),
      );
    const fb = forwardBar(seq);
    box.parentElement?.querySelector(':scope > .msgbar > .fwdslot')?.replaceChildren(...(fb ? [fb] : []));
    const pb = pullBar(seq);
    if (pb) lines.push(pb);
    box.replaceChildren(...lines);
  }
}

// ───── 수동 전달(2026-10-12 마스터 #62) — 에이전트 글을 다른 에이전트에게. 마스터가 눌러야만 간다 ─────
/** 넘길 수 있는 대상 = 이 대화에서 읽을 수 있는 다른 에이전트 */
function forwardCandidates(m) {
  return (S.detail?.members ?? []).filter((x) => x.kind === 'agent' && x.can_read && x.participant_id !== m.author_id).map((x) => x.participant_id);
}
/** 전달 메모 한 줄(#740) — 없으면 null · 길면 잘라 보이고 전문은 title */
function fwdNoteEl(x) {
  if (!x.forward_note) return null;
  const one = x.forward_note.replace(/\s+/g, ' ');
  return el('span', { class: 'fwd-note-line small', title: x.forward_note }, t('app.note_suffix', { text: one.length > 80 ? one.slice(0, 80) + '…' : one }));
}
function forwardBar(seq) {
  if (!S.me?.is_master || !S.detail) return null;
  const m = S.messages.find((x) => x.seq === seq);
  if (!m || !isAgent(m.author_id)) return null;
  const cands = forwardCandidates(m);
  if (!cands.length) return null;
  // 거둔 전달(실행 없음)은 다시 보낼 수 있다 — 버튼을 되살린다
  const sent = new Map(
    S.deliveries.filter((x) => x.message_seq === seq && !((x.status === 'cancelled' || x.status === 'dead') && !x.run_id)).map((x) => [x.recipient_id, x]),
  );
  const paused = !!S.detail.thread.invoke_paused;
  const closed = S.detail.thread.status !== 'open' || !!S.detail.thread.deleted_at;
  const items = [];
  // 끝난 전달은 한 줄로 남긴다(진행 중·대기는 위 실행/전달 줄이 보여 준다)
  for (const [rid, x] of sent) {
    if (!x.forwarded_by || x.run_state !== 'succeeded') continue;
    const r = S.runs.find((r) => r.id === x.run_id);
    items.push(el('span', { class: 'small faint fwd-done' }, t('app.forwarded_to', { name: pname(rid) }), r?.result_seq ? el('a', { href: `#m${r.result_seq}`, onclick: (e) => (e.preventDefault(), jumpTo(r.result_seq)) }, t('app.reply_seq_suffix', { seq: r.result_seq })) : null, fwdNoteEl(x)));
  }
  const btn = (rid, label, signalled) =>
    el(
      'button',
      {
        type: 'button',
        class: signalled ? 'fwd primary-soft' : 'fwd',
        disabled: paused || closed,
        title: paused ? t('app.paused_cannot_forward') : t('app.forward_title', { seq, name: pname(rid) }),
        'data-fwd': `${seq}:${rid}`,
        onclick: () => doForward(m, rid),
      },
      label,
    );
  // 에이전트가 끝줄 «→ 이름»으로 고른 대상은 바로 버튼으로
  for (const rid of m.handoff_to ?? []) if (cands.includes(rid) && !sent.has(rid)) items.push(btn(rid, t('app.forward_to', { name: pname(rid) }), true));
  // 신호가 없어도 마스터는 아무 대상에게나 넘길 수 있다(신호는 편의 · 권한은 마스터)
  const rest = cands.filter((rid) => !sent.has(rid) && !(m.handoff_to ?? []).includes(rid));
  if (rest.length) {
    const menu = el('span', { class: 'fwd-menu', hidden: true }, ...rest.map((rid) => btn(rid, pname(rid), false)));
    items.push(
      el('button', { type: 'button', class: 'fwd ghost', disabled: paused || closed, 'aria-expanded': 'false', onclick: (e) => {
        menu.hidden = !menu.hidden;
        e.currentTarget.setAttribute('aria-expanded', String(!menu.hidden));
      } }, t('app.forward_more')),
      menu,
    );
  }
  if (!items.length) return null;
  if (paused && items.some((x) => x.tagName === 'BUTTON')) items.push(el('span', { class: 'small faint' }, t('app.paused')));
  return el('div', { class: 'fwdbar' }, ...items);
}
// ───── 맥락 끌어오기(2026-10-13 마스터 #162) — 에이전트가 끝줄 «← 스레드»로 청하면 마스터가 눌러 그 에이전트에게 건넨다 ─────
const pullLabel = (q) => `«${q.title}»${q.from_seq ? ` #${q.from_seq}${q.to_seq && q.to_seq !== q.from_seq ? `~#${q.to_seq}` : ''}` : ''}`;
function pullBar(seq) {
  if (!S.me?.is_master || !S.detail) return null;
  const m = S.messages.find((x) => x.seq === seq);
  if (!m || !m.pull_req) return null;
  const d = S.deliveries.find((x) => x.message_seq === seq && x.recipient_id === m.author_id && x.pulled_from);
  const live = d && !((d.status === 'cancelled' || d.status === 'dead') && !d.run_id);
  // 카드: 무엇을 언제 누구에게 건넸나(메시지가 아니라 배달 기록의 표시 — 스레드에 글을 만들지 않는다)
  if (live)
    return el(
      'div',
      { class: 'fwdbar pullcard' },
      el('span', { class: 'small' }, t('app.pulled_card', { title: d.pulled_title ?? d.pulled_from, from: d.pulled_from_seq, to: d.pulled_to_seq, n: d.pulled_count, name: pname(d.recipient_id) })),
      el('span', { class: 'small faint' }, ` · ${fmtHm(d.created_at)}`),
      d.pulled_truncated ? el('span', { class: 'small', title: t('app.pulled_truncated_title') }, t('app.pulled_truncated')) : null,
    );
  const paused = !!S.detail.thread.invoke_paused;
  const closed = S.detail.thread.status !== 'open' || !!S.detail.thread.deleted_at;
  return el(
    'div',
    { class: 'fwdbar' },
    el(
      'button',
      {
        type: 'button',
        class: 'fwd primary-soft pull',
        disabled: paused || closed,
        title: paused ? t('app.paused_cannot_pull') : t('app.pull_title', { name: pname(m.author_id) }),
        onclick: () => doPull(m),
      },
      t('app.pull_btn', { label: pullLabel(m.pull_req) }),
    ),
    paused ? el('span', { class: 'small faint' }, t('app.paused')) : null,
  );
}
async function doPull(m) {
  const path = `/api/threads/${encodeURIComponent(S.cur)}/messages/${m.seq}/pull`;
  let pv;
  try {
    pv = await api('GET', path);
  } catch (e) {
    await notify(t('app.cannot_pull'), e.message);
    return;
  }
  const size = t('app.pull_size', { title: pv.source.title, from: pv.from_seq, to: pv.to_seq, n: pv.count, tokens: pv.est_tokens.toLocaleString(I18N.locale) });
  if (pv.level === 'over') {
    await notify(t('app.over_budget_title'), t('app.over_budget_text', { size, name: pname(pv.recipient), budget: pv.budget_tokens.toLocaleString(I18N.locale) }));
    return;
  }
  if (pv.level === 'warn' || pv.level === 'unknown') {
    const why =
      pv.level === 'warn'
        ? t('app.pull_warn', { name: pname(pv.recipient), budget: pv.budget_tokens.toLocaleString(I18N.locale) })
        : t('app.pull_budget_unknown', { name: pname(pv.recipient) });
    const go = await ask({ title: t('app.pull_context'), text: t('app.pull_confirm', { size, why }), ok: t('app.pull') });
    if (!go) return;
  }
  try {
    await api('POST', path);
  } catch (e) {
    await notify(t('app.pull_failed'), e.code === 'invoke_paused' ? t('app.paused_retry') : e.message);
  }
  await loadRuns().catch(() => {});
}
// 전달 메모(마스터 #740) — 누르면 확인 창에 선택 입력 칸. 비우면 옛 전달 그대로 · 쓰면 받는 에이전트에게 «마스터 전달 메모 · 지시»로 실린다
const FORWARD_NOTE_MAX = 4000;
async function doForward(m, rid) {
  const note = el('textarea', { id: 'fwd-note', rows: 3, maxlength: FORWARD_NOTE_MAX, placeholder: t('app.fwd_note_ph'), 'aria-label': t('app.fwd_note_aria') });
  note.addEventListener('keydown', (e) => {
    // 여러 줄 입력 — Enter 는 줄바꿈, Ctrl/⌘+Enter 로 전달
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), $('confirm-ok').click());
    e.stopPropagation();
  });
  const go = ask({ title: t('app.forward_to', { name: pname(rid) }), text: t('app.forward_text', { seq: m.seq, name: pname(rid) }), ok: t('app.forward'), extra: el('label', { class: 'fwd-note' }, note) });
  note.focus();
  if (!(await go)) return;
  const body = note.value.trim() ? { recipient: rid, note: note.value.trim() } : { recipient: rid };
  try {
    await api('POST', `/api/threads/${encodeURIComponent(S.cur)}/messages/${m.seq}/forward`, body);
  } catch (e) {
    await notify(t('app.forward_failed'), e.code === 'invoke_paused' ? t('app.paused_retry') : e.message);
  }
  await loadRuns().catch(() => {});
}
async function cancelForward(x) {
  try {
    await api('POST', `/api/deliveries/${encodeURIComponent(x.id)}/cancel`);
  } catch (e) {
    // 그새 실행이 생겼다 — 실행 줄의 «실행 취소»(중단)로
    await notify(t('app.cancel_forward_failed'), e.code === 'has_run' ? t('app.already_running') : e.message);
  }
  await loadRuns().catch(() => {});
}
function renderWait() {
  const parts = [];
  for (const r of S.runs.filter(activeRun)) {
    const since = r.started_at ?? r.created_at;
    if (r.cancel_requested_at)
      parts.push(el('span', {}, t('app.wait_stop_ack', { name: pname(r.agent_id) }), el('span', { 'data-until': String(r.cancel_deadline_at) }, t('app.secs', { n: Math.max(0, Math.ceil((r.cancel_deadline_at - Date.now()) / 1000)) }))));
    else parts.push(el('span', {}, t('app.wait_line', { name: pname(r.agent_id), state: readAck(r) ? t('app.read_working') : r.state === 'running' ? t('app.waiting_reply') : t('app.waiting_to_start') }), el('span', { 'data-since': String(since) }, dur(Date.now() - since)), t('app.elapsed_suffix')));
  }
  const w = waitingDeliveries();
  if (w.length) parts.push(el('span', {}, t('app.pending_deliveries_n', { n: w.length, names: [...new Set(w.map((x) => pname(x.recipient_id)))].join(', ') })));
  const b = $('wait-banner');
  b.hidden = parts.length === 0;
  b.replaceChildren(...parts.flatMap((p, i) => (i ? [' · ', p] : [p])));
}
// 경과 시간은 1초마다 다시 쓴다
setInterval(() => {
  for (const e of document.querySelectorAll('[data-since]')) e.textContent = dur(Date.now() - Number(e.dataset.since));
}, 1000);

function runLi(r) {
  const since = r.started_at ?? r.created_at;
  const trig = [...S.context, ...S.messages].find((m) => m.seq === r.trigger_seq);
  const err = r.error ? RUN_ERR[r.error] ?? r.error : '';
  return el(
    'li',
    {},
    el(
      'div',
      { class: 'r1' },
      el('span', { class: `badge st-${runStateKey(r)}` }, stateLabel(r)),
      el('b', {}, pname(r.agent_id)),
      el('span', { class: 'faint' }, t('app.gen_n', { n: r.generation })),
      el('span', { class: 'spacer' }),
      el('a', { href: runHref(r), class: 'look' }, isNarrow() ? t('app.view_status') : t('app.details')),
    ),
    el('div', { class: 'muted' }, t('app.cause', { seq: r.trigger_seq, snippet: trig ? ` «${trig.body.slice(0, 40)}${trig.body.length > 40 ? '…' : ''}»` : '' })),
    el(
      'div',
      { class: 'faint' },
      activeRun(r)
        ? [t('app.start_prefix'), fmtHm(since), t('app.elapsed_mid'), el('span', { 'data-since': String(since) }, dur(Date.now() - since)), progressEl(r)]
        : [`${fmtHm(r.created_at)} → ${fmtHm(r.ended_at)}`, r.ended_at && r.started_at ? t('app.took_suffix', { d: dur(r.ended_at - r.started_at) }) : ''],
    ),
    r.cancel_outcome
      ? el(
          'div',
          { class: 'muted' },
          t('app.cancel_result', { x: OUTCOME[r.cancel_outcome] ?? r.cancel_outcome }),
          r.cancel_outcome === 'requested' ? [t('app.remaining_mid'), el('span', { 'data-until': String(r.cancel_deadline_at) }, '')] : null,
        )
      : null,
    err && (r.state !== 'cancelled' || !r.cancel_outcome) ? el('div', { class: r.state === 'cancelled' ? 'muted' : 'err' }, err) : null,
    r.state === 'unknown' ? el('div', { class: 'muted' }, t('app.not_retried')) : null,
    activeRun(r) && !r.cancel_requested_at && !isNarrow() ? el('button', { type: 'button', class: 'danger', onclick: () => cancelRunAsk(r) }, t('app.cancel_this_run')) : null,
  );
}
// ───── 보류된 요청(마스터 #352) — 받은 에이전트가 «보류: 사유»로 남겼거나 연쇄 상한에 걸려 서버가 만들지 않은 요청 ─────
function openHolds() {
  return (S.detail?.request_holds ?? []).filter((h) => !h.acked_at);
}
const HOLD_KIND = { held: t('app.hold'), chain_limit: t('app.chain_limit') };
function holdLi(h) {
  const reason = h.kind === 'chain_limit' ? t('app.chain_limit_reason') : h.reason;
  return el(
    'li',
    { class: h.acked_at ? '' : 'hold-open', 'data-hold': h.id },
    el(
      'div',
      { class: 'r1' },
      el('span', { class: `badge ${h.acked_at ? 'st-succeeded' : 'st-failed'}` }, HOLD_KIND[h.kind] ?? h.kind),
      el('b', {}, `${pname(h.requester_id)} → ${pname(h.recipient_id)}`),
      h.request_seq ? el('a', { href: `#m${h.request_seq}`, onclick: (e) => (e.preventDefault(), jumpTo(h.request_seq)) }, `#${h.request_seq}`) : null,
    ),
    el('div', { class: 'hold-reason' }, t('app.reason', { reason })),
    h.note ? el('div', { class: 'muted small hold-note' }, h.note.length > 300 ? `${h.note.slice(0, 300)}…` : h.note) : null,
    el('div', { class: 'muted small' }, `${fmtTime(h.created_at)}${h.acked_at ? t('app.acked_at_suffix', { time: fmtTime(h.acked_at) }) : ''}`),
    h.acked_at ? null : el('button', { type: 'button', class: 'hold-ack', onclick: () => ackHold(h) }, t('app.ack')),
  );
}
async function ackHold(h) {
  try {
    await api('POST', `/api/request-holds/${encodeURIComponent(h.id)}/ack`);
    announce(t('app.hold_acked'));
    await loadDetail();
  } catch (e) {
    notify(t('app.ack_failed'), e.message);
  }
}
function renderHolds() {
  const hs = S.detail?.request_holds ?? [];
  $('holds-count').textContent = hs.length ? t('app.holds_count', { open: openHolds().length, n: hs.length }) : '';
  $('holds').replaceChildren(...(hs.length ? hs.slice(0, 30).map(holdLi) : [el('li', { class: 'empty' }, t('app.none'))]));
}
function renderRunsTab() {
  renderHolds();
  const th = S.detail?.thread;
  const active = S.runs.filter(activeRun).length;
  const unknown = S.runs.filter((r) => r.state === 'unknown').length;
  $('runs-count').textContent = t('app.runs_count', { active, unknown, n: S.runs.length });
  $('runs-all').href = th ? `#runs?thread=${encodeURIComponent(th.id)}&since=` : '#runs';
  $('btn-stop-new').hidden = !th || th.invoke_paused;
  $('btn-resume').hidden = !th || !th.invoke_paused;
  $('paused-note').hidden = !th?.invoke_paused;
  $('runs').replaceChildren(...(S.runs.length ? S.runs.slice(0, 50).map(runLi) : [el('li', { class: 'empty' }, t('app.no_runs'))]));
  const w = waitingDeliveries();
  $('deliveries').replaceChildren(
    ...(w.length
      ? w.map((x) =>
          el(
            'li',
            {},
            el('div', { class: 'r1' }, el('span', { class: `badge st-${x.status}` }, x.status === 'leased' ? t('app.receiving') : t('app.pending_delivery')), el('b', {}, pname(x.recipient_id))),
            el('div', { class: 'muted' }, t('app.delivery_meta', { seq: x.message_seq, n: x.attempts })),
            el('button', { type: 'button', class: 'danger', onclick: () => cancelDeliveryAsk({ ...x, thread_id: S.cur }) }, t('app.cancel_forward')),
          ),
        )
      : [el('li', { class: 'empty' }, t('app.none'))]),
  );
}
// ───── 스레드 정리: 보관·숨김·휴지통·영구 삭제(마스터만 · 아래 분기까지 묶어 걸린다) ─────
function descendants(id) {
  const out = [];
  const walk = (p) => {
    for (const t of S.threads) if (t.parent_thread_id === p) out.push(t), walk(t.id);
  };
  walk(id);
  return out;
}
function renderStateMenu(th) {
  const st = stateOf(th);
  $('t-menu').hidden = th.kind === 'room';
  $('t-menu').open = false;
  const trash = st === 'trash';
  $('st-rename').hidden = trash;
  $('st-archive').hidden = trash || th.status === 'archived';
  $('st-unarchive').hidden = trash || th.status !== 'archived';
  $('st-hide').hidden = trash || !!th.hidden;
  $('st-unhide').hidden = trash || !th.hidden;
  $('st-trash').hidden = trash;
  $('st-restore').hidden = !trash;
  $('st-purge').hidden = !trash;
  const note = $('t-state-note');
  const msg = trash
    ? t('app.note_trash', { time: fmtTime(th.deleted_at) })
    : th.status === 'archived'
      ? t('app.note_archived')
      : th.hidden
        ? t('app.note_hidden')
        : '';
  note.textContent = msg;
  note.hidden = !msg;
}
const STATE_ERR = {
  runs_active: t('app.stateerr_runs_active'),
  room_locked: t('app.stateerr_room_locked'),
  thread_deleted: t('app.stateerr_thread_deleted'),
  not_in_trash: t('app.stateerr_not_in_trash'),
  descendants_not_in_trash: t('app.stateerr_descendants_not_in_trash'),
  confirm_mismatch: t('app.stateerr_confirm_mismatch'),
};
const STATE_ASK = {
  archive: { title: t('app.archive'), ok: t('app.archive'), text: t('app.archive_text') },
  hide: { title: t('app.hide_title'), ok: t('app.hide'), text: t('app.hide_text') },
  trash: { title: t('app.to_trash'), ok: t('app.to_trash'), danger: true, text: t('app.trash_text') },
};
async function setStateAsk(action) {
  const th = S.detail?.thread;
  if (!th) return;
  $('t-menu').open = false;
  const d = descendants(th.id);
  const q = STATE_ASK[action];
  if (q) {
    const ok = await ask({ ...q, text: t('app.state_ask_text', { title: th.title, branches: d.length ? t('app.and_branches', { n: d.length }) : '', text: q.text }) });
    if (!ok) return;
  }
  try {
    await api('POST', `/api/threads/${th.id}/state`, { action });
  } catch (e) {
    return notify(t('app.failed_title'), STATE_ERR[e.code] ?? e.message);
  }
  await Promise.all([loadDetail(), loadThreads()]);
}
for (const a of ['archive', 'unarchive', 'hide', 'unhide', 'trash', 'restore']) $(`st-${a}`).addEventListener('click', () => setStateAsk(a));
$('st-rename').addEventListener('click', async () => {
  const th = S.detail?.thread;
  if (!th) return;
  $('t-menu').open = false;
  const input = el('input', { type: 'text', id: 'rename-input', maxlength: '200', autocomplete: 'off', 'aria-label': t('app.new_name'), value: th.title });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) (e.preventDefault(), $('confirm-ok').click());
  });
  const asked = ask({ title: t('app.rename'), ok: t('app.rename_ok'), text: t('app.rename_text', { title: th.title }), extra: el('label', { class: 'small' }, t('app.new_name_label'), input) });
  input.focus(); // ask 는 «확인»에 초점을 둔다 — 이름 칸으로 옮긴다
  input.select();
  const ok = await asked;
  const title = input.value.trim();
  if (!ok || !title || title === th.title) return;
  try {
    await api('POST', `/api/threads/${th.id}/rename`, { title });
  } catch (e) {
    return notify(t('app.failed_title'), STATE_ERR[e.code] ?? e.message);
  }
  await Promise.all([loadDetail(), loadThreads()]);
  announce(t('app.renamed', { title }));
});
$('st-purge').addEventListener('click', async () => {
  const th = S.detail?.thread;
  if (!th) return;
  $('t-menu').open = false;
  const d = descendants(th.id);
  const input = el('input', { type: 'text', id: 'purge-confirm', autocomplete: 'off', 'aria-label': t('app.confirm_title_aria'), placeholder: th.title });
  const extra = el('label', { class: 'small' }, t('app.purge_type_title'), el('b', {}, th.title), input);
  const ok = await ask({
    title: t('app.purge'),
    danger: true,
    ok: t('app.purge'),
    text: t('app.purge_text', { title: th.title, branches: d.length ? t('app.and_branches', { n: d.length }) : '' }),
    extra,
  });
  if (!ok) return;
  try {
    await api('POST', `/api/threads/${th.id}/purge`, { confirm: input.value });
  } catch (e) {
    return notify(t('app.failed_title'), STATE_ERR[e.code] ?? e.message);
  }
  await loadThreads();
  location.hash = room()?.id ?? '';
});

$('btn-stop-new').addEventListener('click', async () => {
  const ok = await ask({
    title: t('app.pause_calls'),
    text: t('app.pause_calls_text'),
    ok: t('app.pause_calls'),
  });
  if (!ok) return;
  await api('POST', `/api/threads/${S.cur}/stop`, { mode: 'stop_new' }).catch((e) => notify(t('app.failed_title'), e.message));
  await Promise.all([loadDetail(), loadRuns(), loadThreads()]);
});
$('btn-resume').addEventListener('click', async () => {
  await api('POST', `/api/threads/${S.cur}/resume`).catch((e) => notify(t('app.failed_title'), e.message));
  await Promise.all([loadDetail(), loadThreads()]);
});
$('btn-cancel-current').addEventListener('click', () => cancelCurrentAsk());
async function cancelCurrentAsk() {
  const ok = await ask({
    title: t('app.cancel_current'),
    text: t('app.cancel_current_text', { n: Math.round(S.cancelAckMs / 1000) }),
    ok: t('app.cancel_all'),
    danger: true,
  });
  if (!ok) return;
  const r = await api('POST', `/api/threads/${S.cur}/stop`, { mode: 'cancel_current' }).catch((e) => (notify(t('app.failed_title'), e.message), null));
  if (r) announce(t('app.cancel_current_done', { w: r.withdrawn_deliveries ?? 0, c: r.cancelled_runs.length, r: (r.cancel_requested_runs ?? []).length }));
  await loadRuns();
}

// ───── 세션 ─────
/** 맥락 크기 표시(마스터 #283 C) — 1만 토큰 단위로 */
const ctxK = (n) =>
  t('app.tokens', {
    n:
      n < 10000
        ? n.toLocaleString(I18N.locale)
        : I18N.lang === 'ko'
          ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}만`
          : new Intl.NumberFormat(I18N.locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n),
  });
function sizeLine(cur, policy) {
  const m = cur?.metrics;
  if (!m) return t('app.not_measured');
  const parts = [];
  const tokPct = policy?.tokens && m.ctx_tokens != null ? m.ctx_tokens / policy.tokens : 0;
  const repPct = policy?.replies ? m.replies / policy.replies : 0;
  parts.push(m.ctx_tokens != null ? t('app.approx', { x: ctxK(m.ctx_tokens) }) : t('app.no_size_report'));
  parts.push(t('app.replies_n', { n: m.replies }));
  const rule = [policy?.tokens ? `${ctxK(policy.tokens)}` : null, policy?.replies ? t('app.replies_n', { n: policy.replies }) : null].filter(Boolean).join(t('app.or_sep'));
  const near = Math.max(tokPct, repPct);
  return el('span', { class: near >= 0.8 ? 'alertish' : '' }, `${parts.join(' · ')}${rule ? `${t('app.auto_rotate_rule', { rule })}${near >= 1 ? t('app.rotate_next') : near >= 0.8 ? t('app.rotate_soon') : ''}` : ''}`);
}
function renderSessionsTab() {
  const d = S.detail;
  const box = $('sessions');
  if (!d) return box.replaceChildren();
  const agents = d.members.filter((m) => m.kind === 'agent');
  if (!agents.length) return box.replaceChildren(el('p', { class: 'muted small' }, t('app.no_member_agents')));
  box.replaceChildren(
    ...agents.map((a) => {
      const all = d.sessions.filter((s) => s.agent_id === a.participant_id).sort((x, y) => y.generation - x.generation);
      const cur = all.find((s) => s.status === 'active');
      const kv = (k, v) => [el('dt', {}, k), el('dd', {}, v)];
      return el(
        'div',
        { class: 'sess' },
        el('div', { class: 's1' }, el('b', {}, a.name), cur ? el('span', { class: 'pill' }, `${t('app.active')} · ${t('app.gen_n', { n: cur.generation })}`) : el('span', { class: 'pill' }, t('app.no_session')), el('span', { class: 'spacer' }), el('button', { type: 'button', onclick: () => rotateAsk(a, cur) }, t('app.rotate_session'))),
        cur
          ? el(
              'dl',
              { class: 'kv' },
              kv(t('app.actual_model'), cur.actual_model ?? t('app.not_recorded_yet')),
              kv(t('app.runtime'), cur.runtime ?? t('app.not_recorded')),
              kv(t('app.config_version'), cur.config_version ?? t('app.not_recorded')),
              kv(t('app.gen_boundary'), cur.base_seq ? t('app.raw_after', { seq: cur.base_seq }) : t('app.from_start')),
              kv(t('app.last_delivered'), cur.last_delivered_seq ? `#${cur.last_delivered_seq}` : t('app.none')),
              kv(t('app.start'), fmtTime(cur.created_at)),
              kv(t('app.ctx_usage'), sizeLine(cur, d.rotate_policy)),
              cur.carry ? kv(t('app.carry'), t('app.carry_desc')) : null,
            )
          : el('p', { class: 'muted small' }, t('app.first_gen_note')),
        all.length
          ? el(
              'table',
              { class: 'hist' },
              el('thead', {}, el('tr', {}, el('th', {}, t('app.generation')), el('th', {}, t('app.state')), el('th', {}, t('app.reason_h')), el('th', {}, t('app.start')), el('th', {}, t('app.end')))),
              el('tbody', {}, ...all.map((s) => el('tr', {}, el('td', {}, String(s.generation)), el('td', {}, s.status === 'active' ? t('app.active') : t('app.ended')), el('td', {}, s.reason ?? ''), el('td', {}, fmtHm(s.created_at)), el('td', {}, fmtHm(s.ended_at))))),
            )
          : null,
      );
    }),
  );
}
async function rotateAsk(a, cur) {
  const kindSel = el(
    'select',
    { id: 'rotate-kind' },
    ...[
      ['오류', t('app.rot_error')],
      ['모델 변경', t('app.rot_model')],
      ['설정 변경', t('app.rot_config')],
      ['포화', t('app.rot_full')],
      ['기타', t('app.rot_other')],
    ].map(([v, label]) => el('option', { value: v }, label)),
  );
  const memo = el('input', { id: 'rotate-memo', placeholder: t('app.memo_optional'), maxlength: '300' });
  // 이어받기(마스터 #283 C): 맥락이 무거워 바꾸는 것이면 최근 글 원문 + 사서 요약을 들고 간다. 오류·모델 변경이면 빈 손이 낫다
  const carry = el('input', { type: 'checkbox', id: 'rotate-carry', checked: true });
  kindSel.value = '포화';
  kindSel.addEventListener('change', () => (carry.checked = kindSel.value === '포화' || kindSel.value === '기타'));
  const n = S.detail?.rotate_policy?.carry_messages ?? 12;
  const extra = el(
    'div',
    {},
    cur ? el('p', { class: 'small' }, t('app.ctx_now'), sizeLine(cur, S.detail?.rotate_policy)) : null,
    el('div', { class: 'row wrap' }, el('label', { class: 'small' }, t('app.rotate_reason'), kindSel), memo),
    el('label', { class: 'small' }, carry, t('app.carry_label', { n })),
  );
  const ok = await ask({
    title: t('app.rotate_title', { name: a.name }),
    text: cur ? t('app.rotate_text_cur', { g: cur.generation, next: cur.generation + 1 }) : t('app.rotate_text_new'),
    ok: t('app.rotate_session'),
    extra,
  });
  if (!ok) return;
  const reason = memo.value.trim() ? `${kindSel.value}: ${memo.value.trim()}` : kindSel.value;
  await api('POST', `/api/threads/${S.cur}/sessions/rotate`, { agent_id: a.participant_id, reason, carry: carry.checked }).catch((e) => notify(t('app.rotate_failed'), e.message));
  await Promise.all([loadDetail(), loadRuns()]);
}

// ───── 참여자 · 연결 ─────
async function loadAgents() {
  try {
    const r = await api('GET', '/api/agents');
    S.agents = new Map(r.agents.map((a) => [a.id, a]));
  } catch {}
  if (S.auxOpen && S.tab === 'people') renderPeopleTab();
}
function agentConn(id) {
  const a = S.agents.get(id);
  if (!a) return { cls: '', text: t('app.conn_unknown') };
  if (a.state === 'no_credential') return { cls: 'off', text: t('app.conn_no_token') };
  if (a.state === 'revoked') return { cls: 'off', text: `${t('app.conn_revoked')}${a.last_seen_at ? t('app.last_seen_suffix', { when: rel(a.last_seen_at) }) : ''}` };
  if (a.state === 'never') return { cls: '', text: t('app.conn_never') };
  const age = Date.now() - a.last_seen_at;
  return { cls: age < 60_000 ? 'on' : 'stale', text: t('app.last_seen', { when: age < 60_000 ? t('app.secs_ago', { n: Math.max(1, Math.floor(age / 1000)) }) : rel(a.last_seen_at) }) };
}
function renderPeopleTab() {
  $('sync-info').replaceChildren(
    el('div', {}, t('app.realtime'), el('b', {}, S.wsOpen ? t('app.ws_connected') : t('app.ws_reconnecting'))),
    el('div', { class: 'muted' }, t('app.last_sync', { time: S.lastSync ? fmtTime(S.lastSync) : t('app.none_yet') })),
  );
  const d = S.detail;
  if (!d) return $('people').replaceChildren();
  $('people').replaceChildren(
    ...d.members.map((m) => {
      const c = m.kind === 'agent' ? agentConn(m.participant_id) : { cls: 'on', text: m.participant_id === S.me?.id ? t('app.this_screen') : '' };
      return el(
        'li',
        {},
        el('span', { class: `dot ${c.cls}`, 'aria-hidden': 'true' }),
        el('span', { class: 'who' }, el('b', {}, m.name), ' ', el('span', { class: 'faint' }, m.kind === 'agent' ? t('app.agent') : t('app.master')), el('div', { class: 'muted' }, c.text)),
        el('span', { class: 'faint' }, [m.can_read ? t('app.perm_read') : '', m.can_post ? t('app.perm_post') : '', m.can_invoke ? t('app.perm_invoke') : ''].filter(Boolean).join('·')),
      );
    }),
  );
}
setInterval(() => {
  if (S.auxOpen && S.tab === 'people' && !$('app-view').hidden) loadAgents();
}, 15000);

// ───── 스레드 생성 2단계 ─────
function openFork(seq) {
  if (!S.detail) return;
  const cands = [...S.context, ...S.messages].sort((a, b) => a.seq - b.seq);
  if (!cands.length) {
    notify(t('app.new_thread'), t('app.fork_no_messages'));
    return;
  }
  S.fork = {
    source: S.cur,
    sourceTitle: S.detail.thread.title,
    cands,
    point: seq ?? cands[cands.length - 1].seq,
    preset: 'upto',
    picked: null,
    key: null,
    sig: null,
    busy: false,
    back: document.activeElement,
  };
  $('fork-title').value = '';
  $('fork-error').hidden = true;
  $('fork-modal').hidden = false;
  forkStep(1);
}
function forkStep(n) {
  const f = S.fork;
  $('fork-stepno').textContent = `${n} / 2`;
  $('fork-step1').hidden = n !== 1;
  $('fork-step2').hidden = n !== 2;
  if (n === 1) {
    $('fork-parent').textContent = t('app.parent_label', { name: S.detail.thread.kind === 'room' ? t('app.main_room') : pathOf(S.detail.thread) });
    $('fork-points').replaceChildren(
      ...f.cands.map((m) => {
        const r = el('input', { type: 'radio', name: 'fork-point', value: String(m.seq), checked: m.seq === f.point, 'aria-label': t('app.set_branch_point_aria', { seq: m.seq }) });
        r.addEventListener('change', () => {
          f.point = m.seq;
          f.picked = null;
          for (const p of $('fork-points').querySelectorAll('.pick')) p.classList.toggle('sel', p.dataset.seq === String(m.seq));
          syncForkNext();
        });
        return el('label', { class: `pick${m.seq === f.point ? ' sel' : ''}`, 'data-seq': String(m.seq) }, r, pickBody(m), el('span', { class: 'tag' }, t('app.set_branch_point')));
      }),
    );
    const sel = $('fork-points').querySelector('.pick.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
    syncForkNext();
    $('fork-title').focus();
  } else renderForkStep2();
}
function pickBody(m) {
  return el(
    'span',
    { class: 'pm' },
    el('span', { class: 'ph' }, el('b', {}, pname(m.author_id)), el('span', {}, `#${m.seq}`), el('span', {}, fmtTime(m.created_at)), S.context.some((c) => c.seq === m.seq) ? el('span', {}, t('app.inherited_ctx')) : null),
    el('span', { class: 'pb' }, m.body),
  );
}
function syncForkNext() {
  $('fork-next').disabled = !$('fork-title').value.trim() || !S.fork?.point;
}
$('fork-title').addEventListener('input', syncForkNext);
$('fork-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('fork-next').disabled) forkStep(2);
});
$('fork-next').addEventListener('click', () => forkStep(2));
$('fork-back').addEventListener('click', () => forkStep(1));
function closeFork() {
  $('fork-modal').hidden = true;
  // 새 주제 창을 취소하면 맡길 글은 지금 대화의 글쓰기 칸으로
  const pc = S.pendingCompose;
  S.pendingCompose = null;
  const back = S.fork?.back;
  S.fork = null;
  if (pc) fillCompose(pc.text, pc.to);
  else if (back && back.focus) back.focus();
}
$('fork-cancel').addEventListener('click', closeFork);
$('fork-x').addEventListener('click', closeFork);
for (const r of document.querySelectorAll('input[name=fork-preset]'))
  r.addEventListener('change', () => {
    S.fork.preset = r.value;
    if (r.value !== 'pick') S.fork.picked = null;
    renderForkStep2();
  });
$('fork-recent-n').addEventListener('input', () => {
  S.fork.preset = 'recent';
  S.fork.picked = null;
  renderForkStep2();
});
function forkRange() {
  const f = S.fork;
  const upto = f.cands.filter((m) => m.seq <= f.point);
  if (f.preset === 'pick' && f.picked) return new Set([...f.picked, f.point]);
  if (f.preset === 'recent') {
    const n = Math.max(1, Math.floor(Number($('fork-recent-n').value) || 1));
    return new Set(upto.slice(-n).map((m) => m.seq));
  }
  return new Set(upto.map((m) => m.seq));
}
function renderForkStep2() {
  const f = S.fork;
  for (const r of document.querySelectorAll('input[name=fork-preset]')) r.checked = r.value === f.preset;
  const pm = f.cands.find((m) => m.seq === f.point);
  const dr = S.detail.thread.default_recipient;
  const agents = S.detail.members.filter((m) => m.kind === 'agent');
  const drSel = el(
    'select',
    { id: 'fork-dr', 'aria-label': t('app.default_recipient') },
    el('option', { value: '' }, t('app.same_as_parent', { x: dr ? pname(dr) : t('app.none') })),
    ...agents.map((a) => el('option', { value: a.participant_id, selected: f.dr === a.participant_id }, a.name)),
  );
  drSel.addEventListener('change', () => (f.dr = drSel.value || null));
  const kv = (k, ...v) => [el('dt', {}, k), el('dd', {}, ...v)];
  $('fork-summary').replaceChildren(
    ...kv(t('app.title'), $('fork-title').value.trim()),
    ...kv(t('app.parent'), S.detail.thread.kind === 'room' ? t('app.main_room') : pathOf(S.detail.thread)),
    ...kv(t('app.branch_point_msg'), `#${pm.seq} · ${fmtTime(pm.created_at)} · ${pname(pm.author_id)}`),
    ...kv(t('app.participating_agents'), t('app.same_as_parent', { x: agents.map((a) => a.name).join(', ') || t('app.none') })),
    ...kv(t('app.default_recipient'), drSel),
  );
  const inc = forkRange();
  const upto = f.cands.filter((m) => m.seq <= f.point);
  $('fork-count').replaceChildren(t('app.fork_count_pre'), el('b', {}, String(inc.size)), t('app.fork_count_post'));
  $('fork-include').replaceChildren(
    ...upto.map((m) => {
      const isPoint = m.seq === f.point;
      const cb = el('input', { type: 'checkbox', value: String(m.seq), checked: inc.has(m.seq), disabled: isPoint, 'aria-label': t('app.include_aria', { seq: m.seq }) });
      cb.addEventListener('change', () => {
        const cur = forkRange();
        if (cb.checked) cur.add(m.seq);
        else cur.delete(m.seq);
        f.preset = 'pick';
        f.picked = cur;
        renderForkStep2();
      });
      return el('label', { class: `pick${inc.has(m.seq) ? ' sel' : ''}` }, cb, pickBody(m), isPoint ? el('span', { class: 'tag' }, t('app.branch_point')) : null);
    }),
  );
  $('fork-go').disabled = inc.size === 0 || f.busy;
}
const FORK_ERR = {
  bad_fork_point: t('app.forkerr_bad_fork_point'),
  bad_include: t('app.forkerr_bad_include'),
  no_thread: t('app.forkerr_no_thread'),
  client_key_reused: t('app.forkerr_client_key_reused'),
  bad_recipient: t('app.forkerr_bad_recipient'),
};
$('fork-go').addEventListener('click', submitFork);
async function submitFork() {
  const f = S.fork;
  if (!f || f.busy) return;
  const include = [...forkRange()].sort((a, b) => a - b);
  const body = { from_seq: f.point, title: $('fork-title').value.trim(), include, default_recipient: f.dr || undefined };
  const sig = JSON.stringify([f.source, body]);
  // 같은 내용의 재시도는 같은 요청 식별자로 — 서버가 스레드를 하나만 만든다
  if (sig !== f.sig) {
    f.sig = sig;
    f.key = newKey();
  }
  f.busy = true;
  $('fork-go').disabled = true;
  $('fork-error').hidden = true;
  try {
    const r = await api('POST', `/api/threads/${f.source}/fork`, { ...body, client_key: f.key });
    f.busy = false;
    const pc = S.pendingCompose;
    S.pendingCompose = null;
    closeFork();
    await loadThreads();
    if (pc) {
      history.replaceState(null, '', `${location.pathname}#${r.thread.id}`);
      await route();
      fillCompose(pc.text, pc.to);
    } else location.hash = r.thread.id;
  } catch (err) {
    f.busy = false;
    if (err.code === 'client_key_reused') f.sig = null;
    const msg = err.status ? FORK_ERR[err.code] ?? `${err.message}` : t('app.fork_no_response');
    const box = $('fork-error');
    box.hidden = false;
    box.replaceChildren(
      el('b', {}, t('app.fork_failed')),
      el('div', {}, msg),
      el('div', { class: 'row' }, el('button', { type: 'button', onclick: () => forkStep(1) }, t('app.back')), el('button', { type: 'button', id: 'fork-retry', class: 'primary', onclick: submitFork }, t('app.retry_again'))),
    );
    $('fork-go').disabled = false;
  }
}
$('fork-btn').addEventListener('click', () => openFork());

// ───── 보내기: 전송 중 · 완료 · 실패 · 미확인 ─────
function newKey() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
async function send(item) {
  item.state = 'sending';
  item.error = null;
  renderOutbox();
  try {
    // 첨부를 먼저 올린다(다시 시도하면 못 올린 것만) — 메시지는 다 올라간 뒤에 묶어서 한 번에 쓴다
    const files = item.files ?? [];
    item.uploads ??= [];
    for (let i = 0; i < files.length; i++) {
      if (item.uploads[i]) continue;
      item.upNote = t('app.uploading', { i: i + 1, n: files.length });
      renderOutbox();
      try {
        const u = await api('POST', `/api/uploads?name=${encodeURIComponent(files[i].name)}`, undefined, files[i]);
        item.uploads[i] = u.upload.id;
      } catch (e) {
        if (e.status) {
          e.message = t('app.att_error', { name: files[i].name, msg: e.status === 413 ? t('app.over_20mb') : e.message });
          e.att = true; // 첨부 오류 표시(실패 칸에 그대로 보인다)
        }
        throw e;
      }
    }
    item.upNote = null;
    if (files.length) item.payload.attachments = item.uploads;
    const r = await api('POST', `/api/threads/${item.thread}/messages`, item.payload);
    item.seq = r.message.seq;
    item.target = r.target;
    if (item.payload.recipients.length && !r.invoke_paused) markAwait(r.message.thread_id ?? item.thread, r.message.seq);
    S.sentKeys.add(item.payload.client_key);
    item.state = 'stored'; // 저장 확인. 목록에서 그 seq 를 받으면 «전송 완료»로 바뀌고 사라진다
    announce(t('app.sent_to', { title: r.target?.title ?? '' }));
    if (r.invoke_paused && item.payload.recipients.length) notify(t('app.saved_only'), t('app.saved_only_text'));
  } catch (err) {
    if (!err.status || err.status >= 500 || err.status === 408) {
      // 응답을 못 받았다 — 저장됐는지 모른다. 같은 client_key 로 다시 물어 확인한다
      item.state = 'unknown';
      item.error = err.status ? t('app.server_error', { status: err.status }) : t('app.no_response');
      announce(t('app.send_unknown'));
    } else {
      item.state = 'failed';
      item.error = (err.att ? err.message : SEND_ERR[err.code]) ?? err.message;
      item.retryable = err.status === 429;
      announce(t('app.send_failed_msg', { error: item.error }));
    }
  }
  renderOutbox();
  if (item.thread === S.cur) await fetchNew().catch(() => {});
  loadRuns().catch(() => {});
}
/** 목록에 실제로 들어온 것은 내보낸 칸에서 걷는다 */
function settleOutbox() {
  const before = S.outbox.length;
  S.outbox = S.outbox.filter((x) => !(x.state === 'stored' && x.thread === S.cur && S.seen.has(x.seq)));
  if (S.outbox.length !== before) {
    // 걷힌 것은 메시지 행에 «✓ 전송 완료»로 보인다 — 행을 다시 그린다
    for (const m of S.messages) if (S.sentKeys.has(m.client_key)) {
      const old = $(`m${m.seq}`);
      if (old && !old.querySelector('.sendst')) old.replaceWith(msgEl(m, false));
    }
  }
  renderOutbox();
}
function renderOutbox() {
  const items = S.outbox.filter((x) => x.thread === S.cur);
  $('pending').replaceChildren(
    ...items.map((x) => {
      let st;
      if (x.state === 'sending') st = el('span', { class: 'sendst wait' }, x.upNote ? `${x.upNote}…` : t('app.sending'));
      else if (x.state === 'stored') st = el('span', { class: 'sendst wait' }, t('app.stored_wait'));
      else if (x.state === 'unknown')
        st = el(
          'div',
          { class: 'local-state unknown' },
          el('b', { class: 'sendst unknown' }, t('app.send_unknown')),
          t('app.unknown_explain', { error: x.error }),
          el('button', { type: 'button', class: 'retry', onclick: () => send(x) }, t('app.check_again')),
          el('button', { type: 'button', onclick: () => reconnectNow() }, t('app.reconnect_recover')),
          el('button', { type: 'button', onclick: () => dropItem(x) }, t('app.discard')),
        );
      else
        st = el(
          'div',
          { class: 'local-state failed' },
          el('b', { class: 'sendst failed' }, t('app.send_failed')),
          x.error,
          x.retryable ? el('button', { type: 'button', class: 'retry', onclick: () => send(x) }, t('app.retry')) : el('span', { class: 'faint' }, t('app.same_result')),
          el('button', { type: 'button', onclick: () => editItem(x) }, t('app.edit')),
          el('button', { type: 'button', onclick: () => dropItem(x) }, t('app.discard')),
        );
      return el(
        'article',
        { class: 'msg mine local', 'data-key': x.payload.client_key },
        el('span', { class: 'avatar', 'aria-hidden': 'true' }, S.me ? initials(S.me.id) : t('app.me')),
        el(
          'div',
          { class: 'main' },
          el('div', { class: 'head' }, el('b', {}, S.me?.name ?? t('app.me')), el('span', { class: 'badge' }, KIND[x.payload.source_kind]), x.payload.recipients.length ? el('span', {}, `→ ${x.payload.recipients.map(pname).join(', ')}`) : null, x.state === 'sending' || x.state === 'stored' ? st : null),
          el('div', { class: 'body' }, x.payload.body),
          x.files?.length ? el('div', { class: 'small faint' }, `📎 ${x.files.map((f) => f.name).join(', ')}`) : null,
          x.state === 'unknown' || x.state === 'failed' ? st : null,
        ),
      );
    }),
  );
  if (items.length) syncEmpty();
}
function dropItem(x) {
  S.outbox = S.outbox.filter((y) => y !== x);
  renderOutbox();
}
function editItem(x) {
  dropItem(x);
  $('body').value = x.payload.body;
  for (const x2 of S.attach) if (x2.url) URL.revokeObjectURL(x2.url);
  S.attach = [];
  addFiles(x.files ?? []);
  $('body').focus();
}
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('send-btn').disabled) return;
  const body = $('body').value;
  if ((!body.trim() && !S.attach.length) || !S.cur) return;
  const recipients = selectedRecipients();
  // 받는 쪽을 안 고른 채 보내면 막는다(마스터 #271) — 에이전트를 고르거나 «메모»로 «아무에게도 안 보냄»을 밝힌다
  if (!recipients.length && !memoChosen() && $('recipients').querySelector('input[data-agent]')) {
    const note = $('rcpt-note');
    if (note) {
      note.textContent = t('app.no_recipient_warn');
      note.classList.add('rcpt-warn');
    }
    $('recipients').querySelector('input[data-memo]')?.focus();
    return;
  }
  const payload = {
    client_key: newKey(),
    body,
    source_kind: $('source-kind').value,
    input_mode: 'text',
    recipients,
    reply_to_seq: S.replyTo ?? undefined,
    call_budget: recipients.length ? Number($('budget').value) : undefined,
  };
  const files = S.attach.map((x) => x.file);
  for (const x of S.attach) if (x.url) URL.revokeObjectURL(x.url);
  S.attach = [];
  renderAttach();
  // 대상은 지금 화면의 대화 — 요청 URL 에 박혀 서버가 그 대화에만 저장한다
  const item = { thread: S.cur, payload, files, state: 'sending' };
  S.outbox.push(item);
  $('body').value = '';
  S.prefillTo = null;
  syncMore();
  clearReply();
  $('empty-thread').hidden = true;
  scrollBottom();
  await send(item);
});
// Enter·Ctrl+Enter = 보내기 · Shift+Enter = 줄바꿈(마스터 #271). 한글 조합 중의 Enter 는 글자 확정이라 보내지 않는다
$('body').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  $('composer').requestSubmit();
});

// ───── 상단 띠: 재접속 중 / 대량 메시지 복구 중 / 전체 재조회 필요 / 복구 완료 ─────
let bannerTimer = null;
function setBanner(kind, text, pct, action) {
  clearTimeout(bannerTimer);
  const b = $('banner');
  if (!kind) {
    b.hidden = true;
    return;
  }
  b.hidden = false;
  b.className = `banner ${kind === 'done' ? 'ok' : kind === 'full' ? 'bad' : 'warn'}`;
  b.dataset.state = kind;
  b.replaceChildren(el('b', {}, { reconnect: t('app.banner_reconnect'), bulk: t('app.banner_bulk'), full: t('app.banner_full'), done: t('app.banner_done') }[kind]), el('span', {}, text ?? ''), action ?? null);
  if (pct != null) {
    const bar = el('span');
    bar.style.width = `${Math.round(pct)}%`;
    b.append(el('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': String(Math.round(pct)), 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar));
  }
  if (kind === 'done') bannerTimer = setTimeout(() => setBanner(null), 4000);
}
/** 다시 붙은 뒤 복구: 기준점(지금 서버의 마지막 seq)까지 커서로 묶음 조회, 끝나면 순서·중복을 검사한다 */
async function recover() {
  await loadThreads().catch(() => {});
  queueLive();
  refreshRunsPage();
  refreshAdminPage(null);
  onDelegationNotice(); // 끊긴 동안 놓친 위임 알림
  if (!S.cur) return;
  const th = S.cur;
  let baseline = null;
  try {
    const d = await api('GET', `/api/threads/${th}`);
    if (th !== S.cur) return;
    baseline = d.thread.last_seq ?? 0;
    S.detail = d;
    renderHead();
    renderRecipients();
  } catch {
    return;
  }
  const show = S.everConnected;
  if (S.cursor > baseline) {
    // 서버가 우리 커서보다 뒤에 있다(DB 를 백업으로 되돌린 경우 등) — 커서가 무효. 처음부터 다시 읽는다
    setBanner('full', t('app.server_shorter'));
    await reloadMessages();
    setBanner('done', t('app.reloaded_n', { n: S.messages.length }));
    return;
  }
  const start = S.cursor;
  let bulk = false;
  const added = await fetchNew((n, cursor, more) => {
    if (more && !bulk && show) bulk = true;
    if (bulk) setBanner('bulk', t('app.received_n', { n }), baseline > start ? ((cursor - start) / (baseline - start)) * 100 : 100);
  }).catch(() => null);
  if (added === null) return;
  // 복구 검증: seq 오름차순 · 중복 없음 — 어긋나면 전체 재조회
  const ok = S.messages.every((m, i) => i === 0 || S.messages[i - 1].seq < m.seq) && new Set(S.messages.map((m) => m.seq)).size === S.messages.length;
  if (!ok) {
    setBanner('full', t('app.list_mismatch'));
    await reloadMessages();
  }
  await Promise.all([loadRuns(), loadContext()]).catch(() => {});
  if (show) setBanner('done', added ? t('app.missing_received', { n: added }) : t('app.no_missing'));
  // 응답을 못 받은 전송은 같은 요청 식별자로 다시 확인한다
  for (const x of S.outbox.filter((x) => x.state === 'unknown')) send(x);
}

// ───── WebSocket: 알림만. 끊기면 물러서며 다시 붙고, 붙으면 커서 이후를 다시 읽는다 ─────
function setConn(on, text) {
  const c = $('conn');
  c.className = `conn ${on ? 'on' : 'off'}`;
  c.textContent = text;
}
let pingTimer = null;
let retryTimer = null;
function connectWs() {
  if (S.ws && (S.ws.readyState === WebSocket.OPEN || S.ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(retryTimer);
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  S.ws = ws;
  setConn(false, t('app.connecting'));
  ws.onopen = () => {
    S.wsBackoff = 1000;
    S.wsOpen = true;
    setConn(true, t('app.connected'));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"t":"ping"}'), 25000);
  };
  ws.onmessage = (ev) => {
    let n;
    try {
      n = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (n.t === 'hello') {
      recover().finally(() => (S.everConnected = true));
    } else if (n.t === 'msg' && n.thread_id === S.cur) {
      if (S.seen.has(n.seq)) reloadMessages();
      else fetchNew();
      loadThreads().catch(() => {});
      loadRuns().catch(() => {}); // 새 글이 전달(전달 대기)을 만들었을 수 있다
      refreshRunsPage();
    } else if (n.t === 'msg') {
      loadThreads().catch(() => {});
      refreshRunsPage();
    } else if (n.t === 'run') {
      if (n.thread_id === S.cur) loadRuns();
      queueLive();
      refreshRunsPage();
    } else if (n.t === 'thread') {
      if (room() && n.thread_id === room().id) S.roomDirty = true;
      loadThreads().catch(() => {});
      refreshAdminPage(n.thread_id);
      if (n.thread_id === S.cur) {
        loadDetail().catch(() => {});
        loadRuns().catch(() => {}); // 전달 대기를 거뒀을 수 있다
      }
      refreshRunsPage();
    } else if (n.t === 'delegation') {
      onDelegationNotice();
    } else if (n.t === 'face' && n.thread_id === S.cur) {
      if (faceActive()) loadFace().catch(() => {});
    }
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    S.wsOpen = false;
    if ($('app-view').hidden) return;
    const secs = Math.round(S.wsBackoff / 1000);
    setConn(false, t('app.disconnected_retry', { n: secs }));
    if (S.cur) setBanner('reconnect', t('app.ws_lost_banner', { n: secs }), null, el('button', { type: 'button', onclick: reconnectNow }, t('app.reconnect_now')));
    retryTimer = setTimeout(retryConnect, S.wsBackoff);
    S.wsBackoff = Math.min(S.wsBackoff * 2, 30000);
  };
}
async function retryConnect() {
  // 세션이 끊겼는지 REST 로 확인(401 이면 로그인 화면)
  try {
    await api('GET', '/api/me');
    connectWs();
  } catch (e) {
    if (e.status === 401 || $('app-view').hidden) return;
    retryTimer = setTimeout(retryConnect, S.wsBackoff);
    S.wsBackoff = Math.min(S.wsBackoff * 2, 30000);
  }
}
function reconnectNow() {
  S.wsBackoff = 1000;
  if (S.ws && S.ws.readyState === WebSocket.OPEN) return recover();
  retryConnect();
}
/** 첨부가 붙는 등 기존 메시지가 바뀌면 통째로 다시 */
async function reloadMessages() {
  S.messages = [];
  S.seen = new Set();
  S.cursor = 0;
  $('messages').replaceChildren();
  await fetchNew();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('app-view').hidden) {
    connectWs();
    recover();
    if (clearSeenAwait()) renderList();
  }
});
window.addEventListener('online', () => reconnectNow());

// ───── 키보드: Alt+1~9 수신 대상 켜고 끄기(칩 순서) · Alt+0 전체 · Esc 닫기 → 닫을 게 없으면 현재 실행 취소 ─────
// 2026-10-12 마스터 #70: 목록·메시지·작성란 이동 단축키를 걷고 수신 대상 고르기로. 숫자는 e.code 로 본다(Mac 의 Option+숫자는 다른 글자를 낸다)
document.addEventListener('keydown', (e) => {
  const digit = /^Digit([0-9])$/.exec(e.code ?? '')?.[1] ?? (/^[0-9]$/.test(e.key) ? e.key : null);
  if (e.altKey && !e.ctrlKey && !e.metaKey && digit !== null) {
    const box = $('recipients');
    const input = digit === '0' ? box.querySelector('input[data-all]') : box.querySelectorAll('input[data-agent]')[Number(digit) - 1];
    if (!input || $('app-view').hidden || !$('confirm').hidden) return;
    e.preventDefault();
    input.checked = !input.checked;
    onChip(input);
  } else if (e.key === 'Escape') {
    if (e.isComposing) return;
    if (!$('confirm').hidden) confirmResolve && confirmResolve(false);
    else if (!$('fork-modal').hidden) closeFork();
    else if (document.body.classList.contains('show-sidebar')) setDrawer(false);
    else if (S.auxOpen && auxOverlays()) setAux(false);
    else if (S.mode === 'audit' && S.auOpen) closeAuditDetail();
    // 보낸 글 취소(마스터 #475) — 닫을 게 없고 이 대화에 안 나간 전달이나 대기·실행 중인 실행이 있을 때만 · 확인 창(Enter 확인 · Esc 그만)
    else if (S.mode === 'convo' && S.cur && !$('app-view').hidden && (S.runs.some(activeRun) || S.deliveries.some((x) => x.status === 'pending' || x.status === 'leased'))) {
      e.preventDefault();
      cancelCurrentAsk();
    }
  }
});
// 좁은 화면 아래 시트가 작성란을 가리지 않게: 작성란 높이를 CSS 변수로
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => document.documentElement.style.setProperty('--composer-h', `${$('composer').offsetHeight}px`)).observe($('composer'));
}
if (typeof matchMedia === 'function') {
  const onMq = () => {
    syncSendable();
    syncBackdrop();
    if (S.mode === 'runs' && S.runsPane === 'list') renderRunsTable();
    if (S.mode === 'audit') renderAuditTable();
    if (S.mode === 'members') renderMembers();
    if (S.mode === 'agents') renderConnections();
    if (S.mode === 'convo') {
      renderRunLines();
      if (S.auxOpen && S.tab === 'runs') renderRunsTab();
    }
  };
  for (const q of ['(max-width: 760px)', '(max-width: 999px)', '(max-width: 1279px)']) {
    const mq = matchMedia(q);
    if (mq.addEventListener) mq.addEventListener('change', onMq);
  }
}

// ───── 시작 ─────
async function boot() {
  let me;
  try {
    me = await api('GET', '/api/me');
  } catch {
    return showLogin();
  }
  S.me = me.participant;
  S.onCallOnly = new Set(me.on_call_only ?? []);
  S.modules = new Set(me.modules ?? []); // 켠 선택 모듈(docs/MODULES.md)
  // 꺼진 모듈의 자리는 안 그린다(선점 탭 = delegations)
  const dlgOn = S.modules.has('delegations');
  document.querySelector('.menu-item[data-menu="claims"]').hidden = !dlgOn;
  $('tabbtn-claims').hidden = !dlgOn;
  $('me').textContent = S.me.name;
  $('logout-btn').hidden = false;
  $('top-aux-btn').hidden = false;
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  const ps = (await api('GET', '/api/participants')).participants;
  S.participants = new Map(ps.map((p) => [p.id, p]));
  S.tab = ['runs', 'sessions', 'people', ...(dlgOn ? ['claims'] : [])].includes(store('bs.aux-tab')) ? store('bs.aux-tab') : 'runs';
  setAux(!auxOverlays() && store('bs.aux-open') === '1', S.tab);
  await loadThreads();
  queueLive();
  loadAgents();
  connectWs();
  // 주소로 글 미리 채우기(Orbit LAUNCH · 마스터 #252~#266): ?thread=…&to=a,b&compose=… — 채우기만 하고 보내지는 않는다
  const pre = new URLSearchParams(location.search);
  if (pre.get('thread') && !location.hash && threadById(pre.get('thread'))) history.replaceState(null, '', `${location.pathname}${location.search}#${pre.get('thread')}`);
  await route();
  applyPrefill(pre);
}
function applyPrefill(q) {
  const text = q.get('compose');
  if (text == null) return;
  history.replaceState(null, '', location.pathname + location.hash);
  const to = (q.get('to') || '').split(',').filter(Boolean);
  // ?new=제목 — 열린 대화(보통 메인 채팅방)에서 새 주제 만들기 창을 제목을 채워 연다. 만들면 새 스레드 글쓰기 칸을 채운다(#287·#291)
  const title = q.get('new');
  if (title != null && S.mode === 'convo' && S.detail) {
    S.pendingCompose = { text, to };
    openFork();
    $('fork-title').value = title.slice(0, 200);
    syncForkNext();
    return;
  }
  fillCompose(text, to);
}
function fillCompose(text, to) {
  const body = $('body');
  if (!body || S.mode !== 'convo') return;
  body.value = text.slice(0, 32000);
  body.dispatchEvent(new Event('input', { bubbles: true }));
  S.prefillTo = to.length ? { thread: S.cur, to } : null;
  applyPrefillTo();
  syncChips();
  body.focus();
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
initRuns();
initAdmin();
// ───── 화면 언어 고르기(마스터 #821·#823) — 메뉴 맨 아래(로그아웃 위). 고르면 이 기기에 저장 · 마스터면 서버 언어도(에이전트 규약이 따른다) · 다시 읽는다 ─────
function mountLangSelect() {
  const menu = $('menu');
  if (!menu || $('lang-select') || !(I18N.langs?.length > 1)) return;
  const sel = el('select', { id: 'lang-select', 'aria-label': t('app.language'), title: t('app.language') }, ...I18N.langs.map((l) => el('option', { value: l.code, selected: l.code === I18N.lang }, l.name)));
  sel.addEventListener('change', async () => {
    const code = sel.value;
    I18N.save(code);
    if (S.me?.is_master) await api('PUT', '/api/settings/lang', { lang: code }).catch(() => {});
    location.reload();
  });
  const box = el('label', { class: 'menu-lang' }, el('span', { class: 'mi-label' }, t('app.language')), sel);
  menu.insertBefore(box, menu.querySelector('.menu-logout'));
}
mountLangSelect();
boot();

// ───── 좁은 화면(디자인 #782 · ≤760): ⋯ 시트 · 길게 눌러 글 동작 · 상단 점 · 짧은 자리표시 ─────
// 머리 동작은 원래 버튼을 그대로 두고(넓은 화면·키보드 단축키가 쓴다) 시트가 그 버튼을 대신 누른다 — 숨김·이름은 열 때마다 원래 버튼에서 읽는다
const SHEET_IDS = ['t-face', 't-merge', 't-md', 't-copy', 't-audit', 'fork-btn', 'aux-btn'];
const SHEET_TIDY = ['st-rename', 'st-archive', 'st-unarchive', 'st-hide', 'st-unhide', 'st-trash', 'st-restore', 'st-purge'];
function setSheet(open) {
  const sh = $('t-sheet');
  if (open) {
    const item = (id) => {
      const o = $(id);
      if (!o || o.hidden || o.disabled) return null;
      const b = el('button', { type: 'button', role: 'menuitem', class: o.classList.contains('danger') ? 'danger' : '' }, o.textContent.trim());
      b.addEventListener('click', () => {
        setSheet(false);
        o.click();
      });
      return b;
    };
    const main = SHEET_IDS.map(item).filter(Boolean);
    const tidy = $('t-menu').hidden ? [] : SHEET_TIDY.map(item).filter(Boolean); // 채팅방엔 «정리» 없음
    sh.replaceChildren(...main, ...(tidy.length ? [el('div', { class: 'sheet-sec', 'aria-hidden': 'true' }, t('app.tidy')), ...tidy] : []));
  }
  sh.hidden = !open;
  $('t-more-btn').setAttribute('aria-expanded', String(open));
  if (open) sh.querySelector('button')?.focus();
}
$('t-more-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  setSheet($('t-sheet').hidden);
});
document.addEventListener('click', (e) => {
  if (!$('t-sheet').hidden && !e.target.closest('#t-sheet')) setSheet(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('t-sheet').hidden) {
    setSheet(false);
    $('t-more-btn').focus();
  }
});

// 글 동작(답장·복사·분기 …): 좁은 화면에선 숨겨 두고 글을 길게 누르면 그 글에만 보인다 — 다른 곳을 누르면 걷힌다
{
  let timer = 0;
  let start = null;
  const clear = () => {
    clearTimeout(timer);
    timer = 0;
  };
  $('messages').addEventListener('pointerdown', (e) => {
    if (!isNarrow() || e.pointerType === 'mouse' || e.target.closest('button, a, input, textarea, select, summary')) return;
    const m = e.target.closest('.msg');
    if (!m) return;
    start = [e.clientX, e.clientY];
    clear();
    timer = setTimeout(() => {
      timer = 0;
      for (const x of document.querySelectorAll('.msg.show-actions')) if (x !== m) x.classList.remove('show-actions');
      m.classList.add('show-actions');
      navigator.vibrate?.(10);
    }, 480);
  });
  $('messages').addEventListener('pointermove', (e) => {
    if (timer && start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 10) clear();
  });
  for (const t of ['pointerup', 'pointercancel']) $('messages').addEventListener(t, clear);
  document.addEventListener('click', (e) => {
    if (e.target.closest('.msg.show-actions')) return;
    for (const x of document.querySelectorAll('.msg.show-actions')) x.classList.remove('show-actions');
  });
}

// 상단 보조 패널 아이콘의 금색 점 = 응답 대기 띠가 떠 있을 때
new MutationObserver(() => {
  $('top-aux-dot').hidden = $('wait-banner').hidden;
}).observe($('wait-banner'), { attributes: true, attributeFilter: ['hidden'] });

// 작성란 자리표시: 좁은 화면은 한 줄 칸이라 짧게
{
  const long = $('body').placeholder;
  const mq = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : { matches: false, addEventListener() {} };
  const apply = () => {
    $('body').placeholder = mq.matches ? t('app.msg_input') : long;
    if (!mq.matches) setSheet(false);
  };
  mq.addEventListener('change', apply);
  apply();
}

// ───── 대화 목록의 «실행 중» 점(디자인 #782): 대기·실행 중인 실행이 있는 대화에 에이전트 이름 ─────
// 실행 목록 API(마스터 전용) 를 «지금부터»로 물어 진행 중인 것만 받는다 · 실행 알림마다 0.3초 모아 한 번 · 못 읽으면(마스터 아님 등) 점 없이 둔다
let liveTimer = 0;
let liveSig = '';
function queueLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => loadLive().catch(() => {}), 300);
}
async function loadLive() {
  if (!S.me || $('app-view').hidden) return;
  const r = await api('GET', `/api/runs?since=${Date.now() + 3600000}&limit=100`);
  const m = new Map();
  for (const x of r.runs ?? []) {
    if (x.state !== 'queued' && x.state !== 'running') continue;
    const names = m.get(x.thread_id) ?? [];
    const n = pname(x.agent_id);
    if (!names.includes(n)) names.push(n);
    m.set(x.thread_id, names);
  }
  const sig = JSON.stringify([...m].sort());
  if (sig === liveSig) return;
  liveSig = sig;
  S.live = m;
  renderList();
}

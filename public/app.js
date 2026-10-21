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
const fmtTime = (t) => (t ? new Date(t).toLocaleString('ko-KR', { hour12: false }) : '');
const fmtHm = (t) => (t ? new Date(t).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '');
function rel(t) {
  if (!t) return '';
  const d = Date.now() - t;
  if (d < 60_000) return '방금';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}분 전`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}시간 전`;
  if (d < 2 * 86_400_000) return '어제';
  return new Date(t).toLocaleDateString('ko-KR');
}
function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
const pname = (id) => S.participants.get(id)?.name ?? id;
const initials = (id) => {
  const n = pname(id).trim();
  return /^[A-Za-z0-9]/.test(n) ? n.slice(0, 2).toUpperCase() : n.slice(0, 1);
};
const isAgent = (id) => S.participants.get(id)?.kind === 'agent';
const KIND = { instruction: '지시', quote: '인용', observation: '관찰', proposal: '제안', request: '요청' };
// 공통 상태 라벨 — 화면마다 같은 뜻으로 쓴다(정책 3)
const STATE = { queued: '대기 중', running: '실행 중', succeeded: '완료', failed: '실행 실패', cancelled: '취소됨', unknown: '상태 미확인' };
const RUN_ERR = {
  cancelled_by_master: '마스터가 취소함',
  stop_new: '«새 호출 금지»로 거둠',
  generation_rotated: '세션 교체로 취소됨',
  lease_expired: '어댑터 응답이 끊김',
  cancel_ack_timeout: '어댑터가 중단을 확인하지 않음(무응답 제한)',
};
// 취소 처리 결과(서버 판정 run.cancel_outcome) — 정책 1 «화면 안내»의 구분
const OUTCOME = {
  queued_cancelled: '대기 중 취소',
  requested: '중단 요청됨',
  acked: '중단 완료',
  no_ack: '실행 상태 미확인',
  completed_first: '완료 우선 확정',
  failed_first: '실패 우선 확정',
  withdrawn: '새 호출 금지로 거둠',
  rotated: '세션 교체로 취소',
  legacy: '즉시 취소(이전 방식)',
};
/** «중단 요청됨»은 상태가 아니라 running + 요청 기록 — 화면에서는 따로 보인다 */
const runStateKey = (r) => (r.state === 'running' && r.cancel_requested_at ? 'requested' : r.state);
const stateLabel = (r) => (runStateKey(r) === 'requested' ? '중단 요청됨' : STATE[r.state] ?? r.state);
const SEND_ERR = {
  thread_closed: '이 대화는 닫혀 있습니다',
  no_thread: '이 대화를 열 수 없습니다(권한이 없거나 없어진 대화)',
  no_post_permission: '이 대화에 쓸 권한이 없습니다',
  bad_recipient: '수신자가 이 대화의 멤버 에이전트가 아닙니다',
  call_budget_exceeded: '수신자 수가 호출 예산보다 많습니다(⋯에서 예산을 올리세요)',
  bad_call_budget: '호출 예산은 0~10 입니다',
  client_key_reused: '같은 요청 식별자가 다른 내용에 쓰였습니다',
  too_large: '본문이 너무 깁니다',
  bad_request: '요청이 올바르지 않습니다',
  bad_attachment: '첨부를 찾을 수 없습니다(오래돼 걷혔을 수 있음) — 고쳐 쓰기로 다시 붙이세요',
  too_many_attachments: '첨부는 한 메시지에 5개까지입니다',
};
const ATT_MAX = 5;
const ATT_MAX_BYTES = 20 * 1024 * 1024;
const ATT_ICON = { image: '🖼', pdf: '📕', text: '📄', file: '📦' };
function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const kindLabel = (t) => (t?.kind === 'room' ? '채팅방' : '스레드');
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
  const opts = { method, headers: {}, credentials: 'same-origin' };
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
    throw Object.assign(new Error('로그인 필요'), { status: 401 });
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
  return ask({ title, text, ok: '확인' });
}

// ───── 로그인 ─────
function showLogin() {
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  $('logout-btn').hidden = true;
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
    $('login-err').textContent = err.status === 429 ? '시도가 너무 많습니다. 잠시 뒤에 다시 하세요.' : '패스프레이즈가 맞지 않습니다.';
  }
});
$('logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => {});
  showLogin();
});

// ───── 좁은 화면: 서랍·시트는 동시에 하나만 ─────
const isNarrow = () => (typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)').matches : false);
/** 보조 패널이 대화 위를 덮는 폭(작성란 전송 버튼이 가려질 수 있음) */
const auxOverlays = () => (typeof matchMedia === 'function' ? matchMedia('(max-width: 999px)').matches : false);
function setDrawer(open) {
  document.body.classList.toggle('show-sidebar', open);
  $('menu-btn').setAttribute('aria-expanded', String(open));
  if (open && isNarrow()) setAux(false);
  syncBackdrop();
}
function syncBackdrop() {
  $('backdrop').hidden = !(isNarrow() && document.body.classList.contains('show-sidebar'));
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
function syncMenu() {
  // 실행 화면이면 «실행 상태». 대화 작업 중에는 보조 패널의 세션·참여자 탭을 따른다(실행 탭은 대화 작업의 일부)
  const active = S.mode !== 'convo' ? S.mode : S.auxOpen && S.tab !== 'runs' ? S.tab : 'convo';
  for (const b of document.querySelectorAll('.menu-item')) {
    const on = b.dataset.menu === active;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
    // 좁은 폭에서 메뉴는 가로 띠(넘치면 옆으로 밀림) — 지금 화면의 메뉴가 보이게
    if (on && typeof matchMedia === 'function' && matchMedia('(max-width: 1279px)').matches && b.scrollIntoView) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
  $('aux-btn').textContent = open ? '보조 패널 닫기' : '보조 패널 열기';
  $('aux-btn').setAttribute('aria-expanded', String(open));
  if (open && isNarrow()) setDrawer(false);
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
const STATE_LABEL = { room: '활성', open: '열림', archived: '보관', hidden: '숨김', trash: '휴지통' };
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
const newBadge = (inner) => el('span', { class: `new-badge${inner ? ' inner' : ''}`, title: inner ? '접힌 분기에 보낸 뒤 안 본 답이 있음' : '보낸 뒤 안 본 답이 있음', 'aria-label': '새 답' }, 'N');
function convItem(t, depth, tree) {
  const active = t.id === S.cur;
  const paused = t.invoke_paused ? '⏸ 새 호출 금지 · ' : '';
  let l2;
  if (t.kind === 'room') {
    const n = S.roomDetail?.members.filter((m) => m.kind === 'agent').length ?? 0;
    l2 = `${paused}에이전트 ${n}개 · ${rel(t.updated_at)}`;
  } else {
    const parent = t.parent_thread_id ? threadById(t.parent_thread_id) : null;
    const from = parent ? `${parent.kind === 'room' ? '메인 채팅방' : parent.title} #${t.fork_seq}에서` : '독립 스레드';
    l2 = `${paused}${from} · ${rel(t.updated_at)}`;
  }
  const st = stateOf(t);
  const n = tree?.kids ?? 0;
  const a = el(
    'a',
    { href: `#${t.id}`, class: `conv-item${active ? ' active' : ''}${st !== 'open' && st !== 'room' ? ' dimmed' : ''}`, 'aria-current': active ? 'true' : null, 'data-id': t.id },
    el(
      'div',
      { class: 'l1' },
      el('span', { class: 'ttl' }, t.title),
      hasNew(t) ? newBadge(false) : tree?.kidsNew ? newBadge(true) : null,
      tree?.collapsed && n ? el('span', { class: 'kids', title: `접힌 분기 ${n}개` }, `+${n}`) : null,
      el('span', { class: `pill st-${st}` }, STATE_LABEL[st]),
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
          'aria-label': `${t.title} 분기 ${n}개 ${tree.collapsed ? '펼치기' : '접기'}`,
          onclick: () => toggleCollapsed(t.id),
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
  rl.replaceChildren(...(r && (!q || r.title.toLowerCase().includes(q)) ? [convItem(r, 0)] : [el('div', { class: 'empty-list' }, r ? '검색 결과 없음' : '채팅방이 아직 없습니다')]));
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
  const empty = q ? '검색 결과 없음' : filter === 'open' ? '스레드가 없습니다 — 메시지에서 «스레드 생성»' : `${$('thread-filter').selectedOptions[0]?.textContent ?? ''} 스레드가 없습니다`;
  nav.replaceChildren(...(items.length ? items : [el('div', { class: 'empty-list' }, empty)]));
  const tb = $('tree-toggle-all');
  tb.hidden = !!q || parents === 0;
  const anyOpen = threads.some((t) => !collapsedSet().has(t.id) && threads.some((c) => c.parent_thread_id === t.id));
  tb.textContent = anyOpen ? '모두 접기' : '모두 펼치기';
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
      $('empty').textContent = '메인 채팅방이 아직 없습니다(마스터 등록 전).';
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
    const t = S.detail.thread;
    announce(`${kindLabel(t)} ${t.title} 열림. 작성 대상: ${pathOf(t)}`);
    renderList();
  } catch (err) {
    if (id !== S.cur) return;
    S.detail = null;
    $('messages').replaceChildren(
      el(
        'div',
        { class: 'empty-thread' },
        el('p', {}, el('b', {}, '이 대화를 열 수 없습니다.')),
        el('p', { class: 'muted small' }, err.status === 404 ? '권한이 없거나 없어진 대화입니다. 이 대화에는 메시지를 보낼 수 없습니다.' : `오류: ${err.message}`),
        room() && room().id !== id ? el('button', { type: 'button', class: 'primary', onclick: () => (location.hash = room().id) }, '메인 채팅방으로') : null,
      ),
    );
    $('c-target').textContent = '(열 수 없는 대화)';
    syncSendable();
    announce('이 대화를 열 수 없습니다');
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
  const t = d.thread;
  $('t-kind').textContent = kindLabel(t);
  $('t-kind').className = `pill ${t.kind === 'room' ? 'room' : ''}`;
  $('t-title').textContent = t.title;
  renderStateMenu(t);
  $('t-audit').href = `#audit?thread=${encodeURIComponent(t.id)}&since=`;
  $('people-perm').href = `#members?thread=${encodeURIComponent(t.id)}`;
  const parent = t.parent_thread_id ? threadById(t.parent_thread_id) : null;
  if (t.kind === 'room') $('t-path').textContent = '모든 에이전트가 참여하는 단체 채팅방입니다. 주제별 대화는 «스레드 생성»으로 갈라 냅니다.';
  else if (parent) {
    const fp = [...S.context, ...S.messages].find((m) => m.seq === t.fork_seq);
    $('t-path').textContent = `${parent.kind === 'room' ? '메인 채팅' : parent.title} #${t.fork_seq}에서 분기${fp ? ` · 분기 시점 ${fmtTime(fp.created_at)} · ${pname(fp.author_id)}` : ''}`;
  } else $('t-path').textContent = '부모 없는 스레드(메인 채팅방 도입 전에 만든 대화)';
  // 합치기(#706): 하위 스레드면 머리에 «⤴ 상위로 합치기 (안 합친 글 N)» · 지난 합침은 경로 줄 끝에
  const mb = $('t-merge');
  mb.hidden = !(S.me?.is_master && parent && t.kind !== 'room');
  if (!mb.hidden) {
    const n = d.unmerged ?? 0;
    mb.textContent = n ? `⤴ 상위로 합치기 (${n})` : '⤴ 상위로 합치기';
    mb.disabled = !n;
    mb.title = n ? `이 스레드의 글 ${n}개를 «${parent.kind === 'room' ? '메인 채팅방' : parent.title}»에 묶음으로 옮겨 거기서 이어 간다` : '지난 합침 뒤 새 글이 없습니다';
    const ms = d.merges ?? [];
    if (ms.length) $('t-path').textContent += ` · 상위로 합침 ${ms.length}번(마지막 #${ms[ms.length - 1].to_seq}까지)`;
  }
  renderSummary();
}
$('t-merge').addEventListener('click', async () => {
  const d = S.detail;
  const parent = d?.thread.parent_thread_id ? threadById(d.thread.parent_thread_id) : null;
  if (!parent || !d.unmerged) return;
  const where = parent.kind === 'room' ? '메인 채팅방' : `«${parent.title}»`;
  const again = (d.merges ?? []).length ? ' 지난 합침 뒤의 글만 옮깁니다.' : '';
  if (!(await ask({ title: '상위로 합치기', text: `이 스레드의 글 ${d.unmerged}개를 ${where}에 묶음 글 하나로 옮깁니다.${again} 거기서 이어서 이야기하면 에이전트도 그 묶음을 읽습니다. 이 스레드는 그대로 남습니다.`, ok: '합치기' }))) return;
  try {
    const r = await api('POST', `/api/threads/${d.thread.id}/merge`);
    announce(`합침 완료: ${r.parent.title}`);
    location.hash = r.parent.id;
  } catch (e) {
    notify('합치기 실패', e.message);
  }
});
function renderSummary() {
  const d = S.detail;
  if (!d) return;
  const agents = d.members.filter((m) => m.kind === 'agent');
  const active = S.runs.filter((r) => r.state === 'queued' || r.state === 'running').length;
  const waiting = S.deliveries.filter((x) => (x.status === 'pending' || x.status === 'leased') && !S.runs.some((r) => r.trigger_seq === x.message_seq && r.agent_id === x.recipient_id)).length;
  const unknown = S.runs.filter((r) => r.state === 'unknown').length;
  const gens = d.sessions.filter((s) => s.status === 'active').map((s) => `${pname(s.agent_id)} ${s.generation}세대${s.metrics?.ctx_tokens ? ` · ${ctxK(s.metrics.ctx_tokens)}` : ''}`);
  const t = d.thread;
  $('t-summary').replaceChildren(
    el('span', {}, '전송 대상 ', el('b', {}, agents.length ? agents.map((a) => a.name).join(', ') : '에이전트 없음')),
    el('span', {}, '현재 대화 ', el('b', {}, pathOf(t))),
    el('span', {}, '실행 ', el('b', {}, `진행 ${active + waiting}`), unknown ? el('span', { class: 'alertish' }, ` · 미확인 ${unknown}`) : null),
    el('span', {}, '세대 ', el('b', {}, gens.length ? gens.join(', ') : '아직 없음')),
    ...(t.invoke_paused ? [el('span', { class: 'alertish' }, '⏸ 새 호출 금지 중')] : []),
  );
  // 머리에는 손이 필요한 경고만 남긴다(새 호출 금지 · 미확인 실행 · 보류된 요청) — 나머지 정보는 보조 패널(#325)
  const held = openHolds().length;
  const alerts = [
    ...(t.invoke_paused ? [el('span', { class: 'alertish' }, '⏸ 새 호출 금지 중')] : []),
    ...(unknown ? [el('span', { class: 'alertish' }, `미확인 실행 ${unknown} — 보조 패널 «실행»`)] : []),
    ...(held
      ? [el('button', { type: 'button', class: 'alertish linkish', id: 't-holds', title: '에이전트가 보류했거나 연쇄 상한에 걸린 요청 — 사유를 보고 «확인함»', onclick: () => setAux(true, 'runs') }, `보류된 요청 ${held} — 보조 패널 «실행»`)]
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
    const c = el('label', { class: `chip${checked ? ' on' : ''}`, title: key ? `단축키 ${key}` : null }, input, label);
    input.addEventListener('change', () => onChip(input));
    return c;
  };
  box.replaceChildren(
    el('span', { class: 'lbl' }, '수신 대상'),
    ...(agents.length
      ? [
          // «메모» = 명시적으로 아무에게도 안 보냄(마스터 #271) — 에이전트를 고르면 꺼지고, 메모를 켜면 에이전트가 다 꺼진다
          chip('*memo', '메모', false, { 'data-memo': '1', title: '아무 에이전트도 부르지 않고 메시지만 남깁니다' }),
          chip('*all', '전체', agents.length > 0 && agents.every((a) => a.participant_id === def), { 'data-all': '1', title: '이 대화의 멤버 에이전트 전부(이름을 골라야만 부르는 에이전트는 빼고)', key: 'Alt+0' }),
          ...agents.map((a, i) => chip(a.participant_id, a.name, a.participant_id === def, { 'data-agent': '1', ...(i < 9 ? { key: `Alt+${i + 1}` } : {}), ...(S.onCallOnly?.has(a.participant_id) ? { 'data-oncall': '1' } : {}) })),
        ]
      : [el('span', { class: 'small faint' }, '멤버 에이전트가 없습니다 — 메시지만 저장됩니다')]),
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
    note.textContent = n ? `→ ${n}명 호출` : memoChosen() || !hasAgents ? '아무도 부르지 않음(메시지만 저장)' : '받는 쪽을 고르세요 — 에이전트 또는 «메모»';
  }
  syncMore();
}
function syncMore() {
  const sk = $('source-kind');
  const parts = [`출처 ${sk.options[sk.selectedIndex].text}`];
  if (selectedRecipients().length) parts.push(`예산 ${$('budget').value}`);
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
      skipped.push(`${f.name}(${ATT_MAX}개 초과)`);
      continue;
    }
    if (f.size === 0) skipped.push(`${f.name}(빈 파일)`);
    else if (f.size > ATT_MAX_BYTES) skipped.push(`${f.name}(${fmtSize(f.size)} — 20MB 초과)`);
    else S.attach.push({ file: f, url: /^image\/(png|jpeg|gif|webp)$/.test(f.type) && URL.createObjectURL ? URL.createObjectURL(f) : null });
  }
  if (skipped.length) notify('첨부 안 함', skipped.join(', '));
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
        el('button', { type: 'button', class: 'att-x', 'aria-label': `${x.file.name} 빼기`, onclick: () => removeAttach(x) }, '✕'),
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
  addFiles(files.map((f) => (f.name === 'image.png' ? new File([f], `붙여넣기-${stamp()}.png`, { type: f.type }) : f)));
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
    el('span', { class: `badge${m.source_kind === 'request' ? ' req' : ''}`, title: m.source_kind === 'request' ? '출처 — 에이전트 간 요청(지시 아님 · 허용 짝) · 요청은 실행 권한을 주지 않는다 — 실행 여부는 받은 쪽이 마스터의 방향 안에서 정한다' : '출처' }, KIND[m.source_kind] ?? m.source_kind),
    m.input_mode === 'voice' ? el('span', { class: 'badge' }, '음성') : null,
    el('span', {}, `#${m.seq}`),
    el('time', { datetime: new Date(m.created_at).toISOString(), title: fmtTime(m.created_at) }, fmtHm(m.created_at)),
    m.recipients.length
      ? el('span', { class: m.source_kind === 'request' ? 'req-route' : null }, m.source_kind === 'request' ? `${pname(m.author_id)} → ${m.recipients.map(pname).join(', ')}` : `→ ${m.recipients.map(pname).join(', ')}`)
      : null,
    m.reply_to_seq ? el('a', { href: `#m${m.reply_to_seq}`, onclick: (e) => (e.preventDefault(), jumpTo(m.reply_to_seq)) }, `↩ #${m.reply_to_seq}`) : null,
    mine && !inherited && S.sentKeys.has(m.client_key) ? el('span', { class: 'sendst ok' }, '✓ 전송 완료') : null,
  );
  // 답장·복사·분기는 머리가 아니라 글 아래 한 줄에 «전달…» 과 나란히(마스터 #327) — 전달 칸(.fwdslot)은 renderRunLines 가 채운다
  const bar = el(
    'div',
    { class: 'msgbar' },
    inherited ? null : el('span', { class: 'fwdslot' }),
    el(
      'span',
      { class: 'actions' },
      inherited ? null : el('button', { type: 'button', onclick: () => setReply(m) }, '답장'),
      el('button', { type: 'button', title: '이 메시지 본문 복사', onclick: () => copyMessage(m) }, '복사'),
      el('button', { type: 'button', onclick: () => openFork(m.seq) }, '여기서 분기'),
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
            el('a', { class: 'att-file', href: `/api/attachments/${encodeURIComponent(a.id)}`, title: '내려받기' }, `${ATT_ICON[a.kind] ?? '📦'} ${a.name}`, el('span', { class: 'faint' }, ` ${fmtSize(a.size)}`)),
          ),
        )
      : null,
  ];
  return el(
    'article',
    { class: `msg${agent ? ' agent' : ''}${mine ? ' mine' : ''}${inherited ? ' inherited' : ''}`, id: inherited ? `c${m.seq}` : `m${m.seq}`, 'aria-label': `${pname(m.author_id)} #${m.seq}` },
    el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(m.author_id)),
    el('div', { class: 'main' }, head, body, ...atts, inherited ? null : el('div', { class: 'runlines', 'data-seq': String(m.seq) }), bar),
  );
}
// ───── 합침 묶음(#706): 하위 스레드에서 옮긴 글을 한 상자로 · 펼치면 그 글들을 하위 스레드에서 읽어 온다 ─────
function mergeBox(m) {
  const g = m.merge;
  const list = el('div', { class: 'merge-list', hidden: true });
  const tog = el('button', { type: 'button', class: 'small', 'aria-expanded': 'false' }, '펼치기');
  let loaded = false;
  tog.onclick = async () => {
    const open = list.hidden;
    list.hidden = !open;
    tog.textContent = open ? '접기' : '펼치기';
    tog.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open || loaded) return;
    loaded = true;
    list.replaceChildren(el('div', { class: 'faint' }, '불러오는 중…'));
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
      list.replaceChildren(el('div', { class: 'faint' }, `하위 스레드를 읽지 못했습니다 — ${e.message}`));
    }
  };
  const known = threadById(g.child_thread_id);
  return el(
    'div',
    { class: 'merge-box' },
    el(
      'div',
      { class: 'merge-h' },
      el('span', {}, `⤴ 하위 스레드 «${g.child_title}»에서 합침 · 글 ${g.count}개 · #${g.from_seq}~#${g.to_seq}`),
      tog,
      known ? el('a', { class: 'small', href: `#${g.child_thread_id}` }, '스레드 열기') : null,
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
  ok ? announce(`#${m.seq} 복사됨`) : notify('복사 실패', '브라우저가 클립보드 쓰기를 막았습니다.');
}
/** 한 메시지 → 마크다운 덩어리(작성자 · 시각 · 번호 · 본문 · 첨부) */
function messageMd(m) {
  const p = S.participants.get(m.author_id);
  const who = p?.is_master ? `${pname(m.author_id)}(마스터)` : pname(m.author_id);
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
  const head = `# ${th.title} (${kindLabel(th)}) — ${all.length}개 메시지 · ${fmtTime(Date.now())} 복사`;
  const ok = await copyText([head, ...all.map(messageMd)].join('\n\n---\n\n'));
  ok ? announce(`대화 복사됨: 메시지 ${all.length}개`) : notify('복사 실패', '브라우저가 클립보드 쓰기를 막았습니다.');
  const b = $('t-copy');
  if (ok && b) {
    b.textContent = `✓ ${all.length}개 복사됨`;
    setTimeout(() => (b.textContent = '대화 복사'), 2000);
  }
}
$('t-copy').addEventListener('click', () => copyThread().catch((e) => notify('복사 실패', e.message)));

// ───── 마크다운 ↔ 원문 (대화 단위 · 마스터 #477) ─────
function syncMdToggle() {
  const plain = isPlain(S.cur);
  const b = $('t-md');
  b.textContent = plain ? '마크다운 보기' : '원문 보기';
  b.setAttribute('aria-pressed', plain ? 'true' : 'false');
  b.title = plain ? '이 대화의 글을 마크다운으로 렌더링해 보기' : '이 대화의 글을 마크다운 기호 그대로(원문) 보기';
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
  announce(plain ? '원문 보기' : '마크다운 보기');
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
        ? `⚠ 답장만으로는 ${pname(a)}에게 전달되지 않습니다 — 수신 대상에서 고르세요 `
        : `⚠ 답장만으로는 전달되지 않습니다 — ${pname(a)}는 이 대화의 수신 대상이 아닙니다 `,
    );
  }
  info.hidden = false;
  // 빈 값(null)은 넣지 않는다 — replaceChildren 은 null 을 «null» 글자로 그린다(마스터 #325)
  info.replaceChildren(...[`↩ #${S.replyTo} 에 답장 `, el('button', { type: 'button', class: 'link', onclick: clearReply }, '취소'), warn ? el('br') : null, warn].filter((x) => x != null));
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
  return el('span', { class: 'progress', title: r.progress }, ` · 최근: ${r.progress} (`, el('span', { 'data-since': String(r.progress_at) }, dur(Date.now() - r.progress_at)), ' 전)');
}
function runLineEl(r) {
  const since = r.started_at ?? r.created_at;
  const err = r.error ? RUN_ERR[r.error] ?? r.error : '';
  const narrow = isNarrow();
  const look = el('a', { href: runHref(r), class: 'look' }, narrow ? '상태 보기' : '상세');
  if (r.state === 'running' && r.cancel_requested_at)
    return el(
      'div',
      { class: 'runline cancel' },
      el('span', { class: 'badge st-requested' }, '중단 요청됨'),
      el('span', {}, `${pname(r.agent_id)} — 어댑터 중단 확인 대기 · 남은 `, el('span', { 'data-until': String(r.cancel_deadline_at) }, `${Math.max(0, Math.ceil((r.cancel_deadline_at - Date.now()) / 1000))}초`)),
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
        `${pname(r.agent_id)} ${readAck(r) ? '✓ 읽음 · 작업 중' : r.state === 'running' ? '응답 생성 중…' : '시작 대기'} · 경과 `,
        el('span', { 'data-since': String(since) }, dur(Date.now() - since)),
        progressEl(r),
      ),
      // 좁은 화면은 한 줄 요약 + 상태 보기. 중단은 상세 화면에서만(기획서 3.1 표시)
      narrow ? null : el('button', { type: 'button', class: 'danger', onclick: () => cancelRunAsk(r) }, '실행 취소'),
      look,
    );
  if (r.state === 'failed')
    return el(
      'div',
      { class: 'runline bad' },
      el('span', { class: 'badge st-failed' }, STATE.failed),
      `${pname(r.agent_id)} — ${err || '실패'}${r.cancel_outcome === 'failed_first' ? ' · 취소 요청 중에 먼저 실패' : ''} · 자동 재실행하지 않습니다(다시 부르려면 새 메시지로)`,
      look,
    );
  if (r.state === 'unknown')
    return el(
      'div',
      { class: 'runline bad' },
      el('span', { class: 'badge st-unknown' }, STATE.unknown),
      `${pname(r.agent_id)} — ${r.error === 'cancel_ack_timeout' ? `어댑터가 ${Math.round(S.cancelAckMs / 1000)}초 안에 중단을 확인하지 않았습니다` : `실행 결과를 확인하지 못했습니다${err ? `(${err})` : ''}`}. 자동 재실행되지 않았습니다 · 마지막 확인 ${fmtHm(r.last_checked_at ?? r.finalized_at ?? r.ended_at)}`,
      look,
    );
  if (r.state === 'cancelled')
    return el(
      'div',
      { class: 'runline cancel' },
      el('span', { class: 'badge st-cancelled' }, STATE.cancelled),
      `${pname(r.agent_id)}${r.cancel_outcome && OUTCOME[r.cancel_outcome] ? ` — ${OUTCOME[r.cancel_outcome]}` : err ? ` — ${err}` : ''}${r.cancel_outcome === 'acked' ? `(어댑터 확인 ${fmtHm(r.stop_ack_at)})` : ''}`,
      look,
    );
  // 완료는 메시지 행에 반복하지 않는다(정책 3) — 답 글이 곧 결과. 다만 취소 요청 중 완료는 알린다(완료 우선 확정)
  if (r.cancel_outcome === 'completed_first')
    return el('div', { class: 'runline cancel' }, el('span', { class: 'badge st-succeeded' }, '완료 우선 확정'), `${pname(r.agent_id)} — 취소 요청 중에 실행이 먼저 완료되었습니다(답은 그대로)`, look);
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
            el('span', { class: `badge st-${x.status}` }, '전달 대기'),
            `${pname(x.recipient_id)} — ${x.status === 'leased' ? '어댑터가 받는 중' : '아직 가져가지 않음'}`,
            fwdNoteEl(x),
            // 수동 전달의 되돌리기: 대기면 «전달 취소», 실행이 생겼으면 위 실행 줄의 «실행 취소»(중단)
            x.forwarded_by && S.me?.is_master ? el('button', { type: 'button', class: 'danger', onclick: () => cancelForward(x) }, '전달 취소') : null,
          ),
        );
      else if (x.status === 'dead') lines.push(el('div', { class: 'runline bad' }, el('span', { class: 'badge st-dead' }, '전달 실패'), `${pname(x.recipient_id)} — 시도 횟수 초과`));
      else if (x.status === 'cancelled') lines.push(el('div', { class: 'runline cancel' }, el('span', { class: 'badge st-cancelled' }, '전달 거둠'), `${pname(x.recipient_id)}${x.last_error ? ` — ${RUN_ERR[x.last_error] ?? x.last_error}` : ''}`));
    }
    for (const h of (S.detail?.request_holds ?? []).filter((x) => x.request_seq === seq))
      lines.push(
        el(
          'div',
          { class: `runline ${h.acked_at ? 'cancel' : 'bad'}` },
          el('span', { class: 'badge st-failed' }, h.kind === 'held' ? '요청 보류' : '요청 안 보냄'),
          h.kind === 'held' ? `${pname(h.recipient_id)} — ${h.reason}` : `연쇄 상한 — ${pname(h.recipient_id)}에게 가지 않았습니다(마스터 확인 필요)`,
          h.acked_at ? el('span', { class: 'muted small' }, ' · 확인함') : null,
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
  return el('span', { class: 'fwd-note-line small', title: x.forward_note }, ` · 메모: ${one.length > 80 ? one.slice(0, 80) + '…' : one}`);
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
    items.push(el('span', { class: 'small faint fwd-done' }, `→ ${pname(rid)}에게 전달됨`, r?.result_seq ? el('a', { href: `#m${r.result_seq}`, onclick: (e) => (e.preventDefault(), jumpTo(r.result_seq)) }, ` · 답 #${r.result_seq}`) : null, fwdNoteEl(x)));
  }
  const btn = (rid, label, signalled) =>
    el(
      'button',
      {
        type: 'button',
        class: signalled ? 'fwd primary-soft' : 'fwd',
        disabled: paused || closed,
        title: paused ? '새 호출 금지 중 — 풀어야 전달할 수 있습니다' : `#${seq}를 ${pname(rid)}에게 «이 글에 답하라»로 넘깁니다(새 메시지 없음)`,
        'data-fwd': `${seq}:${rid}`,
        onclick: () => doForward(m, rid),
      },
      label,
    );
  // 에이전트가 끝줄 «→ 이름»으로 고른 대상은 바로 버튼으로
  for (const rid of m.handoff_to ?? []) if (cands.includes(rid) && !sent.has(rid)) items.push(btn(rid, `${pname(rid)}에게 전달`, true));
  // 신호가 없어도 마스터는 아무 대상에게나 넘길 수 있다(신호는 편의 · 권한은 마스터)
  const rest = cands.filter((rid) => !sent.has(rid) && !(m.handoff_to ?? []).includes(rid));
  if (rest.length) {
    const menu = el('span', { class: 'fwd-menu', hidden: true }, ...rest.map((rid) => btn(rid, pname(rid), false)));
    items.push(
      el('button', { type: 'button', class: 'fwd ghost', disabled: paused || closed, 'aria-expanded': 'false', onclick: (e) => {
        menu.hidden = !menu.hidden;
        e.currentTarget.setAttribute('aria-expanded', String(!menu.hidden));
      } }, '전달…'),
      menu,
    );
  }
  if (!items.length) return null;
  if (paused && items.some((x) => x.tagName === 'BUTTON')) items.push(el('span', { class: 'small faint' }, '새 호출 금지 중'));
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
      el('span', { class: 'small' }, `📥 가져온 맥락 — «${d.pulled_title ?? d.pulled_from}» #${d.pulled_from_seq}~#${d.pulled_to_seq} · ${d.pulled_count}개 → ${pname(d.recipient_id)}`),
      el('span', { class: 'small faint' }, ` · ${fmtHm(d.created_at)}`),
      d.pulled_truncated ? el('span', { class: 'small', title: '받는 쪽 맥락 예산이 모자라 묶음 가운데를 잘라 실었습니다(머리 줄과 끝은 남김)' }, ' · ⚠ 가운데 잘림') : null,
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
        title: paused ? '새 호출 금지 중 — 풀어야 가져올 수 있습니다' : `${pname(m.author_id)}가 청한 다른 스레드의 맥락을 가져와 ${pname(m.author_id)}에게만 건넵니다(새 메시지 없음 · 한 번만 실림)`,
        onclick: () => doPull(m),
      },
      `${pullLabel(m.pull_req)} 맥락 가져오기`,
    ),
    paused ? el('span', { class: 'small faint' }, '새 호출 금지 중') : null,
  );
}
async function doPull(m) {
  const path = `/api/threads/${encodeURIComponent(S.cur)}/messages/${m.seq}/pull`;
  let pv;
  try {
    pv = await api('GET', path);
  } catch (e) {
    await notify('가져올 수 없습니다', e.message);
    return;
  }
  const size = `«${pv.source.title}» #${pv.from_seq}~#${pv.to_seq} · ${pv.count}개 · 약 ${pv.est_tokens.toLocaleString()}토큰`;
  if (pv.level === 'over') {
    await notify('받는 쪽 예산을 넘습니다', `${size} — ${pname(pv.recipient)}의 맥락 예산 ${pv.budget_tokens.toLocaleString()}토큰을 넘습니다. 에이전트에게 범위를 좁혀 달라고 하세요.`);
    return;
  }
  if (pv.level === 'warn' || pv.level === 'unknown') {
    const why =
      pv.level === 'warn'
        ? `${pname(pv.recipient)} 예산 ${pv.budget_tokens.toLocaleString()}토큰의 1/3을 넘습니다 — 그만큼 이 스레드의 옛 대화가 밀려날 수 있습니다.`
        : `${pname(pv.recipient)}의 맥락 예산을 서버가 모릅니다(예산을 신고하지 않는 어댑터).`;
    const go = await ask({ title: '맥락 가져오기', text: `${size}\n${why}\n가져올까요?`, ok: '가져오기' });
    if (!go) return;
  }
  try {
    await api('POST', path);
  } catch (e) {
    await notify('가져오지 못했습니다', e.code === 'invoke_paused' ? '이 대화는 «새 호출 금지» 중입니다. 풀고 다시 누르세요.' : e.message);
  }
  await loadRuns().catch(() => {});
}
// 전달 메모(마스터 #740) — 누르면 확인 창에 선택 입력 칸. 비우면 옛 전달 그대로 · 쓰면 받는 에이전트에게 «마스터 전달 메모 · 지시»로 실린다
const FORWARD_NOTE_MAX = 4000;
async function doForward(m, rid) {
  const note = el('textarea', { id: 'fwd-note', rows: 3, maxlength: FORWARD_NOTE_MAX, placeholder: '함께 전할 말(선택) — 비워 두면 글만 전달합니다', 'aria-label': '전달 메모(선택)' });
  note.addEventListener('keydown', (e) => {
    // 여러 줄 입력 — Enter 는 줄바꿈, Ctrl/⌘+Enter 로 전달
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), $('confirm-ok').click());
    e.stopPropagation();
  });
  const go = ask({ title: `${pname(rid)}에게 전달`, text: `#${m.seq}를 ${pname(rid)}에게 «이 글에 답하라»로 넘깁니다.`, ok: '전달', extra: el('label', { class: 'fwd-note' }, note) });
  note.focus();
  if (!(await go)) return;
  const body = note.value.trim() ? { recipient: rid, note: note.value.trim() } : { recipient: rid };
  try {
    await api('POST', `/api/threads/${encodeURIComponent(S.cur)}/messages/${m.seq}/forward`, body);
  } catch (e) {
    await notify('전달하지 못했습니다', e.code === 'invoke_paused' ? '이 대화는 «새 호출 금지» 중입니다. 풀고 다시 누르세요.' : e.message);
  }
  await loadRuns().catch(() => {});
}
async function cancelForward(x) {
  try {
    await api('POST', `/api/deliveries/${encodeURIComponent(x.id)}/cancel`);
  } catch (e) {
    // 그새 실행이 생겼다 — 실행 줄의 «실행 취소»(중단)로
    await notify('전달을 거두지 못했습니다', e.code === 'has_run' ? '이미 실행이 시작됐습니다. 실행 줄의 «실행 취소»로 중단하세요.' : e.message);
  }
  await loadRuns().catch(() => {});
}
function renderWait() {
  const parts = [];
  for (const r of S.runs.filter(activeRun)) {
    const since = r.started_at ?? r.created_at;
    if (r.cancel_requested_at)
      parts.push(el('span', {}, `${pname(r.agent_id)} 중단 확인 대기 — 남은 `, el('span', { 'data-until': String(r.cancel_deadline_at) }, `${Math.max(0, Math.ceil((r.cancel_deadline_at - Date.now()) / 1000))}초`)));
    else parts.push(el('span', {}, `${pname(r.agent_id)} ${readAck(r) ? '✓ 읽음 · 작업 중' : r.state === 'running' ? '응답 대기 중' : '시작 대기 중'} — `, el('span', { 'data-since': String(since) }, dur(Date.now() - since)), ' 경과'));
  }
  const w = waitingDeliveries();
  if (w.length) parts.push(el('span', {}, `전달 대기 ${w.length}건(${[...new Set(w.map((x) => pname(x.recipient_id)))].join(', ')})`));
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
      el('span', { class: 'faint' }, `${r.generation}세대`),
      el('span', { class: 'spacer' }),
      el('a', { href: runHref(r), class: 'look' }, isNarrow() ? '상태 보기' : '상세'),
    ),
    el('div', { class: 'muted' }, `원인 #${r.trigger_seq}${trig ? ` «${trig.body.slice(0, 40)}${trig.body.length > 40 ? '…' : ''}»` : ''}`),
    el(
      'div',
      { class: 'faint' },
      activeRun(r)
        ? ['시작 ', fmtHm(since), ' · 경과 ', el('span', { 'data-since': String(since) }, dur(Date.now() - since)), progressEl(r)]
        : [`${fmtHm(r.created_at)} → ${fmtHm(r.ended_at)}`, r.ended_at && r.started_at ? ` · 소요 ${dur(r.ended_at - r.started_at)}` : ''],
    ),
    r.cancel_outcome
      ? el(
          'div',
          { class: 'muted' },
          `중단 결과: ${OUTCOME[r.cancel_outcome] ?? r.cancel_outcome}`,
          r.cancel_outcome === 'requested' ? [' · 남은 ', el('span', { 'data-until': String(r.cancel_deadline_at) }, '')] : null,
        )
      : null,
    err && (r.state !== 'cancelled' || !r.cancel_outcome) ? el('div', { class: r.state === 'cancelled' ? 'muted' : 'err' }, err) : null,
    r.state === 'unknown' ? el('div', { class: 'muted' }, '자동 재실행되지 않았습니다 — 필요하면 새 메시지로 다시 부르세요') : null,
    activeRun(r) && !r.cancel_requested_at && !isNarrow() ? el('button', { type: 'button', class: 'danger', onclick: () => cancelRunAsk(r) }, '이 실행 취소') : null,
  );
}
// ───── 보류된 요청(마스터 #352) — 받은 에이전트가 «보류: 사유»로 남겼거나 연쇄 상한에 걸려 서버가 만들지 않은 요청 ─────
function openHolds() {
  return (S.detail?.request_holds ?? []).filter((h) => !h.acked_at);
}
const HOLD_KIND = { held: '보류', chain_limit: '연쇄 상한' };
function holdLi(h) {
  const reason = h.kind === 'chain_limit' ? `마스터 글 뒤 요청이 상한에 닿아 보내지 않았습니다 — 이어 가려면 이 글을 «전달»하거나 스레드에 글을 쓰세요` : h.reason;
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
    el('div', { class: 'hold-reason' }, `사유: ${reason}`),
    h.note ? el('div', { class: 'muted small hold-note' }, h.note.length > 300 ? `${h.note.slice(0, 300)}…` : h.note) : null,
    el('div', { class: 'muted small' }, `${fmtTime(h.created_at)}${h.acked_at ? ` · 확인 ${fmtTime(h.acked_at)}` : ''}`),
    h.acked_at ? null : el('button', { type: 'button', class: 'hold-ack', onclick: () => ackHold(h) }, '확인함'),
  );
}
async function ackHold(h) {
  try {
    await api('POST', `/api/request-holds/${encodeURIComponent(h.id)}/ack`);
    announce('보류된 요청을 확인했습니다');
    await loadDetail();
  } catch (e) {
    notify('확인 실패', e.message);
  }
}
function renderHolds() {
  const hs = S.detail?.request_holds ?? [];
  $('holds-count').textContent = hs.length ? `(확인 안 함 ${openHolds().length} · 최근 ${hs.length})` : '';
  $('holds').replaceChildren(...(hs.length ? hs.slice(0, 30).map(holdLi) : [el('li', { class: 'empty' }, '없음')]));
}
function renderRunsTab() {
  renderHolds();
  const t = S.detail?.thread;
  const active = S.runs.filter(activeRun).length;
  const unknown = S.runs.filter((r) => r.state === 'unknown').length;
  $('runs-count').textContent = `(진행 ${active} · 미확인 ${unknown} · 최근 ${S.runs.length})`;
  $('runs-all').href = t ? `#runs?thread=${encodeURIComponent(t.id)}&since=` : '#runs';
  $('btn-stop-new').hidden = !t || t.invoke_paused;
  $('btn-resume').hidden = !t || !t.invoke_paused;
  $('paused-note').hidden = !t?.invoke_paused;
  $('runs').replaceChildren(...(S.runs.length ? S.runs.slice(0, 50).map(runLi) : [el('li', { class: 'empty' }, '이 대화의 실행이 아직 없습니다')]));
  const w = waitingDeliveries();
  $('deliveries').replaceChildren(
    ...(w.length
      ? w.map((x) =>
          el(
            'li',
            {},
            el('div', { class: 'r1' }, el('span', { class: `badge st-${x.status}` }, x.status === 'leased' ? '받는 중' : '전달 대기'), el('b', {}, pname(x.recipient_id))),
            el('div', { class: 'muted' }, `메시지 #${x.message_seq} · 시도 ${x.attempts}`),
            el('button', { type: 'button', class: 'danger', onclick: () => cancelDeliveryAsk({ ...x, thread_id: S.cur }) }, '전달 취소'),
          ),
        )
      : [el('li', { class: 'empty' }, '없음')]),
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
function renderStateMenu(t) {
  const st = stateOf(t);
  $('t-menu').hidden = t.kind === 'room';
  $('t-menu').open = false;
  const trash = st === 'trash';
  $('st-rename').hidden = trash;
  $('st-archive').hidden = trash || t.status === 'archived';
  $('st-unarchive').hidden = trash || t.status !== 'archived';
  $('st-hide').hidden = trash || !!t.hidden;
  $('st-unhide').hidden = trash || !t.hidden;
  $('st-trash').hidden = trash;
  $('st-restore').hidden = !trash;
  $('st-purge').hidden = !trash;
  const note = $('t-state-note');
  const msg = trash
    ? `휴지통에 있는 대화입니다(${fmtTime(t.deleted_at)}) — 에이전트에게는 보이지 않고 새 글을 쓸 수 없습니다. «정리»에서 복구하거나 영구 삭제합니다.`
    : t.status === 'archived'
      ? '보관된 대화입니다 — 읽기 전용이라 새 글·에이전트 호출을 할 수 없습니다. «정리 → 보관 해제»로 되돌립니다.'
      : t.hidden
        ? '목록에서 숨긴 대화입니다 — 동작은 그대로입니다. 목록 필터 «숨김»에서 찾습니다.'
        : '';
  note.textContent = msg;
  note.hidden = !msg;
}
const STATE_ERR = {
  runs_active: '실행 중인 에이전트 작업이 있습니다 — 보조 패널의 «현재 실행 취소»나 완료를 기다린 뒤 다시 하세요.',
  room_locked: '메인 채팅방은 이름 바꾸기·보관·숨김·삭제를 할 수 없습니다.',
  thread_deleted: '휴지통에 있는 대화는 복구만 할 수 있습니다.',
  not_in_trash: '먼저 휴지통에 넣어야 영구 삭제할 수 있습니다.',
  descendants_not_in_trash: '아래 분기 중 휴지통 밖에 있는 스레드가 있습니다 — 그것까지 휴지통에 넣은 뒤 다시 하세요.',
  confirm_mismatch: '확인 칸의 제목이 맞지 않습니다.',
};
const STATE_ASK = {
  archive: { title: '보관', ok: '보관', text: '읽기 전용으로 바꿉니다. 새 글과 에이전트 호출을 막고, 아직 나가지 않은 전달은 거둡니다. 언제든 «보관 해제»로 되돌립니다.' },
  hide: { title: '목록에서 숨기기', ok: '숨기기', text: '목록에서만 빠집니다. 대화·에이전트 동작은 그대로이고 필터 «숨김»에서 다시 찾습니다.' },
  trash: { title: '휴지통으로', ok: '휴지통으로', danger: true, text: '에이전트에게서 사라지고 새 글을 쓸 수 없습니다. 아직 나가지 않은 전달은 거둡니다. 필터 «휴지통»에서 복구할 수 있습니다(자동으로 비우지 않습니다).' },
};
async function setStateAsk(action) {
  const t = S.detail?.thread;
  if (!t) return;
  $('t-menu').open = false;
  const d = descendants(t.id);
  const q = STATE_ASK[action];
  if (q) {
    const ok = await ask({ ...q, text: `«${t.title}»${d.length ? `와 아래 분기 ${d.length}개` : ''}: ${q.text}` });
    if (!ok) return;
  }
  try {
    await api('POST', `/api/threads/${t.id}/state`, { action });
  } catch (e) {
    return notify('실패', STATE_ERR[e.code] ?? e.message);
  }
  await Promise.all([loadDetail(), loadThreads()]);
}
for (const a of ['archive', 'unarchive', 'hide', 'unhide', 'trash', 'restore']) $(`st-${a}`).addEventListener('click', () => setStateAsk(a));
$('st-rename').addEventListener('click', async () => {
  const t = S.detail?.thread;
  if (!t) return;
  $('t-menu').open = false;
  const input = el('input', { type: 'text', id: 'rename-input', maxlength: '200', autocomplete: 'off', 'aria-label': '새 이름', value: t.title });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) (e.preventDefault(), $('confirm-ok').click());
  });
  const asked = ask({ title: '이름 바꾸기', ok: '바꾸기', text: `«${t.title}»의 새 이름. 에이전트는 다음 턴부터 새 이름을 봅니다.`, extra: el('label', { class: 'small' }, '새 이름 ', input) });
  input.focus(); // ask 는 «확인»에 초점을 둔다 — 이름 칸으로 옮긴다
  input.select();
  const ok = await asked;
  const title = input.value.trim();
  if (!ok || !title || title === t.title) return;
  try {
    await api('POST', `/api/threads/${t.id}/rename`, { title });
  } catch (e) {
    return notify('실패', STATE_ERR[e.code] ?? e.message);
  }
  await Promise.all([loadDetail(), loadThreads()]);
  announce(`이름을 «${title}»로 바꿨습니다`);
});
$('st-purge').addEventListener('click', async () => {
  const t = S.detail?.thread;
  if (!t) return;
  $('t-menu').open = false;
  const d = descendants(t.id);
  const input = el('input', { type: 'text', id: 'purge-confirm', autocomplete: 'off', 'aria-label': '확인용 제목', placeholder: t.title });
  const extra = el('label', { class: 'small' }, '확인하려면 제목을 그대로 입력하세요: ', el('b', {}, t.title), input);
  const ok = await ask({
    title: '영구 삭제',
    danger: true,
    ok: '영구 삭제',
    text: `«${t.title}»${d.length ? `와 아래 분기 ${d.length}개` : ''}의 메시지·첨부 파일·실행 기록을 지웁니다. 되돌릴 수 없습니다. 감사 기록에는 삭제했다는 사실만 남습니다.`,
    extra,
  });
  if (!ok) return;
  try {
    await api('POST', `/api/threads/${t.id}/purge`, { confirm: input.value });
  } catch (e) {
    return notify('실패', STATE_ERR[e.code] ?? e.message);
  }
  await loadThreads();
  location.hash = room()?.id ?? '';
});

$('btn-stop-new').addEventListener('click', async () => {
  const ok = await ask({
    title: '새 호출 금지',
    text: '이 대화에 새 에이전트 호출을 만들지 않습니다. 아직 나가지 않은 전달과 시작 전 실행도 거둡니다. 이미 도는 실행은 계속됩니다. 메시지는 계속 저장됩니다.',
    ok: '새 호출 금지',
  });
  if (!ok) return;
  await api('POST', `/api/threads/${S.cur}/stop`, { mode: 'stop_new' }).catch((e) => notify('실패', e.message));
  await Promise.all([loadDetail(), loadRuns(), loadThreads()]);
});
$('btn-resume').addEventListener('click', async () => {
  await api('POST', `/api/threads/${S.cur}/resume`).catch((e) => notify('실패', e.message));
  await Promise.all([loadDetail(), loadThreads()]);
});
$('btn-cancel-current').addEventListener('click', () => cancelCurrentAsk());
async function cancelCurrentAsk() {
  const ok = await ask({
    title: '현재 실행 취소',
    text: `이 대화에서 아직 안 나간 전달은 거두고 대기 중인 실행은 지금 취소하며, 실행 중인 것은 어댑터에 중단을 요청합니다(${Math.round(S.cancelAckMs / 1000)}초 안에 확인이 없으면 ‘상태 미확인’). 완료된 실행은 되돌릴 수 없습니다.`,
    ok: '모두 취소',
    danger: true,
  });
  if (!ok) return;
  const r = await api('POST', `/api/threads/${S.cur}/stop`, { mode: 'cancel_current' }).catch((e) => (notify('실패', e.message), null));
  if (r) announce(`전달 거둠 ${r.withdrawn_deliveries ?? 0}건 · 대기 중 취소 ${r.cancelled_runs.length}건 · 중단 요청 ${(r.cancel_requested_runs ?? []).length}건`);
  await loadRuns();
}

// ───── 세션 ─────
/** 맥락 크기 표시(마스터 #283 C) — 1만 토큰 단위로 */
const ctxK = (n) => (n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}만 토큰` : `${n.toLocaleString()} 토큰`);
function sizeLine(cur, policy) {
  const m = cur?.metrics;
  if (!m) return '측정 전';
  const parts = [];
  const tokPct = policy?.tokens && m.ctx_tokens != null ? m.ctx_tokens / policy.tokens : 0;
  const repPct = policy?.replies ? m.replies / policy.replies : 0;
  parts.push(m.ctx_tokens != null ? `약 ${ctxK(m.ctx_tokens)}` : '크기 보고 없음');
  parts.push(`답 ${m.replies}개`);
  const rule = [policy?.tokens ? `${ctxK(policy.tokens)}` : null, policy?.replies ? `답 ${policy.replies}개` : null].filter(Boolean).join(' 또는 ');
  const near = Math.max(tokPct, repPct);
  return el('span', { class: near >= 0.8 ? 'alertish' : '' }, `${parts.join(' · ')}${rule ? ` — 자동 교체 기준 ${rule}${near >= 1 ? ' (다음 호출 때 교체)' : near >= 0.8 ? ' (곧 교체)' : ''}` : ''}`);
}
function renderSessionsTab() {
  const d = S.detail;
  const box = $('sessions');
  if (!d) return box.replaceChildren();
  const agents = d.members.filter((m) => m.kind === 'agent');
  if (!agents.length) return box.replaceChildren(el('p', { class: 'muted small' }, '이 대화에 멤버 에이전트가 없습니다.'));
  box.replaceChildren(
    ...agents.map((a) => {
      const all = d.sessions.filter((s) => s.agent_id === a.participant_id).sort((x, y) => y.generation - x.generation);
      const cur = all.find((s) => s.status === 'active');
      const kv = (k, v) => [el('dt', {}, k), el('dd', {}, v)];
      return el(
        'div',
        { class: 'sess' },
        el('div', { class: 's1' }, el('b', {}, a.name), cur ? el('span', { class: 'pill' }, `활성 · ${cur.generation}세대`) : el('span', { class: 'pill' }, '세션 없음'), el('span', { class: 'spacer' }), el('button', { type: 'button', onclick: () => rotateAsk(a, cur) }, '세션 교체')),
        cur
          ? el(
              'dl',
              { class: 'kv' },
              kv('실제 모델', cur.actual_model ?? '아직 기록 없음(첫 실행 뒤 채워짐)'),
              kv('런타임', cur.runtime ?? '기록 없음'),
              kv('설정 버전', cur.config_version ?? '기록 없음'),
              kv('세대 경계', cur.base_seq ? `#${cur.base_seq} 뒤부터 원문` : '대화 처음부터'),
              kv('마지막 넘긴 메시지', cur.last_delivered_seq ? `#${cur.last_delivered_seq}` : '없음'),
              kv('시작', fmtTime(cur.created_at)),
              kv('맥락 사용량', sizeLine(cur, d.rotate_policy)),
              cur.carry ? kv('이어받기', `최근 글 원문 + 사서 요약으로 시작한 세대`) : null,
            )
          : el('p', { class: 'muted small' }, '첫 호출 때 1세대가 열립니다.'),
        all.length
          ? el(
              'table',
              { class: 'hist' },
              el('thead', {}, el('tr', {}, el('th', {}, '세대'), el('th', {}, '상태'), el('th', {}, '사유'), el('th', {}, '시작'), el('th', {}, '끝'))),
              el('tbody', {}, ...all.map((s) => el('tr', {}, el('td', {}, String(s.generation)), el('td', {}, s.status === 'active' ? '활성' : '종료'), el('td', {}, s.reason ?? ''), el('td', {}, fmtHm(s.created_at)), el('td', {}, fmtHm(s.ended_at))))),
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
      ['오류', '세션 오류'],
      ['모델 변경', '모델 변경'],
      ['설정 변경', '설정 변경'],
      ['포화', '맥락 포화'],
      ['기타', '기타'],
    ].map(([v, t]) => el('option', { value: v }, t)),
  );
  const memo = el('input', { id: 'rotate-memo', placeholder: '메모(선택)', maxlength: '300' });
  // 이어받기(마스터 #283 C): 맥락이 무거워 바꾸는 것이면 최근 글 원문 + 사서 요약을 들고 간다. 오류·모델 변경이면 빈 손이 낫다
  const carry = el('input', { type: 'checkbox', id: 'rotate-carry', checked: true });
  kindSel.value = '포화';
  kindSel.addEventListener('change', () => (carry.checked = kindSel.value === '포화' || kindSel.value === '기타'));
  const n = S.detail?.rotate_policy?.carry_messages ?? 12;
  const extra = el(
    'div',
    {},
    cur ? el('p', { class: 'small' }, `지금 맥락: `, sizeLine(cur, S.detail?.rotate_policy)) : null,
    el('div', { class: 'row wrap' }, el('label', { class: 'small' }, '교체 사유 ', kindSel), memo),
    el('label', { class: 'small' }, carry, ` 이어받기 — 최근 글 ${n}개 원문 + 사서 요약(있으면)을 새 세대에 싣는다`),
  );
  const ok = await ask({
    title: `${a.name} 세션 교체`,
    text: `${cur ? `${cur.generation}세대를 끝내고 ${cur.generation + 1}세대` : '새 세대'}를 엽니다. 이 에이전트의 진행 중 실행은 취소됩니다. 이어받기를 끄면 새 세대는 이전 대화 원문을 받지 않습니다.`,
    ok: '세션 교체',
    extra,
  });
  if (!ok) return;
  const reason = memo.value.trim() ? `${kindSel.value}: ${memo.value.trim()}` : kindSel.value;
  await api('POST', `/api/threads/${S.cur}/sessions/rotate`, { agent_id: a.participant_id, reason, carry: carry.checked }).catch((e) => notify('세션 교체 실패', e.message));
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
  if (!a) return { cls: '', text: '상태 모름' };
  if (a.state === 'no_credential') return { cls: 'off', text: '토큰 없음 — 어댑터가 붙을 수 없음' };
  if (a.state === 'revoked') return { cls: 'off', text: `토큰 폐기·만료됨${a.last_seen_at ? ` · 마지막 접속 ${rel(a.last_seen_at)}` : ''}` };
  if (a.state === 'never') return { cls: '', text: '한 번도 접속 안 함' };
  const age = Date.now() - a.last_seen_at;
  return { cls: age < 60_000 ? 'on' : 'stale', text: `마지막 접속 ${age < 60_000 ? `${Math.max(1, Math.floor(age / 1000))}초 전` : rel(a.last_seen_at)}` };
}
function renderPeopleTab() {
  $('sync-info').replaceChildren(
    el('div', {}, '실시간 연결: ', el('b', {}, S.wsOpen ? '연결됨(WebSocket)' : '끊김 — 재접속 중')),
    el('div', { class: 'muted' }, `마지막 동기화: ${S.lastSync ? fmtTime(S.lastSync) : '아직 없음'}`),
  );
  const d = S.detail;
  if (!d) return $('people').replaceChildren();
  $('people').replaceChildren(
    ...d.members.map((m) => {
      const c = m.kind === 'agent' ? agentConn(m.participant_id) : { cls: 'on', text: m.participant_id === S.me?.id ? '지금 이 화면' : '' };
      return el(
        'li',
        {},
        el('span', { class: `dot ${c.cls}`, 'aria-hidden': 'true' }),
        el('span', { class: 'who' }, el('b', {}, m.name), ' ', el('span', { class: 'faint' }, m.kind === 'agent' ? '에이전트' : '마스터'), el('div', { class: 'muted' }, c.text)),
        el('span', { class: 'faint' }, [m.can_read ? '읽기' : '', m.can_post ? '쓰기' : '', m.can_invoke ? '호출' : ''].filter(Boolean).join('·')),
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
    notify('스레드 생성', '이 대화에 메시지가 없어 분기할 수 없습니다. 첫 메시지를 먼저 쓰세요.');
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
    $('fork-parent').textContent = `부모: ${S.detail.thread.kind === 'room' ? '메인 채팅방' : pathOf(S.detail.thread)}`;
    $('fork-points').replaceChildren(
      ...f.cands.map((m) => {
        const r = el('input', { type: 'radio', name: 'fork-point', value: String(m.seq), checked: m.seq === f.point, 'aria-label': `#${m.seq} 분기 시점으로 지정` });
        r.addEventListener('change', () => {
          f.point = m.seq;
          f.picked = null;
          for (const p of $('fork-points').querySelectorAll('.pick')) p.classList.toggle('sel', p.dataset.seq === String(m.seq));
          syncForkNext();
        });
        return el('label', { class: `pick${m.seq === f.point ? ' sel' : ''}`, 'data-seq': String(m.seq) }, r, pickBody(m), el('span', { class: 'tag' }, '분기 시점으로 지정'));
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
    el('span', { class: 'ph' }, el('b', {}, pname(m.author_id)), el('span', {}, `#${m.seq}`), el('span', {}, fmtTime(m.created_at)), S.context.some((c) => c.seq === m.seq) ? el('span', {}, '(가져온 맥락)') : null),
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
    { id: 'fork-dr', 'aria-label': '기본 수신자' },
    el('option', { value: '' }, `부모와 같음 (${dr ? pname(dr) : '없음'})`),
    ...agents.map((a) => el('option', { value: a.participant_id, selected: f.dr === a.participant_id }, a.name)),
  );
  drSel.addEventListener('change', () => (f.dr = drSel.value || null));
  const kv = (k, ...v) => [el('dt', {}, k), el('dd', {}, ...v)];
  $('fork-summary').replaceChildren(
    ...kv('제목', $('fork-title').value.trim()),
    ...kv('부모', S.detail.thread.kind === 'room' ? '메인 채팅방' : pathOf(S.detail.thread)),
    ...kv('분기 시점 메시지', `#${pm.seq} · ${fmtTime(pm.created_at)} · ${pname(pm.author_id)}`),
    ...kv('참여 에이전트', `부모와 같음 (${agents.map((a) => a.name).join(', ') || '없음'})`),
    ...kv('기본 수신자', drSel),
  );
  const inc = forkRange();
  const upto = f.cands.filter((m) => m.seq <= f.point);
  $('fork-count').replaceChildren('총 ', el('b', {}, String(inc.size)), '개 메시지가 이 스레드에 포함됩니다.');
  $('fork-include').replaceChildren(
    ...upto.map((m) => {
      const isPoint = m.seq === f.point;
      const cb = el('input', { type: 'checkbox', value: String(m.seq), checked: inc.has(m.seq), disabled: isPoint, 'aria-label': `#${m.seq} 포함` });
      cb.addEventListener('change', () => {
        const cur = forkRange();
        if (cb.checked) cur.add(m.seq);
        else cur.delete(m.seq);
        f.preset = 'pick';
        f.picked = cur;
        renderForkStep2();
      });
      return el('label', { class: `pick${inc.has(m.seq) ? ' sel' : ''}` }, cb, pickBody(m), isPoint ? el('span', { class: 'tag' }, '분기 시점') : null);
    }),
  );
  $('fork-go').disabled = inc.size === 0 || f.busy;
}
const FORK_ERR = {
  bad_fork_point: '분기 시점 메시지가 이 대화에 없습니다(없어졌거나 열람 권한이 사라짐). 1단계에서 다시 고르세요.',
  bad_include: '분기 시점 뒤의 메시지가 범위에 들어 있습니다. 범위를 다시 확인하세요.',
  no_thread: '부모 대화를 더 이상 열 수 없습니다.',
  client_key_reused: '같은 요청 식별자가 다른 내용에 쓰였습니다. 다시 시도하면 새 식별자로 보냅니다.',
  bad_recipient: '기본 수신자가 에이전트가 아닙니다.',
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
    const msg = err.status ? FORK_ERR[err.code] ?? `${err.message}` : '응답을 받지 못했습니다. [다시 시도]는 같은 요청 식별자로 보내므로 스레드가 두 번 생기지 않습니다.';
    const box = $('fork-error');
    box.hidden = false;
    box.replaceChildren(
      el('b', {}, '스레드 생성 실패'),
      el('div', {}, msg),
      el('div', { class: 'row' }, el('button', { type: 'button', onclick: () => forkStep(1) }, '돌아가기'), el('button', { type: 'button', id: 'fork-retry', class: 'primary', onclick: submitFork }, '다시 시도')),
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
      item.upNote = `첨부 올리는 중 ${i + 1}/${files.length}`;
      renderOutbox();
      try {
        const u = await api('POST', `/api/uploads?name=${encodeURIComponent(files[i].name)}`, undefined, files[i]);
        item.uploads[i] = u.upload.id;
      } catch (e) {
        if (e.status) e.message = `첨부 «${files[i].name}»: ${e.status === 413 ? '20MB를 넘습니다' : e.message}`;
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
    announce(`전송 완료: ${r.target?.title ?? ''}`);
    if (r.invoke_paused && item.payload.recipients.length) notify('메시지만 저장됨', '이 대화는 «새 호출 금지» 상태라 에이전트를 부르지 않았습니다.');
  } catch (err) {
    if (!err.status || err.status >= 500 || err.status === 408) {
      // 응답을 못 받았다 — 저장됐는지 모른다. 같은 client_key 로 다시 물어 확인한다
      item.state = 'unknown';
      item.error = err.status ? `서버 오류 ${err.status}` : '응답을 받지 못했습니다';
      announce('전송 결과 미확인');
    } else {
      item.state = 'failed';
      item.error = (err.message?.startsWith('첨부 «') ? err.message : SEND_ERR[err.code]) ?? err.message;
      item.retryable = err.status === 429;
      announce(`전송 실패: ${item.error}`);
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
      if (x.state === 'sending') st = el('span', { class: 'sendst wait' }, x.upNote ? `${x.upNote}…` : '전송 중…');
      else if (x.state === 'stored') st = el('span', { class: 'sendst wait' }, '저장됨 — 목록 동기화 대기');
      else if (x.state === 'unknown')
        st = el(
          'div',
          { class: 'local-state unknown' },
          el('b', { class: 'sendst unknown' }, '전송 결과 미확인'),
          `${x.error}. [다시 확인]은 같은 요청 식별자로 보내므로 두 번 저장되지 않습니다.`,
          el('button', { type: 'button', class: 'retry', onclick: () => send(x) }, '다시 확인'),
          el('button', { type: 'button', onclick: () => reconnectNow() }, '재접속 복구'),
          el('button', { type: 'button', onclick: () => dropItem(x) }, '버리기'),
        );
      else
        st = el(
          'div',
          { class: 'local-state failed' },
          el('b', { class: 'sendst failed' }, '전송 실패'),
          x.error,
          x.retryable ? el('button', { type: 'button', class: 'retry', onclick: () => send(x) }, '재시도') : el('span', { class: 'faint' }, '(다시 보내도 같은 결과)'),
          el('button', { type: 'button', onclick: () => editItem(x) }, '고쳐 쓰기'),
          el('button', { type: 'button', onclick: () => dropItem(x) }, '버리기'),
        );
      return el(
        'article',
        { class: 'msg mine local', 'data-key': x.payload.client_key },
        el('span', { class: 'avatar', 'aria-hidden': 'true' }, S.me ? initials(S.me.id) : '나'),
        el(
          'div',
          { class: 'main' },
          el('div', { class: 'head' }, el('b', {}, S.me?.name ?? '나'), el('span', { class: 'badge' }, KIND[x.payload.source_kind]), x.payload.recipients.length ? el('span', {}, `→ ${x.payload.recipients.map(pname).join(', ')}`) : null, x.state === 'sending' || x.state === 'stored' ? st : null),
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
      note.textContent = '⚠ 받는 쪽을 고르지 않았습니다 — 에이전트를 고르거나 «메모»를 켜세요';
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
  b.replaceChildren(el('b', {}, { reconnect: '재접속 중', bulk: '대량 메시지 복구 중', full: '전체 재조회 필요', done: '복구 완료' }[kind]), el('span', {}, text ?? ''), action ?? null);
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
    setBanner('full', '서버 기록이 이 화면보다 짧습니다. 처음부터 다시 불러옵니다. 그동안의 전송 결과는 확정하지 않습니다.');
    await reloadMessages();
    setBanner('done', `메시지 ${S.messages.length}건을 다시 불러왔습니다.`);
    return;
  }
  const start = S.cursor;
  let bulk = false;
  const added = await fetchNew((n, cursor, more) => {
    if (more && !bulk && show) bulk = true;
    if (bulk) setBanner('bulk', `받은 메시지 ${n}건`, baseline > start ? ((cursor - start) / (baseline - start)) * 100 : 100);
  }).catch(() => null);
  if (added === null) return;
  // 복구 검증: seq 오름차순 · 중복 없음 — 어긋나면 전체 재조회
  const ok = S.messages.every((m, i) => i === 0 || S.messages[i - 1].seq < m.seq) && new Set(S.messages.map((m) => m.seq)).size === S.messages.length;
  if (!ok) {
    setBanner('full', '받은 목록이 어긋났습니다. 처음부터 다시 불러옵니다.');
    await reloadMessages();
  }
  await Promise.all([loadRuns(), loadContext()]).catch(() => {});
  if (show) setBanner('done', added ? `빠진 메시지 ${added}건을 받았습니다.` : '빠진 메시지가 없습니다.');
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
  setConn(false, '연결 중…');
  ws.onopen = () => {
    S.wsBackoff = 1000;
    S.wsOpen = true;
    setConn(true, '연결됨');
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
    setConn(false, `끊김 — ${secs}초 뒤 재접속`);
    if (S.cur) setBanner('reconnect', `서버 연결이 끊어졌습니다. ${secs}초 뒤 다시 연결합니다. 받은 메시지는 그대로 보입니다.`, null, el('button', { type: 'button', onclick: reconnectNow }, '지금 다시 연결'));
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
    else if (S.auxOpen && isNarrow()) setAux(false);
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
  for (const q of ['(max-width: 760px)', '(max-width: 999px)']) {
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
  $('me').textContent = S.me.name;
  $('logout-btn').hidden = false;
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  const ps = (await api('GET', '/api/participants')).participants;
  S.participants = new Map(ps.map((p) => [p.id, p]));
  S.tab = ['runs', 'sessions', 'people', 'claims'].includes(store('bs.aux-tab')) ? store('bs.aux-tab') : 'runs';
  setAux(!auxOverlays() && store('bs.aux-open') === '1', S.tab);
  await loadThreads();
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
boot();

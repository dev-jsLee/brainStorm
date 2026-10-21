// brainStorm 선점 보기 1안 — 리듬게임 레인(2026-10-16 마스터 #345 · 위임 대장 schema 13).
// 선점 대상(경로 접두·자원)이 저장소별 레인 아래에 흰 노트블록으로 놓이고, 위임의 블록 행이 위에서 떨어져 닿으면 그 백수의 색으로 물든다.
// 겹쳐 못 들어간 위임(대기 · granted=0)은 레인 위에 테트리스처럼 쌓이고, 마스터가 «진입»(admit)을 눌러야 들어간다. 끝나면 하얘진다.
// 둘로 나눈다 — 2안(웹 3D)이 «그리기»만 바꿔 끼우게:
//   claimScene(delegations, now)  상태 → 장면(순수 계산 · DOM 없음)
//   claimSceneDiff(prev, next)    두 장면 사이 연출(떨어짐·하얘짐) — 첫 그림·움직임 줄이기에서는 비운다
//   renderClaims()                장면 → DOM(CSS grid · 연출은 CSS 애니메이션)
// app.js 보다 먼저 읽히지만 함수만 정의한다. app.js 의 전역($·S·el·api…)을 쓴다.
'use strict';

/** 끝난 위임을 레인 범위(노트블록)로 남겨 두는 시간 — 서버 목록 ?recent= 와 같다 */
const CLAIM_RECENT_S = 86400;
const CLAIM_STATE = { queued: '대기', running: '작업 중', blocked: '막힘', done: '끝', cancelled: '취소됨' };

/** assignee 문자열에서 결정적으로 뽑는 색(같은 백수 = 같은 색) — FNV-1a 해시 → 황금각 색상환 */
function claimColor(assignee) {
  let h = 0x811c9dc5;
  for (const ch of String(assignee)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hue = Math.round((h * 137.508) % 360);
  return `hsl(${hue} 62% 46%)`;
}

/** 이 선점이 노트블록(cell)을 통째로 덮나 — path 는 선점 범위가 cell 의 접두('*' = 저장소 전체), resource 는 정확히 같음 */
function claimCovers(c, cell) {
  if (c.kind !== cell.kind || c.repo !== cell.repo) return false;
  if (c.kind === 'resource') return c.scope === cell.scope;
  return c.scope === '*' || cell.scope.startsWith(c.scope);
}

/**
 * 상태 → 장면. delegations = GET /api/delegations?active=1&recent=… 의 목록(선점 포함).
 * 레인 = path 저장소마다 하나 + 자원 한 줄. 노트블록 = 그 목록이 선점한(했던) 범위의 합집합(경로 접두 그대로 라벨).
 * 각 블록: holder(덮는 잡힌 선점의 위임 — 겹침 규칙상 하나뿐) · parts(블록 안쪽만 잡은 다른 위임들 — 띠로).
 * stack = 대기 위임 행(오래된 것이 아래) — 원하는 블록 칸에만 조각이 있다.
 */
function claimScene(delegations, now = Date.now()) {
  const dl = new Map();
  for (const d of delegations) {
    dl.set(d.id, {
      id: d.id,
      assignee: d.assignee,
      title: d.title,
      status: d.status,
      spec1: (String(d.spec ?? '').split('\n').find((x) => x.trim()) ?? '').trim(),
      color: claimColor(d.assignee),
      waiting: !!d.waiting,
      closed: d.status === 'done' || d.status === 'cancelled',
      created_by: d.created_by,
      created_at: d.created_at,
      finished_at: d.finished_at ?? null,
    });
  }
  const lanes = new Map();
  const laneOf = (c) => {
    const key = c.kind === 'resource' ? 'resource:' : `path:${c.repo}`;
    if (!lanes.has(key)) lanes.set(key, { key, kind: c.kind, repo: c.kind === 'resource' ? null : c.repo, label: c.kind === 'resource' ? '자원' : c.repo, cells: new Map(), stack: [] });
    return lanes.get(key);
  };
  for (const d of delegations)
    for (const c of d.claims) {
      const lane = laneOf(c);
      const k = c.kind === 'resource' ? `${c.repo}/${c.scope}` : c.scope;
      if (!lane.cells.has(k)) lane.cells.set(k, { key: k, kind: c.kind, repo: c.repo, scope: c.scope, label: k, holder: null, parts: [] });
    }
  // 잡힌(granted) 활성 선점 → 덮는 블록은 물들고, 안쪽만 잡은 블록에는 띠
  for (const d of delegations) {
    const info = dl.get(d.id);
    if (info.closed) continue;
    for (const c of d.claims) {
      if (!c.granted || c.released_at) continue;
      for (const cell of laneOf(c).cells.values()) {
        if (claimCovers(c, cell)) cell.holder = info;
        else if (c.kind === 'path' && c.scope.startsWith(cell.scope) && !cell.parts.includes(info)) cell.parts.push(info);
      }
    }
  }
  // 대기 행: 대기 위임마다 레인별 한 줄(오래된 것이 아래 = 배열 앞)
  const waiting = delegations.filter((d) => dl.get(d.id).waiting).sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  for (const d of waiting) {
    const per = new Map();
    for (const c of d.claims) {
      if (c.granted || c.released_at) continue;
      const lane = laneOf(c);
      if (!per.has(lane.key)) per.set(lane.key, new Set());
      per.get(lane.key).add(c.kind === 'resource' ? `${c.repo}/${c.scope}` : c.scope);
    }
    for (const [lk, keys] of per) lanes.get(lk).stack.push({ delegation: dl.get(d.id), keys: [...keys] });
  }
  const out = [...lanes.values()]
    .map((l) => ({ ...l, cells: [...l.cells.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) }))
    .sort((a, b) => (a.kind !== b.kind ? (a.kind === 'path' ? -1 : 1) : a.label < b.label ? -1 : 1));
  return { at: now, lanes: out, delegations: dl };
}

/** 두 장면 사이 연출: 새로 물든 블록(drop) · 새로 하얘진 블록(whiten — 그 전 색) · 새로 쌓인 대기 행(fall). prev 가 없으면 연출 없음 */
function claimSceneDiff(prev, next) {
  const fx = { drop: new Set(), whiten: new Map(), fall: new Set() };
  if (!prev) return fx;
  const held = new Map();
  const rows = new Set();
  for (const l of prev.lanes) {
    for (const c of l.cells) if (c.holder) held.set(`${l.key}|${c.key}`, c.holder);
    for (const r of l.stack) rows.add(`${l.key}|${r.delegation.id}`);
  }
  for (const l of next.lanes) {
    for (const c of l.cells) {
      const k = `${l.key}|${c.key}`;
      const was = held.get(k);
      if (c.holder && (!was || was.id !== c.holder.id)) fx.drop.add(k);
      else if (!c.holder && was) fx.whiten.set(k, was.color);
    }
    for (const r of l.stack) if (!rows.has(`${l.key}|${r.delegation.id}`)) fx.fall.add(`${l.key}|${r.delegation.id}`);
  }
  return fx;
}

/** 장면 서명 — 블록·주인·상태·띠·대기 행이 같으면 같다 */
function claimSceneSig(scene) {
  return JSON.stringify(scene.lanes.map((l) => [l.key, l.cells.map((c) => [c.key, c.holder?.id, c.holder?.status, c.parts.map((p) => p.id)]), l.stack.map((r) => [r.delegation.id, r.keys])]));
}

const claimsReduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let claimReq = 0;
async function loadClaims() {
  const my = ++claimReq;
  const r = await api('GET', `/api/delegations?active=1&recent=${CLAIM_RECENT_S}`);
  if (my !== claimReq) return; // 늦게 온 옛 응답은 버린다
  S.dlg = r.delegations;
  if (S.auxOpen && S.tab === 'claims') renderClaims();
}

/** 장면 → DOM. 레인 하나 = CSS grid(열 = 노트블록) — 위 줄들은 대기 행(새것이 위), 맨 아래 줄이 노트블록 */
function renderClaims() {
  const box = $('claims-lanes');
  if (!box) return;
  if (!S.dlg) {
    box.replaceChildren(el('p', { class: 'muted small' }, '불러오는 중…'));
    loadClaims().catch((e) => box.replaceChildren(el('p', { class: 'err small' }, `불러오지 못함: ${e.message}`)));
    return;
  }
  const scene = claimScene(S.dlg);
  // 같은 장면이면 DOM 을 갈지 않는다 — 알림과 REST 응답이 겹쳐 두 번 그리면 막 시작한 연출이 끊긴다
  const sig = claimSceneSig(scene);
  if (sig === S.claimSig && box.childElementCount) {
    S.claimScene = scene;
    return renderClaimDetail();
  }
  S.claimSig = sig;
  const fx = claimsReduceMotion() ? claimSceneDiff(null, scene) : claimSceneDiff(S.claimScene, scene);
  S.claimScene = scene;
  if (!scene.lanes.length) {
    box.replaceChildren(el('p', { class: 'muted small' }, '선점이 없습니다. 위임을 만들면 그 범위가 여기 노트블록으로 놓입니다.'));
    renderClaimDetail();
    return;
  }
  box.replaceChildren(
    ...scene.lanes.map((l) => {
      const n = l.cells.length;
      const col = new Map(l.cells.map((c, i) => [c.key, i + 1]));
      const sky = Math.max(l.stack.length, 1);
      const grid = el('div', { class: 'cl-grid', role: 'group', 'aria-label': `${l.label} 레인` });
      grid.style.setProperty('--n', String(n));
      // 대기 행: 오래된 것(stack[0])이 노트블록 바로 위
      l.stack.forEach((r, i) => {
        const row = sky - i;
        const fall = fx.fall.has(`${l.key}|${r.delegation.id}`);
        for (const k of r.keys) {
          const b = el(
            'button',
            { type: 'button', class: `cl-q${fall ? ' fall' : ''}${S.claimSel === r.delegation.id ? ' sel' : ''}`, 'data-dlg': r.delegation.id, 'data-key': k, title: `${r.delegation.assignee} · 대기 — ${r.delegation.title}`, onclick: () => selectClaim(r.delegation.id) },
            r.delegation.assignee,
          );
          b.style.setProperty('--c', r.delegation.color);
          b.style.gridColumn = String(col.get(k));
          b.style.gridRow = String(row);
          grid.append(b);
        }
      });
      if (!l.stack.length) {
        const pad = el('div', { class: 'cl-sky', 'aria-hidden': 'true' });
        pad.style.gridColumn = `1 / span ${n}`;
        pad.style.gridRow = '1';
        grid.append(pad);
      }
      for (const c of l.cells) {
        const k = `${l.key}|${c.key}`;
        const h = c.holder;
        const cls = ['cl-cell'];
        if (h) cls.push('held');
        if (h?.status === 'blocked') cls.push('blocked');
        if (fx.drop.has(k)) cls.push('drop');
        if (fx.whiten.has(k)) cls.push('whiten');
        if (h && S.claimSel === h.id) cls.push('sel');
        const b = el(
          'button',
          {
            type: 'button',
            class: cls.join(' '),
            'data-key': c.key,
            'data-dlg': h?.id ?? false,
            title: h ? `${c.label} — ${h.assignee} · ${CLAIM_STATE[h.status] ?? h.status}` : `${c.label} — 비어 있음`,
            onclick: () => h && selectClaim(h.id),
          },
          el('span', { class: 'cl-label' }, c.label),
          c.parts.length
            ? el(
                'span',
                { class: 'cl-parts' },
                c.parts.map((p) => {
                  const i = el('i', { title: `${p.assignee} — 안쪽 일부` });
                  i.style.setProperty('--c', p.color);
                  return i;
                }),
              )
            : null,
        );
        if (h) b.style.setProperty('--c', h.color);
        if (fx.whiten.has(k)) b.style.setProperty('--was', fx.whiten.get(k));
        b.style.gridColumn = String(col.get(c.key));
        b.style.gridRow = String(sky + 1);
        grid.append(b);
      }
      return el('section', { class: 'cl-lane', 'data-lane': l.key }, el('h4', {}, l.label, el('span', { class: 'muted small' }, ` · 블록 ${n}${l.stack.length ? ` · 대기 ${new Set(l.stack.map((r) => r.delegation.id)).size}` : ''}`)), el('div', { class: 'cl-board' }, grid));
    }),
  );
  renderClaimDetail();
}

function selectClaim(id) {
  S.claimSel = S.claimSel === id ? null : id;
  for (const b of document.querySelectorAll('#claims-lanes [data-dlg]')) b.classList.toggle('sel', b.dataset.dlg === S.claimSel);
  renderClaimDetail();
}

/** 고른 블록의 위임 — 제목·백수·상태·명세 첫 줄 · 대기면 마스터에게 «진입» */
function renderClaimDetail() {
  const box = $('claims-detail');
  if (!box) return;
  const d = S.claimSel && S.claimScene?.delegations.get(S.claimSel);
  if (!d) return box.replaceChildren(el('p', { class: 'muted small' }, '블록을 누르면 그 위임이 보입니다.'));
  const kv = (k, v) => [el('dt', {}, k), el('dd', {}, v)];
  const state = d.waiting ? '대기(겹쳐 못 들어감)' : (CLAIM_STATE[d.status] ?? d.status);
  const sw = el('span', { class: 'cl-sw', 'aria-hidden': 'true' });
  sw.style.setProperty('--c', d.color);
  box.replaceChildren(
    el('div', { class: 'cl-d1' }, sw, el('b', {}, d.title)),
    el('dl', { class: 'kv small' }, kv('백수', d.assignee), kv('상태', state), kv('명세', d.spec1 || '—'), kv('만든 때', fmtTime(d.created_at)), d.finished_at ? kv('끝난 때', fmtTime(d.finished_at)) : null),
    d.waiting && S.me?.is_master ? el('div', { class: 'controls' }, el('button', { type: 'button', class: 'primary', id: 'cl-admit', onclick: () => admitClaim(d.id) }, '진입')) : null,
    el('p', { id: 'cl-msg', class: 'small', role: 'status' }),
  );
}

/** 마스터의 «먼저 해도 된다» — POST …/admit. 아직 겹치면 409 claim_conflict 를 보여 준다(대기 그대로) */
async function admitClaim(id) {
  const msg = () => $('cl-msg');
  try {
    await api('POST', `/api/delegations/${encodeURIComponent(id)}/admit`);
    if (msg()) msg().textContent = '진입했습니다.';
    await loadClaims();
  } catch (e) {
    const who = e.json?.conflicts?.map((c) => `${c.assignee}(${c.scope})`).join(', ');
    if (msg()) msg().textContent = e.code === 'claim_conflict' ? `아직 겹칩니다 — ${who}` : `진입 못 함: ${e.message}`;
  }
}

/** WS {t:'delegation'} — 다시 읽고 그린다(연출은 장면 차이로) */
function onDelegationNotice() {
  if (S.auxOpen && S.tab === 'claims') loadClaims().catch(() => {});
  else S.dlg = null; // 탭을 열 때 새로 읽는다
}

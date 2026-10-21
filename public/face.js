// brainStorm 대면 모드(2026-10-19 마스터 #579·#581 · 마이그레이션 16) — 대화 화면의 세 열:
//   왼쪽 초안 쪽(백구) 글 · 오른쪽 검토 쪽(비전) 글 · 가운데 위 합의문(판 번호 · 턴 k/4(→6) · 바뀐 줄 강조 · ⚑ 안건) · 가운데 안건·질문·결론 카드.
//   작성란은 그대로 가운데 아래 — 받는 이 칩 없음(서버가 정한다: 새 지시는 초안 쪽부터 · 질문 답은 물은 쪽). ≤760px 은 탭(합의문 · 백구 · 비전).
// app.js 보다 먼저 읽히지만 함수만 정의한다. app.js 의 전역($·S·el·api·pname·fillBody…)을 쓴다.
'use strict';

const FACE_STATE = { running: '진행 중', question: '질문 — 마스터 답 대기', agreed: '합의', limit: '상한', stopped: '멈춤', approved: '승인됨', rejected: '반려됨' };
const FACE_STOP = { no_doc: '합의문 없음 — 그 턴의 답에 ```합의문 블록이 없었습니다', run_failed: '실행 실패', master_stop: '마스터가 멈춤', mode_off: '대면 모드를 껐음', invoke_paused: '새 호출 금지 중' };

const faceActive = () => S.detail?.thread?.mode === 'face' && S.detail.thread.kind !== 'room';

/** 대화 머리의 «대면 모드» 단추(마스터 · 스레드만) */
function syncFaceToggle() {
  const b = $('t-face');
  if (!b) return;
  const t = S.detail?.thread;
  b.hidden = !t || t.kind === 'room' || !S.me?.is_master;
  const on = faceActive();
  b.textContent = on ? '대면 모드 끄기' : '대면 모드';
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.title = on ? '보통 대화로 돌아갑니다 — 진행 중인 대면은 멈춥니다' : '가운데 합의문 하나를 두 에이전트가 번갈아 고칩니다(늘 초안 쪽부터)';
}

async function toggleFace() {
  if (!S.cur || !S.detail) return;
  const on = faceActive();
  if (on && S.face?.round && (S.face.round.state === 'running' || S.face.round.state === 'question')) {
    if (!(await ask({ title: '대면 모드 끄기', text: '진행 중인 대면이 멈춥니다(지금 차례의 배달을 거두고 도는 실행에 중단을 요청). 보통 대화로 돌아갑니다.', ok: '끄기' }))) return;
  }
  try {
    await api('POST', `/api/threads/${S.cur}/mode`, { mode: on ? 'chat' : 'face' });
    announce(on ? '대면 모드 끔' : '대면 모드 켬');
  } catch (e) {
    notify('대면 모드', e.code === 'face_members' ? '두 에이전트가 이 대화의 멤버여야 합니다. ' + (e.message ?? '') : e.message);
  }
  await loadDetail().catch(() => {});
}

/** 상세를 읽은 뒤: 대면이면 세 열을 띄우고 읽는다 · 아니면 보통 목록 */
function faceSync() {
  const on = faceActive();
  $('face').hidden = !on;
  $('messages').hidden = on;
  syncFaceToggle();
  if (on) loadFace().catch(() => {});
  else S.face = null;
}

let faceReq = 0;
async function loadFace() {
  const th = S.cur;
  const n = ++faceReq;
  const f = await api('GET', `/api/threads/${th}/face`);
  if (th !== S.cur || n !== faceReq) return;
  S.face = f;
  renderFace();
  renderRecipients();
}

/** 받는 이 칸 대신 한 줄 — 이번 글이 누구에게 가나 */
function faceRecipientsNote() {
  const f = S.face;
  const r = f?.round;
  const drafter = f?.config?.drafter;
  let text;
  if (r?.state === 'question') text = `질문 답 → ${pname(r.question_by)}이(가) 이어 받습니다`;
  else if (r?.state === 'running') text = `대면 진행 중(${pname(r.next_agent)} 차례) — 이 글은 맥락으로만 남습니다`;
  else text = `새 지시 → ${drafter ? pname(drafter) : '초안 쪽'}부터 시작합니다`;
  return [el('span', { class: 'lbl' }, '대면'), el('span', { class: 'small', id: 'face-to' }, text)];
}

function faceTurnLabel(r) {
  return r.turn > r.base_turns ? `턴 ${r.turn}/${r.max_turns}` : `턴 ${r.turn}/${r.base_turns}(→${r.max_turns})`;
}

function faceMsgCard(m, f) {
  const rev = f?.revs?.find((x) => x.message_seq === m.seq);
  const q = f?.round?.question_seq === m.seq;
  const body = el('div', { class: 'body' });
  fillBody(body, m.body, isPlain(S.cur));
  return el(
    'article',
    { class: 'face-msg', id: `fm${m.seq}`, 'data-seq': String(m.seq) },
    el('div', { class: 'face-msg-head small' }, el('b', {}, pname(m.author_id)), ` #${m.seq} · ${fmtHm(m.created_at)}`, rev ? el('span', { class: 'pill' }, `판 ${rev.rev} · 턴 ${rev.turn}`) : null, q ? el('span', { class: 'pill warn' }, '질문') : null),
    body,
  );
}

function renderFace() {
  if (!faceActive()) return;
  const f = S.face;
  const box = $('face');
  box.dataset.tab = S.faceTab ?? 'doc';
  const r = f?.round ?? null;
  const drafter = r?.drafter ?? f?.config?.drafter;
  const reviewer = r?.reviewer ?? f?.config?.reviewer;
  // 이 라운드의 글만(라운드가 없으면 전부) — 지시 글부터
  const from = r ? r.instruction_seq : 0;
  const msgs = S.messages.filter((m) => m.seq >= from);
  $('face-left-h').textContent = drafter ? pname(drafter) : '초안 쪽';
  $('face-right-h').textContent = reviewer ? pname(reviewer) : '검토 쪽';
  $('face-tab-left').textContent = $('face-left-h').textContent;
  $('face-tab-right').textContent = $('face-right-h').textContent;
  for (const b of $('face-tabs').querySelectorAll('button')) b.setAttribute('aria-selected', b.dataset.tab === box.dataset.tab ? 'true' : 'false');
  $('face-left-list').replaceChildren(...msgs.filter((m) => m.author_id === drafter).map((m) => faceMsgCard(m, f)));
  $('face-right-list').replaceChildren(...msgs.filter((m) => m.author_id === reviewer).map((m) => faceMsgCard(m, f)));
  // 가운데: 마스터 글(지시·답) · 합의문 · 카드
  const others = msgs.filter((m) => m.author_id !== drafter && m.author_id !== reviewer);
  $('face-orders').replaceChildren(
    ...others.map((m) => el('div', { class: 'face-order small', id: `fo${m.seq}` }, el('b', {}, `${pname(m.author_id)} #${m.seq}`), ' ', m.body.length > 300 ? m.body.slice(0, 300) + '…' : m.body)),
  );
  renderFaceDoc(f);
  renderFaceCards(f);
}

function renderFaceDoc(f) {
  const r = f?.round;
  const head = $('face-doc-h');
  const doc = $('face-doc');
  if (!r) {
    head.textContent = '합의문';
    doc.replaceChildren(el('p', { class: 'muted small' }, '아직 라운드가 없습니다 — 아래 작성란에 지시를 쓰면 초안 쪽부터 시작합니다.'));
    return;
  }
  head.replaceChildren(
    el('b', {}, r.rev ? `합의문 · 판 ${r.rev}` : '합의문'),
    ' ',
    el('span', { class: 'pill' }, faceTurnLabel(r)),
    ' ',
    el('span', { class: `pill face-st-${r.state}` }, FACE_STATE[r.state] ?? r.state),
  );
  if (!r.rev) {
    doc.replaceChildren(el('p', { class: 'muted small' }, `${pname(r.next_agent ?? r.drafter)}이(가) 초안을 쓰는 중입니다.`));
    return;
  }
  const last = f.revs.find((x) => x.rev === r.rev);
  const origins = last?.origins ?? [];
  const open = new Map(f.issues.filter((i) => i.state === 'open').map((i) => [i.id, i]));
  const lines = (r.doc ?? '').split('\n');
  doc.replaceChildren(
    el(
      'ol',
      { class: 'face-lines' },
      ...lines.map((l, i) => {
        const o = origins[i] ?? {};
        const iss = o.issue ? open.get(o.issue) : null;
        const changed = r.rev > 1 && o.rev === r.rev;
        return el(
          'li',
          { class: `${changed ? 'changed' : ''}${iss ? ' issue' : ''}`, title: `${pname(o.by)} · 판 ${o.rev}${o.draft ? ' (초안)' : ''}` },
          el('span', { class: 'ln-text' }, l || ' '),
          iss ? el('span', { class: 'flag', title: `안건 ${iss.n} — 마스터가 정합니다` }, `⚑ 안건 ${iss.n}`) : null,
        );
      }),
    ),
  );
}

function faceIssueCard(f, iss) {
  const r = f.round;
  const closed = r.state === 'approved' || r.state === 'rejected';
  const ta = el('textarea', { rows: '2', class: 'face-own', 'aria-label': `안건 ${iss.n} 직접 쓰기`, placeholder: '직접 쓰기 — 이 줄(들)을 이 글로 갈아 끼웁니다' });
  return el(
    'section',
    { class: `face-card face-issue ${iss.state}`, id: `fi-${iss.id}` },
    el('h4', {}, `⚑ 안건 ${iss.n}`, ' ', el('span', { class: 'muted small' }, iss.kind === 'limit' ? '상한 턴에 바뀐 줄' : '쟁점 — 상대가 고친 줄을 다시 고침'), iss.state === 'decided' ? el('span', { class: 'pill' }, '정함') : null),
    el(
      'ol',
      { class: 'face-versions' },
      ...iss.versions.map((v, k) =>
        el(
          'li',
          {},
          el('div', { class: 'small' }, el('b', {}, `${pname(v.by)}안`), ` · 판 ${v.rev}`, v.revert ? el('span', { class: 'pill warn', title: '자기 옛 문장으로 되돌림 — 가장 센 이견' }, '되돌림') : null, v.seq ? el('a', { href: '#', class: 'small', onclick: (e) => (e.preventDefault(), document.getElementById(`fm${v.seq}`)?.scrollIntoView({ block: 'center' })) }, ` 해설 #${v.seq}`) : null),
          el('pre', { class: 'face-v' }, v.text || '(지움)'),
          iss.state === 'open' && !closed && S.me?.is_master ? el('button', { type: 'button', class: 'small', 'data-pick': String(k), onclick: () => faceDecide(iss, { pick: k }) }, '이 판으로') : null,
        ),
      ),
    ),
    iss.state === 'open' && !closed && S.me?.is_master
      ? el('div', { class: 'face-own-row' }, ta, el('button', { type: 'button', class: 'small', onclick: () => ta.value.trim() && faceDecide(iss, { text: ta.value }) }, '이 글로 정함'))
      : iss.state === 'decided'
        ? el('pre', { class: 'face-v decided' }, iss.decision || '(지움)')
        : null,
  );
}

function renderFaceCards(f) {
  const box = $('face-cards');
  const r = f?.round;
  if (!r) return box.replaceChildren();
  const cards = [];
  const master = !!S.me?.is_master;
  if (r.state === 'question')
    cards.push(
      el(
        'section',
        { class: 'face-card face-question' },
        el('h4', {}, `질문 — ${pname(r.question_by)}`),
        el('p', {}, r.question),
        el('button', { type: 'button', class: 'small', onclick: () => $('body').focus() }, '작성란에서 답하기'),
      ),
    );
  const open = f.issues.filter((i) => i.state === 'open');
  for (const iss of f.issues) cards.push(faceIssueCard(f, iss));
  if (r.state === 'agreed' || r.state === 'limit') {
    const settle = el('input', { type: 'text', id: 'face-settle', placeholder: '정산: 날짜 · 잴 것', 'aria-label': '정산 줄' });
    cards.push(
      el(
        'section',
        { class: 'face-card face-verdict' },
        el('h4', {}, r.state === 'agreed' ? (open.length ? `합의 · 안건 ${open.length}` : '합의') : `상한 — 턴 ${r.turn}까지 바뀜`),
        el('p', { class: 'small' }, open.length ? `열린 안건 ${open.length}개를 다 정하면 승인할 수 있습니다.` : '마지막 판이 둘의 합의입니다.'),
        master ? settle : null,
        master
          ? el(
              'div',
              { class: 'row' },
              el('button', { type: 'button', class: 'primary', id: 'face-approve', disabled: open.length > 0, onclick: () => faceVerdict('approve', settle.value) }, '승인'),
              el('button', { type: 'button', id: 'face-reject', onclick: () => faceVerdict('reject', settle.value) }, '반려'),
            )
          : null,
      ),
    );
  } else if (r.state === 'approved' || r.state === 'rejected') {
    cards.push(el('section', { class: `face-card face-verdict ${r.state}` }, el('h4', {}, FACE_STATE[r.state]), r.verdict_note ? el('p', { class: 'small' }, r.verdict_note) : null));
  } else if (r.state === 'stopped' || f.stalled) {
    cards.push(
      el(
        'section',
        { class: 'face-card face-stopped' },
        el('h4', {}, '멈춤'),
        el('p', { class: 'small' }, r.state === 'stopped' ? FACE_STOP[r.stop_reason] ?? r.stop_reason ?? '' : '그 턴의 실행이 답 없이 끝났습니다(취소·미확인).'),
        master ? el('button', { type: 'button', id: 'face-retry', onclick: faceRetry }, `다시 돌리기 — ${pname(r.next_agent ?? r.drafter)} 턴 ${r.turn + 1}`) : null,
      ),
    );
  } else if (r.state === 'running') {
    cards.push(
      el(
        'section',
        { class: 'face-card face-running small' },
        el('span', {}, `${pname(r.next_agent)} 차례 · 턴 ${r.turn + 1}`),
        master ? el('button', { type: 'button', class: 'small', id: 'face-stop', onclick: faceStop }, '멈추기') : null,
      ),
    );
  }
  box.replaceChildren(...cards);
}

async function faceAct(path, body, done) {
  try {
    await api('POST', path, body);
    if (done) announce(done);
  } catch (e) {
    notify('대면', e.message);
  }
  await loadFace().catch(() => {});
}
const faceDecide = (iss, body) => faceAct(`/api/face/${S.face.round.id}/issues/${iss.id}/decide`, body, `안건 ${iss.n} 정함`);
const faceVerdict = (verdict, note) => faceAct(`/api/face/${S.face.round.id}/verdict`, { verdict, note: note || undefined }, verdict === 'approve' ? '승인함' : '반려함');
const faceRetry = () => faceAct(`/api/face/${S.face.round.id}/retry`, {}, '다시 돌림');
async function faceStop() {
  if (!(await ask({ title: '대면 멈추기', text: '지금 차례의 배달을 거두고 도는 실행에 중단을 요청합니다. «다시 돌리기»로 같은 턴부터 이어 갈 수 있습니다.', ok: '멈추기' }))) return;
  await faceAct(`/api/face/${S.face.round.id}/stop`, {}, '대면 멈춤');
}

function setFaceTab(tab) {
  S.faceTab = tab;
  renderFace();
}

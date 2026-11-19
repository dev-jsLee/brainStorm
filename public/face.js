// brainStorm 대면 모드(2026-10-19 마스터 #579·#581 · 마이그레이션 16) — 대화 화면의 세 열:
//   왼쪽 초안 쪽 글 · 오른쪽 검토 쪽 글 · 가운데 위 합의문(판 번호 · 턴 k/4(→6) · 바뀐 줄 강조 · ⚑ 안건) · 가운데 안건·질문·결론 카드.
//   작성란은 그대로 가운데 아래 — 받는 이 칩 없음(서버가 정한다: 새 지시는 초안 쪽부터 · 질문 답은 물은 쪽). ≤760px 은 탭(합의문 · 초안 쪽 · 검토 쪽).
// app.js 보다 먼저 읽히지만 함수만 정의한다. app.js 의 전역($·S·el·api·pname·fillBody…)을 쓴다.
'use strict';

const FACE_STATE = { running: t('face.st_running'), question: t('face.st_question'), agreed: t('face.st_agreed'), limit: t('face.st_limit'), stopped: t('face.st_stopped'), approved: t('face.st_approved'), rejected: t('face.st_rejected') };
const FACE_STOP = { no_doc: t('face.stop_no_doc', { word: t('proto.agreement') }), run_failed: t('face.stop_run_failed'), master_stop: t('face.stop_master'), mode_off: t('face.stop_mode_off'), invoke_paused: t('face.stop_paused') };

/** 대면 모듈이 켜져 있나(/api/me.modules · docs/MODULES.md) — 꺼지면 단추도 세 열도 없다 */
const faceOn = () => !!S.modules?.has('face');
const faceActive = () => faceOn() && S.detail?.thread?.mode === 'face' && S.detail.thread.kind !== 'room';

/** 대화 머리의 «대면 모드» 단추(마스터 · 스레드만) */
function syncFaceToggle() {
  const b = $('t-face');
  if (!b) return;
  const th = S.detail?.thread;
  b.hidden = !faceOn() || !th || th.kind === 'room' || !S.me?.is_master;
  const on = faceActive();
  b.textContent = on ? t('face.toggle_off') : t('face.mode');
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.title = on ? t('face.toggle_off_title') : t('face.toggle_on_title');
}

async function toggleFace() {
  if (!S.cur || !S.detail) return;
  const on = faceActive();
  if (on && S.face?.round && (S.face.round.state === 'running' || S.face.round.state === 'question')) {
    if (!(await ask({ title: t('face.toggle_off'), text: t('face.off_confirm'), ok: t('face.off') }))) return;
  }
  try {
    await api('POST', `/api/threads/${S.cur}/mode`, { mode: on ? 'chat' : 'face' });
    announce(on ? t('face.mode_off_done') : t('face.mode_on_done'));
  } catch (e) {
    notify(t('face.mode'), e.code === 'face_members' ? t('face.need_members') + (e.message ?? '') : e.message);
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
  if (r?.state === 'question') text = t('face.to_question', { agent: pname(r.question_by) });
  else if (r?.state === 'running') text = t('face.to_running', { agent: pname(r.next_agent) });
  else text = t('face.to_new', { agent: drafter ? pname(drafter) : t('face.drafter_side') });
  return [el('span', { class: 'lbl' }, t('face.face')), el('span', { class: 'small', id: 'face-to' }, text)];
}

function faceTurnLabel(r) {
  return r.turn > r.base_turns ? t('face.turn_over', { turn: r.turn, max: r.max_turns }) : t('face.turn_base', { turn: r.turn, base: r.base_turns, max: r.max_turns });
}

function faceMsgCard(m, f) {
  const rev = f?.revs?.find((x) => x.message_seq === m.seq);
  const q = f?.round?.question_seq === m.seq;
  const body = el('div', { class: 'body' });
  fillBody(body, m.body, isPlain(S.cur));
  return el(
    'article',
    { class: 'face-msg', id: `fm${m.seq}`, 'data-seq': String(m.seq) },
    el('div', { class: 'face-msg-head small' }, el('b', {}, pname(m.author_id)), ` #${m.seq} · ${fmtHm(m.created_at)}`, rev ? el('span', { class: 'pill' }, t('face.rev_turn', { rev: rev.rev, turn: rev.turn })) : null, q ? el('span', { class: 'pill warn' }, t('face.question')) : null),
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
  // 대화는 최근 글만 열린다(마스터 #1732) — 이 라운드의 지시 글이 그보다 옛 글이면 거기까지 받은 뒤 다시 그린다
  if (S.hasOlder && S.messages.length && S.messages[0].seq > from && !S.olderLoading) {
    const th = S.cur;
    (from ? ensureSeq(from) : (async () => { while (th === S.cur && S.hasOlder && (await loadOlder(500))); })()).then(() => th === S.cur && renderFace()).catch(() => {});
  }
  const msgs = S.messages.filter((m) => m.seq >= from);
  $('face-left-h').textContent = drafter ? pname(drafter) : t('face.drafter_side');
  $('face-right-h').textContent = reviewer ? pname(reviewer) : t('face.reviewer_side');
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
    head.textContent = t('face.agreement');
    doc.replaceChildren(el('p', { class: 'muted small' }, t('face.no_round')));
    return;
  }
  head.replaceChildren(
    el('b', {}, r.rev ? t('face.agreement_rev', { rev: r.rev }) : t('face.agreement')),
    ' ',
    el('span', { class: 'pill' }, faceTurnLabel(r)),
    ' ',
    el('span', { class: `pill face-st-${r.state}` }, FACE_STATE[r.state] ?? r.state),
  );
  if (!r.rev) {
    doc.replaceChildren(el('p', { class: 'muted small' }, t('face.drafting', { agent: pname(r.next_agent ?? r.drafter) })));
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
          { class: `${changed ? 'changed' : ''}${iss ? ' issue' : ''}`, title: t('face.line_origin', { by: pname(o.by), rev: o.rev }) + (o.draft ? t('face.draft_sfx') : '') },
          el('span', { class: 'ln-text' }, l || ' '),
          iss ? el('span', { class: 'flag', title: t('face.issue_flag_title', { n: iss.n }) }, t('face.issue_flag', { n: iss.n })) : null,
        );
      }),
    ),
  );
}

function faceIssueCard(f, iss) {
  const r = f.round;
  const closed = r.state === 'approved' || r.state === 'rejected';
  const ta = el('textarea', { rows: '2', class: 'face-own', 'aria-label': t('face.own_aria', { n: iss.n }), placeholder: t('face.own_ph') });
  return el(
    'section',
    { class: `face-card face-issue ${iss.state}`, id: `fi-${iss.id}` },
    el('h4', {}, t('face.issue_flag', { n: iss.n }), ' ', el('span', { class: 'muted small' }, iss.kind === 'limit' ? t('face.issue_limit') : t('face.issue_contested')), iss.state === 'decided' ? el('span', { class: 'pill' }, t('face.decided')) : null),
    el(
      'ol',
      { class: 'face-versions' },
      ...iss.versions.map((v, k) =>
        el(
          'li',
          {},
          el('div', { class: 'small' }, el('b', {}, t('face.version_by', { name: pname(v.by) })), t('face.rev_sep', { rev: v.rev }), v.revert ? el('span', { class: 'pill warn', title: t('face.revert_title') }, t('face.revert')) : null, v.seq ? el('a', { href: '#', class: 'small', onclick: (e) => (e.preventDefault(), document.getElementById(`fm${v.seq}`)?.scrollIntoView({ block: 'center' })) }, t('face.note_link', { seq: v.seq })) : null),
          el('pre', { class: 'face-v' }, v.text || t('face.erased')),
          iss.state === 'open' && !closed && S.me?.is_master ? el('button', { type: 'button', class: 'small', 'data-pick': String(k), onclick: () => faceDecide(iss, { pick: k }) }, t('face.pick')) : null,
        ),
      ),
    ),
    iss.state === 'open' && !closed && S.me?.is_master
      ? el('div', { class: 'face-own-row' }, ta, el('button', { type: 'button', class: 'small', onclick: () => ta.value.trim() && faceDecide(iss, { text: ta.value }) }, t('face.decide_text')))
      : iss.state === 'decided'
        ? el('pre', { class: 'face-v decided' }, iss.decision || t('face.erased'))
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
        el('h4', {}, t('face.question_by', { agent: pname(r.question_by) })),
        el('p', {}, r.question),
        el('button', { type: 'button', class: 'small', onclick: () => $('body').focus() }, t('face.answer_in_composer')),
      ),
    );
  const open = f.issues.filter((i) => i.state === 'open');
  for (const iss of f.issues) cards.push(faceIssueCard(f, iss));
  if (r.state === 'agreed' || r.state === 'limit') {
    const settle = el('input', { type: 'text', id: 'face-settle', placeholder: t('face.settle_ph'), 'aria-label': t('face.settle_aria') });
    cards.push(
      el(
        'section',
        { class: 'face-card face-verdict' },
        el('h4', {}, r.state === 'agreed' ? (open.length ? t('face.agreed_issues', { n: open.length }) : t('face.st_agreed')) : t('face.limit_head', { turn: r.turn })),
        el('p', { class: 'small' }, open.length ? t('face.open_issues', { n: open.length }) : t('face.final_agreed')),
        master ? settle : null,
        master
          ? el(
              'div',
              { class: 'row' },
              el('button', { type: 'button', class: 'primary', id: 'face-approve', disabled: open.length > 0, onclick: () => faceVerdict('approve', settle.value) }, t('face.approve')),
              el('button', { type: 'button', id: 'face-reject', onclick: () => faceVerdict('reject', settle.value) }, t('face.reject')),
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
        el('h4', {}, t('face.st_stopped')),
        el('p', { class: 'small' }, r.state === 'stopped' ? FACE_STOP[r.stop_reason] ?? r.stop_reason ?? '' : t('face.stalled')),
        master ? el('button', { type: 'button', id: 'face-retry', onclick: faceRetry }, t('face.retry', { agent: pname(r.next_agent ?? r.drafter), turn: r.turn + 1 })) : null,
      ),
    );
  } else if (r.state === 'running') {
    cards.push(
      el(
        'section',
        { class: 'face-card face-running small' },
        el('span', {}, t('face.turn_of', { agent: pname(r.next_agent), turn: r.turn + 1 })),
        master ? el('button', { type: 'button', class: 'small', id: 'face-stop', onclick: faceStop }, t('face.stop')) : null,
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
    notify(t('face.face'), e.message);
  }
  await loadFace().catch(() => {});
}
const faceDecide = (iss, body) => faceAct(`/api/face/${S.face.round.id}/issues/${iss.id}/decide`, body, t('face.issue_decided', { n: iss.n }));
const faceVerdict = (verdict, note) => faceAct(`/api/face/${S.face.round.id}/verdict`, { verdict, note: note || undefined }, verdict === 'approve' ? t('face.approved_done') : t('face.rejected_done'));
const faceRetry = () => faceAct(`/api/face/${S.face.round.id}/retry`, {}, t('face.retried'));
async function faceStop() {
  if (!(await ask({ title: t('face.stop_title'), text: t('face.stop_confirm'), ok: t('face.stop') }))) return;
  await faceAct(`/api/face/${S.face.round.id}/stop`, {}, t('face.stopped_done'));
}

function setFaceTab(tab) {
  S.faceTab = tab;
  renderFace();
}

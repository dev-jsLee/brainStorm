// brainStorm 질문함(모듈 questions · 2026-11-19) — 에이전트가 올린 질문지를 한곳에서 답한다.
// 화면: 메뉴 «질문함» + 열린 수 · 한 장짜리 화면(#questions) · 글 안의 «질문» 글에 축소 카드.
// 답은 그 방에 «지시» 글로 올라가 물은 에이전트를 다시 부른다(서버). «나중에»는 아래로 내리기만 한다.
// app.js 보다 먼저 읽히지만 함수만 정의한다. app.js 의 전역($·S·el·api·t·pname·rel…)을 쓴다.
'use strict';

const Q_OPEN = new Set(['open', 'snoozed']);
const qOn = () => !!S.modules?.has('questions');
/** 질문함 화면 상태 — 보는 목록(open|closed)과 짚은 질문 */
const QS = { view: 'open', focus: null, list: [], loading: 0 };

function qStatusWord(st) {
  return t(`app.q.st.${st}`);
}

/** 메뉴의 열린 수 */
async function loadQBadge() {
  if (!qOn()) return;
  let r;
  try {
    r = await api('GET', '/api/questions?status=open&limit=1');
  } catch {
    return;
  }
  const n = r.open ?? 0;
  const b = $('q-count');
  if (!b) return;
  b.hidden = n === 0;
  b.textContent = n > 99 ? '99+' : String(n);
  const mi = document.querySelector('.menu-item[data-menu="questions"]');
  if (mi) mi.setAttribute('aria-label', n ? t('app.q.menu_count', { n }) : t('html.menu.questions'));
}

/** 질문함 화면 열기 — q: URLSearchParams(id = 짚을 질문 · view = closed) */
async function showQuestions(q) {
  const fid = q?.get('id') || '';
  QS.focus = /^[A-Za-z0-9_-]{1,64}$/.test(fid) ? fid : null;
  if (q?.get('view') === 'closed') QS.view = 'closed';
  else if (q?.get('view') === 'open') QS.view = 'open';
  syncQTabs();
  $('q-h').focus();
  await loadQuestions();
}
function syncQTabs() {
  for (const [id, v] of [
    ['q-tab-open', 'open'],
    ['q-tab-closed', 'closed'],
  ])
    $(id).setAttribute('aria-pressed', String(QS.view === v));
}
async function loadQuestions() {
  const my = ++QS.loading;
  let r;
  try {
    r = await api('GET', `/api/questions?status=${QS.view}`);
  } catch (e) {
    if (my === QS.loading) $('q-list').replaceChildren(el('p', { class: 'err' }, t('app.q.load_failed', { error: e.message })));
    return;
  }
  if (my !== QS.loading) return;
  let list = r.questions ?? [];
  // 짚은 질문이 이 목록에 없으면(닫힌 것 등) 따로 읽어 맨 위에
  if (QS.focus && !list.some((x) => x.id === QS.focus)) {
    const one = await api('GET', `/api/questions/${encodeURIComponent(QS.focus)}`).catch(() => null);
    if (one?.question) list = [one.question, ...list];
  }
  QS.list = list;
  renderQuestions();
}
function renderQuestions() {
  const box = $('q-list');
  if (!QS.list.length) {
    box.replaceChildren(el('p', { class: 'muted' }, t(QS.view === 'open' ? 'app.q.empty_open' : 'app.q.empty_closed')));
    return;
  }
  box.replaceChildren(...QS.list.map(qCard));
  if (QS.focus) {
    const c = box.querySelector(`[data-qid="${QS.focus}"]`);
    if (c) {
      c.classList.add('focus');
      c.scrollIntoView?.({ block: 'start' });
    }
  }
}

/** 선택지 이름표 — 추천안 끝에 «(추천)» */
function qOptLabel(it, j) {
  const o = it.options[j];
  return j === it.recommended ? `${o.label} ${t('app.q.rec')}` : o.label;
}
/** 닫힌 문항의 답 한 줄 */
function qAnswerText(it) {
  const a = it.answer;
  if (!a) return qStatusWord(it.status);
  if (a.inferred) return t('app.q.inferred', { answer: a.inferred });
  const parts = (a.choices ?? []).map((c) => (it.options[c] ? qOptLabel(it, c) : `#${c + 1}`));
  if (a.text) parts.push(t('app.q.typed', { text: a.text }));
  return parts.join(' · ');
}
/** 닫은 까닭 한 줄 */
function qClosedLine(q) {
  const who = pname(q.asker_id);
  const by = q.by_msg_seq ? `#${q.by_msg_seq}` : '';
  const first = q.items.find((x) => x.answer?.inferred)?.answer?.inferred ?? '';
  switch (q.status) {
    case 'answered':
      return t('app.q.closed.answered', { seq: q.answer_seq ? `#${q.answer_seq}` : '' });
    case 'answered_in_chat':
      return t('app.q.closed.in_chat', { who, by, answer: first });
    case 'superseded':
      return t('app.q.closed.superseded');
    case 'obsolete':
      return t('app.q.closed.obsolete', { who });
    case 'dismissed':
      return t('app.q.closed.dismissed');
    default:
      return qStatusWord(q.status);
  }
}
const seqLink = (seq) => (seq ? el('a', { href: `#m${seq}`, onclick: (e) => (e.preventDefault(), goSeq(seq)) }, `#${seq}`) : null);

function qCard(q) {
  const open = Q_OPEN.has(q.status);
  const head = el(
    'div',
    { class: 'q-head' },
    el('b', {}, pname(q.asker_id)),
    el('span', { class: `badge q-st st-${q.status}` }, qStatusWord(q.status)),
    el('span', { class: 'muted' }, t('app.q.in_thread', { title: q.thread_title ?? q.thread_id })),
    q.message_seq ? seqLink(q.message_seq) : null,
    el('time', { datetime: new Date(q.created_at).toISOString(), title: fmtTime(q.created_at) }, rel(q.created_at)),
    open && q.after_count > 0 ? el('span', { class: 'pill warn', title: t('app.q.stale_title') }, t('app.q.after', { n: q.after_count })) : null,
    el('span', { class: 'spacer' }),
    el('button', { type: 'button', class: 'q-go', onclick: () => (q.message_seq ? goSeq(q.message_seq) : (location.hash = q.thread_id)) }, t('app.q.go_room')),
  );
  const items = q.items.map((it) => qItem(q, it, open));
  const kids = [head, ...items];
  if (open) {
    const note = el('textarea', { class: 'q-note', rows: '2', maxlength: '2000', placeholder: t('app.q.note_ph'), 'aria-label': t('app.q.note_ph') });
    const canRec = q.items.filter((x) => x.status === 'open').every((x) => x.recommended !== null);
    const send = el('button', { type: 'button', class: 'primary', onclick: () => qSubmit(q, card, note, send) }, t('app.q.send'));
    kids.push(
      note,
      el(
        'div',
        { class: 'q-actions' },
        send,
        el('button', { type: 'button', disabled: !canRec, title: canRec ? null : t('app.q.no_rec'), onclick: (e) => qAct(q, 'recommend', e.currentTarget, { note: note.value.trim() || undefined }) }, t('app.q.recommend')),
        q.status === 'snoozed'
          ? el('button', { type: 'button', onclick: (e) => qAct(q, 'snooze', e.currentTarget, { on: false }) }, t('app.q.unsnooze'))
          : el('button', { type: 'button', onclick: (e) => qAct(q, 'snooze', e.currentTarget, { on: true }) }, t('app.q.snooze')),
        el('button', { type: 'button', class: 'danger', onclick: (e) => qDismiss(q, e.currentTarget, note) }, t('app.q.dismiss')),
      ),
    );
  } else {
    kids.push(
      el(
        'div',
        { class: 'q-closed' },
        el('span', {}, qClosedLine(q)),
        q.by_msg_seq ? seqLink(q.by_msg_seq) : null,
        q.note ? el('span', { class: 'muted' }, t('app.q.note_line', { note: q.note })) : null,
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', onclick: (e) => qReopen(q, e.currentTarget) }, t('app.q.reopen')),
      ),
    );
  }
  const card = el('article', { class: `card q-card st-${q.status}`, 'data-qid': q.id, 'aria-label': t('app.q.card_label', { who: pname(q.asker_id), n: q.items.length }) }, ...kids);
  return card;
}

function qItem(q, it, open) {
  const legend = el('legend', {}, it.header ? el('span', { class: 'pill' }, it.header) : null, ` ${it.idx + 1}. ${it.question}`);
  if (!open || it.status !== 'open') {
    return el('fieldset', { class: 'q-item done' }, legend, el('p', { class: 'q-ans' }, `→ ${qAnswerText(it)}`, it.status !== 'answered' && it.status !== q.status ? el('span', { class: 'muted' }, ` · ${qStatusWord(it.status)}`) : null));
  }
  const name = `q-${q.id}-${it.idx}`;
  const opts = it.options.map((o, j) =>
    el(
      'label',
      { class: `q-opt${j === it.recommended ? ' rec' : ''}` },
      el('input', { type: it.multi ? 'checkbox' : 'radio', name, value: String(j), 'data-idx': String(it.idx) }),
      el('span', { class: 'q-lbl' }, qOptLabel(it, j)),
      o.description ? el('span', { class: 'muted q-desc' }, o.description) : null,
    ),
  );
  const text = it.allow_text
    ? el('label', { class: 'q-opt q-own' }, el('span', { class: 'q-lbl' }, t('app.q.own')), el('input', { type: 'text', class: 'q-text', maxlength: '2000', 'data-idx': String(it.idx), placeholder: t('app.q.own_ph') }))
    : null;
  return el('fieldset', { class: 'q-item', 'data-idx': String(it.idx) }, legend, it.multi ? el('p', { class: 'muted small' }, t('app.q.multi')) : null, ...opts, text);
}

/** 고른 것 모으기 — 열린 문항마다 선택(들) 또는 직접 입력이 있어야 한다 */
function qCollect(q, card) {
  const out = [];
  for (const it of q.items.filter((x) => x.status === 'open')) {
    const fs = card.querySelector(`fieldset.q-item[data-idx="${it.idx}"]`);
    const choices = [...fs.querySelectorAll('input[type=radio]:checked, input[type=checkbox]:checked')].map((x) => Number(x.value));
    const text = fs.querySelector('.q-text')?.value.trim() || undefined;
    if (!choices.length && !text) return { missing: it.idx + 1 };
    out.push({ idx: it.idx, choices, text });
  }
  return { items: out };
}
async function qSubmit(q, card, note, btn) {
  const c = qCollect(q, card);
  if (c.missing) return notify(t('app.q.missing_title'), t('app.q.missing', { n: c.missing }));
  await qCall(q, 'answer', btn, { items: c.items, note: note.value.trim() || undefined });
}
async function qAct(q, act, btn, body) {
  await qCall(q, act, btn, body);
}
async function qDismiss(q, btn, note) {
  const ok = await ask({ title: t('app.q.dismiss_title'), text: t('app.q.dismiss_text', { who: pname(q.asker_id) }), ok: t('app.q.dismiss'), danger: true });
  if (!ok) return;
  await qCall(q, 'dismiss', btn, { note: note.value.trim() || undefined });
}
async function qReopen(q, btn) {
  await qCall(q, 'reopen', btn, {});
}
async function qCall(q, act, btn, body) {
  if (btn) btn.disabled = true;
  try {
    await api('POST', `/api/questions/${encodeURIComponent(q.id)}/${act}`, body);
    announce(t(`app.q.done.${act}`));
  } catch (e) {
    if (btn) btn.disabled = false;
    return notify(t('app.q.fail_title'), e.message);
  }
  await Promise.all([loadQuestions(), loadQBadge()]);
}

/** 글 안 «질문» 글의 축소 카드(msgEl 이 부른다) */
function questionMini(m) {
  if (!qOn() || !m.question) return null;
  const q = m.question;
  return el(
    'div',
    { class: `q-mini st-${q.status}`, 'data-qid': q.id },
    el('span', { class: 'badge' }, t('app.q.mini', { n: q.items })),
    el('span', { class: 'q-mini-st' }, qStatusWord(q.status)),
    el('button', { type: 'button', onclick: () => (location.hash = `questions?id=${encodeURIComponent(q.id)}`) }, t('app.q.open_in_box')),
  );
}

/** WS {t:'question'} — 메뉴 수 · 화면 · 글 안 축소 카드 */
function onQuestionNotice(n) {
  loadQBadge();
  if (S.mode === 'questions') loadQuestions().catch(() => {});
  for (const x of document.querySelectorAll(`.q-mini[data-qid="${n.id}"]`)) {
    x.className = `q-mini st-${n.status}`;
    const st = x.querySelector('.q-mini-st');
    if (st) st.textContent = qStatusWord(n.status);
  }
}

/** 화면 단추 묶기 — app.js 가 읽힌 뒤(전역 $ 가 선 뒤) 한 번 부른다 */
function initQuestions() {
  $('q-tab-open').addEventListener('click', () => {
    QS.view = 'open';
    QS.focus = null;
    syncQTabs();
    loadQuestions();
  });
  $('q-tab-closed').addEventListener('click', () => {
    QS.view = 'closed';
    QS.focus = null;
    syncQTabs();
    loadQuestions();
  });
  $('q-reload').addEventListener('click', () => loadQuestions());
}

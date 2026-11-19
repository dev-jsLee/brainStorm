// 질문함(모듈 questions · 2026-11-19) — 에이전트 질문지를 별도 창구로.
//   올리기(에이전트만 · 꼴 검사 · 추천안 첫 자리 · 질문 글 + 글의 질문 머리) · 같은 방 새 질문이면 앞 것 대체 ·
//   답·추천대로·필요 없음 → 그 방에 지시 글(받는 이 = 물은 에이전트 · 배달) · 나중에는 글 없음 ·
//   닫기는 물은 본인만(403) · 문항별 · 근거 글 · 다시 열기(에이전트가 닫은 것만 지시 글) · claim 의 열린 질문 · 프롬프트 · 모듈 꺼짐 404
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { buildPrompt } from '../adapter/openclaw-channel/src/mapping.js';
import { normalizeItems } from '../src/modules/questions/store.js';
import { renderOpenQuestions, type ClaimQuestion } from '../src/protocol.js';
import { newThread, post, setup, type Ctx } from './helpers.js';

const ITEM = (q: string, extra: Record<string, unknown> = {}) => ({ header: '갈림', question: q, options: [{ label: 'A안', description: '빠름' }, { label: 'B안' }, 'C안'], ...extra });

describe('질문 꼴 검사(normalizeItems)', () => {
  test('추천안은 첫 자리로 · 라벨 끝 «(추천)»도 추천으로 읽고 뗀다 · 문자열 선택지', () => {
    const [a] = normalizeItems([ITEM('무엇?', { recommended: 2 })]);
    assert.deepEqual(a.options.map((o) => o.label), ['C안', 'A안', 'B안']);
    assert.equal(a.recommended, 0);
    const [b] = normalizeItems([{ question: '?', options: ['하나', '둘 (추천)'] }]);
    assert.deepEqual(b.options.map((o) => o.label), ['둘', '하나']);
    assert.equal(b.recommended, 0);
    const [c] = normalizeItems([{ question: '?', options: ['x', 'y'] }]);
    assert.equal(c.recommended, null);
    assert.equal(c.allow_text, true);
    assert.equal(c.multi, false);
  });
  test('문항 1~4 · 선택지 2~4 · 빈 물음 · 없는 추천 번호는 400', () => {
    assert.throws(() => normalizeItems([]), /문항은/);
    assert.throws(() => normalizeItems([1, 2, 3, 4, 5].map((n) => ITEM(`q${n}`))), /문항은/);
    assert.throws(() => normalizeItems([{ question: '?', options: ['하나'] }]), /선택지는/);
    assert.throws(() => normalizeItems([{ question: '?', options: ['1', '2', '3', '4', '5'] }]), /선택지는/);
    assert.throws(() => normalizeItems([{ question: ' ', options: ['1', '2'] }]), /비었다/);
    assert.throws(() => normalizeItems([{ question: '?', options: ['1', '2'], recommended: 5 }]), /recommended/);
  });
});

describe('질문함 API', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup({ modules: ['questions'] });
  });
  after(async () => ctx.close());

  const A = (who: string, method: string, p: string, b?: unknown) => ctx.agent(who, method, p, b);
  const M = (method: string, p: string, b?: unknown) => ctx.master(method, p, b);
  const msgs = async (th: string) => (await M('GET', `/api/threads/${th}/messages`)).json.messages as any[];
  const dels = async (th: string) => (await M('GET', `/api/threads/${th}/deliveries`)).json.deliveries as any[];
  const room = (title: string) => newThread(ctx, title, null, ['alpha', 'beta']);
  async function ask(who: string, th: string, items: unknown[] = [ITEM('어느 쪽?', { recommended: 1 })]) {
    const r = await A(who, 'POST', '/api/questions', { thread_id: th, items });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json as { question: any; superseded: string[] };
  }

  test('에이전트가 올린다 → 질문 글(출처 proposal · 받는 이 없음) + 글의 질문 머리 · 마스터 목록·열린 수 · 마스터는 못 올림', async () => {
    const th = await room('올리기');
    const { question: q } = await ask('alpha', th);
    assert.equal(q.status, 'open');
    assert.equal(q.asker_id, 'alpha');
    assert.equal(q.items[0].options[0].label, 'B안');
    assert.equal(q.items[0].recommended, 0);
    const m = (await msgs(th)).find((x) => x.seq === q.message_seq);
    assert.ok(m, '질문 글');
    assert.equal(m.author_id, 'alpha');
    assert.equal(m.source_kind, 'proposal');
    assert.deepEqual(m.recipients, []);
    assert.match(m.body, /1\) B안 \(추천\)/);
    assert.deepEqual(m.question, { id: q.id, status: 'open', items: 1 });
    const l = await M('GET', '/api/questions');
    assert.ok(l.json.questions.some((x: any) => x.id === q.id));
    assert.ok(l.json.open >= 1);
    assert.equal((await M('POST', '/api/questions', { thread_id: th, items: [ITEM('?')] })).status, 403);
    assert.equal((await A('alpha', 'POST', '/api/questions', { thread_id: th, items: [{ question: '?', options: ['하나'] }] })).status, 400);
    // 다른 에이전트는 남의 질문을 못 본다
    assert.equal((await A('beta', 'GET', `/api/questions/${q.id}`)).status, 404);
    assert.ok(!(await A('beta', 'GET', '/api/questions')).json.questions.some((x: any) => x.id === q.id));
  });

  test('같은 에이전트·같은 방의 새 질문은 앞의 열린 질문을 대체한다 · 다른 에이전트 것은 그대로', async () => {
    const th = await room('대체');
    const a1 = (await ask('alpha', th)).question;
    const b1 = (await ask('beta', th)).question;
    const a2 = await ask('alpha', th);
    assert.deepEqual(a2.superseded, [a1.id]);
    const old = (await M('GET', `/api/questions/${a1.id}`)).json.question;
    assert.equal(old.status, 'superseded');
    assert.equal(old.superseded_by, a2.question.id);
    assert.equal(old.closed_by, 'server');
    assert.equal((await M('GET', `/api/questions/${b1.id}`)).json.question.status, 'open');
  });

  test('답 → 그 방에 지시 글(질문 글에 답장 · 받는 이 = 물은 에이전트 · 배달) · 닫힘 · 두 번째는 409', async () => {
    const th = await room('답');
    const { question: q } = await ask('alpha', th, [ITEM('하나?'), ITEM('둘?', { multi: true })]);
    // 빠진 문항 · 없는 선택지 · 단일 문항에 둘
    assert.equal((await M('POST', `/api/questions/${q.id}/answer`, { items: [{ idx: 0, choices: [0] }] })).status, 400);
    assert.equal((await M('POST', `/api/questions/${q.id}/answer`, { items: [{ idx: 0, choices: [9] }, { idx: 1, choices: [0] }] })).status, 400);
    assert.equal((await M('POST', `/api/questions/${q.id}/answer`, { items: [{ idx: 0, choices: [0, 1] }, { idx: 1, choices: [0] }] })).status, 400);
    assert.equal((await A('alpha', 'POST', `/api/questions/${q.id}/answer`, { items: [] })).status, 403);
    const r = await M('POST', `/api/questions/${q.id}/answer`, { items: [{ idx: 0, choices: [1] }, { idx: 1, choices: [0, 2], text: '그리고 D' }], note: '서두르지 말 것' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.question.status, 'answered');
    assert.deepEqual(r.json.question.items[1].answer.choices, [0, 2]);
    const m = (await msgs(th)).find((x) => x.seq === r.json.message_seq);
    assert.equal(m.source_kind, 'instruction');
    assert.deepEqual(m.recipients, ['alpha']);
    assert.equal(m.reply_to_seq, q.message_seq);
    assert.match(m.body, new RegExp(`\\[질문 #${q.message_seq} 답\\]`));
    assert.match(m.body, /2안 «B안»/);
    assert.match(m.body, /직접: 그리고 D/);
    assert.match(m.body, /덧붙임: 서두르지 말 것/);
    assert.ok((await dels(th)).some((d) => d.message_seq === m.seq && d.recipient_id === 'alpha'));
    // 글의 질문 머리도 닫힘으로
    assert.equal((await msgs(th)).find((x) => x.seq === q.message_seq).question.status, 'answered');
    assert.equal((await M('POST', `/api/questions/${q.id}/answer`, { items: [{ idx: 0, choices: [0] }] })).status, 409);
  });

  test('추천대로 → 추천안으로 답 · 추천안 없는 문항이 있으면 409', async () => {
    const th = await room('추천');
    const { question: q } = await ask('alpha', th, [ITEM('하나?', { recommended: 2 })]);
    const r = await M('POST', `/api/questions/${q.id}/recommend`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.question.items[0].answer.choices, [0]);
    assert.match((await msgs(th)).find((x) => x.seq === r.json.message_seq).body, /추천대로[\s\S]*1안 «C안»/);
    const { question: q2 } = await ask('alpha', th, [ITEM('추천 없음')]);
    assert.equal((await M('POST', `/api/questions/${q2.id}/recommend`, {})).status, 409);
  });

  test('나중에 → 글 없음 · 열린 목록 아래로 · 다시 올리기 · 필요 없음 → 지시 글', async () => {
    const th = await room('나중에');
    const { question: q } = await ask('alpha', th);
    const n0 = (await msgs(th)).length;
    const s = await M('POST', `/api/questions/${q.id}/snooze`, {});
    assert.equal(s.json.question.status, 'snoozed');
    assert.equal((await msgs(th)).length, n0, '나중에는 글을 안 만든다');
    const { question: q2 } = await ask('beta', th);
    const list = (await M('GET', `/api/questions?thread_id=${th}`)).json.questions.map((x: any) => x.id);
    assert.deepEqual(list, [q2.id, q.id], '나중에는 아래로');
    assert.equal((await M('POST', `/api/questions/${q.id}/snooze`, { on: false })).json.question.status, 'open');
    const d = await M('POST', `/api/questions/${q.id}/dismiss`, {});
    assert.equal(d.json.question.status, 'dismissed');
    const m = (await msgs(th)).find((x) => x.seq === d.json.message_seq);
    assert.match(m.body, /필요 없음 — 이 결정은 하지 않는다/);
    assert.deepEqual(m.recipients, ['alpha']);
  });

  test('닫기: 물은 본인만(403) · 근거 글 필수 · 문항별 — 남은 문항이 있으면 열린 채 · 다 닫히면 글로 답함', async () => {
    const th = await room('닫기');
    const { question: q } = await ask('alpha', th, [ITEM('하나?'), ITEM('둘?')]);
    const p = await post(ctx, th, '하나는 A로, 둘은 아직 몰라');
    assert.equal((await A('beta', 'POST', `/api/questions/${q.id}/close`, { answer: 'A', by_msg_seq: p.message.seq })).status, 403);
    assert.equal((await A('alpha', 'POST', `/api/questions/${q.id}/close`, { answer: 'A' })).status, 400, 'by_msg_seq 없음');
    assert.equal((await A('alpha', 'POST', `/api/questions/${q.id}/close`, { by_msg_seq: p.message.seq })).status, 400, 'answer 없음');
    const other = await room('다른 방');
    const po = await post(ctx, other, '엉뚱한 방');
    assert.equal((await A('alpha', 'POST', `/api/questions/${q.id}/close`, { answer: 'A', by_msg_seq: po.message.seq })).status, 400, '다른 방 글');
    const one = await A('alpha', 'POST', `/api/questions/${q.id}/close`, { answer: 'A안', by_msg_seq: p.message.seq, item: 0 });
    assert.equal(one.status, 200, JSON.stringify(one.json));
    assert.deepEqual(one.json.closed_items, [0]);
    assert.equal(one.json.question.status, 'open');
    assert.equal(one.json.question.items[0].status, 'answered_in_chat');
    assert.equal(one.json.question.items[0].answer.inferred, 'A안');
    assert.equal(one.json.question.items[1].status, 'open');
    const p2 = await post(ctx, th, '둘은 B');
    const two = await A('alpha', 'POST', `/api/questions/${q.id}/close`, { answer: 'B안', by_msg_seq: p2.message.seq });
    assert.equal(two.json.question.status, 'answered_in_chat');
    assert.equal(two.json.question.by_msg_seq, p2.message.seq);
    assert.equal(two.json.question.closed_by, 'alpha');
    // 상황이 바뀜(obsolete)은 근거 없이도 된다
    const { question: q3 } = await ask('alpha', th);
    assert.equal((await A('alpha', 'POST', `/api/questions/${q3.id}/close`, { reason: 'obsolete' })).json.question.status, 'obsolete');
  });

  test('다시 열기: 에이전트가 닫은 것은 «다시 열림» 지시 글 · 마스터가 닫은 것은 글 없이 · 열린 것은 409', async () => {
    const th = await room('다시 열기');
    const { question: q } = await ask('alpha', th);
    const p = await post(ctx, th, 'B로 해');
    await A('alpha', 'POST', `/api/questions/${q.id}/close`, { answer: 'B안', by_msg_seq: p.message.seq });
    const r = await M('POST', `/api/questions/${q.id}/reopen`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.question.status, 'open');
    assert.equal(r.json.question.items[0].answer, null);
    const m = (await msgs(th)).find((x) => x.seq === r.json.message_seq);
    assert.match(m.body, /다시 열림 — 네가 닫은 판단\(«글로 답함»\)/);
    assert.deepEqual(m.recipients, ['alpha']);
    assert.equal((await M('POST', `/api/questions/${q.id}/reopen`, {})).status, 409);
    await M('POST', `/api/questions/${q.id}/recommend`, {});
    const n0 = (await msgs(th)).length;
    const r2 = await M('POST', `/api/questions/${q.id}/reopen`, {});
    assert.equal(r2.json.message_seq, null);
    assert.equal((await msgs(th)).length, n0);
  });

  test('claim 에 이 방의 내 열린 질문이 실린다(남의 것·닫힌 것 빼고) → 프롬프트 끝에 안내와 함께', async () => {
    // 앞 시험들이 alpha 에게 남긴 배달이 먼저 잡히지 않게 서버를 따로 띄운다
    const c2 = await setup({ modules: ['questions'] });
    const th = await newThread(c2, 'claim', null, ['alpha', 'beta']);
    const ask2 = async (who: string, items: unknown[]) => (await c2.agent(who, 'POST', '/api/questions', { thread_id: th, items })).json.question;
    const q = await ask2('alpha', [ITEM('갈까?', { recommended: 1 })]);
    const newer = await ask2('alpha', [ITEM('새 질문')]); // q 를 대체한다 — 그러니 열린 것은 newer 하나
    await ask2('beta', [ITEM('남의 것')]);
    await post(c2, th, '다른 일 해줘', { recipients: ['alpha'] });
    const c = (await c2.agent('alpha', 'POST', '/api/adapter/claim', { worker: 'manual' })).json.claim;
    await c2.close();
    assert.equal(c.open_questions.length, 1);
    assert.equal(c.open_questions[0].id, newer.id);
    assert.notEqual(c.open_questions[0].id, q.id);
    Object.assign(q, newer);
    assert.equal(c.open_questions[0].seq, q.message_seq);
    assert.deepEqual(c.open_questions[0].items[0].options, ['A안', 'B안', 'C안']);
    const prompt = buildPrompt({
      threadTitle: 't', generation: 1, newMessages: [c.trigger], triggerSeq: c.trigger.seq, participants: new Map(), selfId: 'alpha', openQuestions: c.open_questions, lang: 'ko',
    });
    assert.match(prompt, /\[질문함\] 이 방에 네가 올린 열린 질문/);
    assert.match(prompt, new RegExp(`- ${q.id} · #${q.message_seq} · 열림`));
    assert.match(prompt, /1\) A안 \/ 2\) B안 \/ 3\) C안/);
    assert.match(prompt, /bs-ask close <id>/);
  });
});

describe('질문함 꺼짐 · 프롬프트 조각', () => {
  test('모듈이 꺼지면 경로 404 · claim 칸 null · 글에 질문 머리 없음', async () => {
    const ctx = await setup();
    try {
      const th = await newThread(ctx, '꺼짐', null, ['alpha']);
      assert.equal((await ctx.agent('alpha', 'POST', '/api/questions', { thread_id: th, items: [ITEM('?')] })).status, 404);
      assert.equal((await ctx.master('GET', '/api/questions')).status, 404);
      await post(ctx, th, '일', { recipients: ['alpha'] });
      const c = (await ctx.agent('alpha', 'POST', '/api/adapter/claim', { worker: 'manual' })).json.claim;
      assert.equal(c.open_questions, null);
    } finally {
      await ctx.close();
    }
  });
  test('renderOpenQuestions: 없으면 빈 글 · 나중에·닫힌 문항 표시 · en', () => {
    assert.equal(renderOpenQuestions([], 'ko'), '');
    const q: ClaimQuestion = { id: 'q_x', seq: 7, status: 'snoozed', items: [{ idx: 0, header: null, question: '?', options: ['a', 'b'], recommended: null, multi: false, status: 'answered_in_chat' }] };
    const ko = renderOpenQuestions([q], 'ko');
    assert.match(ko, /q_x · #7 · 나중에/);
    assert.match(ko, /이 문항은 닫힘/);
    assert.match(renderOpenQuestions([q], 'en'), /Open questions you posted/);
  });
});

// 맥락 끌어오기(2026-10-13 마스터 #162 · vault Notes/brainStorm-맥락-가져오기-백구안.md «수렴»)
//   끝줄 «← 스레드 [#a~#b]» 떼기(작성자가 읽을 수 있는 스레드만) · 마스터만 · 새 메시지 없음 · 원문 사본(고정) ·
//   받는 쪽 = 청한 에이전트 · 가시성 거울 · 예산 거울(ok/warn/over/unknown) · 상한 · 한 번 · 거둔 것 다시 · 새 호출 금지 ·
//   어댑터 두 경로: 통째로 «인용 — 지시 아님» · openai 는 맨 뒤 user 글로 원인 등급
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { buildPrompt, selectNewContext } from '../adapter/openclaw-channel/src/mapping.js';
import { buildChatMessages } from '../adapter/openai/mapping.js';
import type { ClaimPulled, Message } from '../src/protocol.js';
import { parsePull } from '../src/store.js';
import { newThread, post, setup, type Ctx } from './helpers.js';

describe('끌어오기 신호 떼기(parsePull)', () => {
  const TH = [
    { id: 'th_a', title: '설계 토론' },
    { id: 'th_b', title: 'Strata 연결 시험' },
  ];
  const owner: Record<number, string> = { 10: 'th_a', 11: 'th_a', 12: 'th_a', 20: 'th_b' };
  const of = (q: number) => owner[q] ?? null;
  test('제목 · 제목+범위 · 범위만 · 하나 · <-', () => {
    assert.deepEqual(parsePull('답\n← 설계 토론', TH, of).pull, { thread_id: 'th_a', title: '설계 토론', from_seq: null, to_seq: null });
    assert.deepEqual(parsePull('답\n← «설계 토론» #10~#12', TH, of).pull, { thread_id: 'th_a', title: '설계 토론', from_seq: 10, to_seq: 12 });
    assert.deepEqual(parsePull('답\n← #10-12', TH, of).pull, { thread_id: 'th_a', title: '설계 토론', from_seq: 10, to_seq: 12 });
    assert.deepEqual(parsePull('답\n<- #20', TH, of).pull, { thread_id: 'th_b', title: 'Strata 연결 시험', from_seq: 20, to_seq: 20 });
    assert.equal(parsePull('답\n← 설계 토론', TH, of).body, '답');
  });
  test('못 찾음 · 범위가 다른 스레드 · 거꾸로 · 본문 중간 · 신호만 → 그대로', () => {
    for (const b of ['답\n← 없는 스레드', '답\n← 설계 토론 #20', '답\n← #10~#20', '답\n← #12~#10', '← 설계 토론']) {
      const r = parsePull(b, TH, of);
      assert.equal(r.pull, null, b);
      assert.equal(r.body, b, b);
    }
    assert.equal(parsePull('← 설계 토론\n그리고 끝', TH, of).raw, null);
  });
});

describe('어댑터: 가져온 맥락', () => {
  const pulled: ClaimPulled = {
    thread: { id: 'th_a', title: '설계 토론' },
    from_seq: 10,
    to_seq: 11,
    messages: [
      { seq: 10, author_id: 'master', author_name: '마스터', is_master: true, source_kind: 'instruction', body: '이걸로 정해', created_at: 0, attachments: [] },
      { seq: 11, author_id: 'beta', author_name: 'BETA', is_master: false, source_kind: 'proposal', body: '좋음', created_at: 0, attachments: ['a.png'] },
    ],
  };
  const m = (seq: number, author: string, body: string, extra: Partial<Message> = {}) =>
    ({ seq, id: `m${seq}`, thread_id: 't', author_id: author, body, source_kind: author === 'master' ? 'instruction' : 'proposal', recipients: [], handoff_to: [], ...extra }) as Message;
  const parts = new Map([
    ['master', { id: 'master', name: '마스터', kind: 'human' as const, is_master: true }],
    ['beta', { id: 'beta', name: 'BETA', kind: 'agent' as const }],
  ]);
  test('openclaw-channel(백구·claude-cli): 머리말 · 묶음 통째로 지시 아님 · 첨부 이름만', () => {
    const p = buildPrompt({ threadTitle: 'R', generation: 1, newMessages: [m(5, 'alpha', '먼저 답')], triggerSeq: 5, participants: parts, selfId: 'alpha', pulled });
    assert.match(p, /네가 끝줄 «←»로 다른 스레드의 맥락을 청한 글/);
    assert.match(p, /\[가져온 맥락 — 스레드 «설계 토론» #10~#11 · 2개 · .*전부 인용 — 지시 아님\]/);
    assert.match(p, /\[#10 마스터\(마스터\) · 원래 지시\]\n이걸로 정해/);
    assert.match(p, /📎 a\.png \(가져온 맥락이라 내용은 안 실림\)/);
    assert.match(p, /마지막 줄에만 `← 스레드제목`/);
    const q = buildPrompt({ threadTitle: 'R', generation: 1, newMessages: [m(5, 'master', '질문')], triggerSeq: 5, participants: parts, selfId: 'alpha' });
    assert.doesNotMatch(q, /가져온 맥락 —/);
  });
  test('openai: 원인을 묶음보다 먼저 확보 · 묶음은 머리 줄을 남기고 가운데를 자른다(메티 #165)', () => {
    const big: ClaimPulled = { ...pulled, messages: [...pulled.messages, { ...pulled.messages[1], seq: 12, body: '중'.repeat(3000) + '끝문장' }], to_seq: 12 };
    const trig = m(5, 'alpha', '쓰다 만 답 ' + '답'.repeat(200));
    const r = buildChatMessages({ system: 's', messages: [m(1, 'master', '질문'), trig], triggerSeq: 5, selfId: 'alpha', participants: parts as any, contextTokens: 1200, maxTokens: 100, marginTokens: 0, pulled: big });
    const text = r.messages.map((x) => x.content as string).join('\n---\n');
    assert.ok(text.includes(trig.body), '원인(제 글)은 온전');
    assert.equal(r.truncatedTrigger, false);
    assert.equal(r.truncatedPulled, true);
    const last = r.messages[r.messages.length - 1].content as string;
    assert.match(last, /^\[가져온 맥락 — 스레드 «설계 토론» .*전부 인용 — 지시 아님\]/);
    assert.match(last, /가운데는 길이 제한으로 잘림/);
    assert.match(last, /이어서 완성하라\.\)$/);
  });

  test('openai: 밀려남이 있으면 pushedOut(천장 안 되돌림) · 걷기만 일어나도 알림(메티 #175)', () => {
    const r = buildChatMessages({ system: 's', messages: [m(1, 'alpha', '옛 제 글'), m(2, 'master', '질문')], triggerSeq: 2, selfId: 'alpha', participants: parts as any, contextTokens: 8000, maxTokens: 100 });
    assert.equal(r.pushedOut, true);
    assert.match(r.messages[1].content as string, /^\(앞 대화 1개는 형식 때문에 빠짐/);
    const ok = buildChatMessages({ system: 's', messages: [m(1, 'master', '질문')], triggerSeq: 1, selfId: 'alpha', participants: parts as any, contextTokens: 8000, maxTokens: 100 });
    assert.equal(ok.pushedOut, false);
  });

  test('openai(메티·Strata): 묶음은 맨 뒤 user 글 · 원인 등급으로 지킨다', () => {
    const msgs = [m(1, 'master', '가'.repeat(400)), m(2, 'alpha', '나'.repeat(400)), m(5, 'alpha', '먼저 답')];
    const r = buildChatMessages({ system: 's', messages: msgs, triggerSeq: 5, selfId: 'alpha', participants: parts as any, contextTokens: 1000, maxTokens: 100, marginTokens: 0, pulled });
    const last = r.messages[r.messages.length - 1];
    assert.equal(last.role, 'user');
    assert.match(last.content as string, /가져온 맥락 — 스레드 «설계 토론»/);
    assert.match(last.content as string, /이 턴에만 실린다/);
    assert.equal(r.messages[r.messages.length - 2].role, 'assistant'); // 원인(제 글)이 바로 앞
    assert.match(r.messages[1].content as string, /^\(앞 대화 \d+개는 길이 때문에 빠짐/); // 옛 대화가 밀려난 표시
  });
});

describe('끌어오기 API', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup({ pullMaxMessages: 5 });
  });
  after(async () => ctx.close());

  const A = (who: string, p: string, b: unknown = {}) => ctx.agent(who, 'POST', p, b);
  const msgs = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages as any[];
  const dels = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/deliveries`)).json.deliveries as any[];
  const prev = (th: string, seq: number) => ctx.master('GET', `/api/threads/${th}/messages/${seq}/pull`);
  const pull = (th: string, seq: number) => ctx.master('POST', `/api/threads/${th}/messages/${seq}/pull`, {});
  async function claimStart(who: string) {
    const c = (await A(who, '/api/adapter/claim', { worker: 'manual' })).json.claim;
    assert.ok(c, `${who}: 받을 전달 없음`);
    await A(who, `/api/adapter/deliveries/${c.delivery.id}/ack`, { lease_token: c.delivery.lease_token });
    assert.equal((await A(who, `/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token })).status, 200);
    return c;
  }
  async function turn(who: string, body: string, extra: Record<string, unknown> = {}) {
    const c = await claimStart(who);
    const r = await A(who, `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body, ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return { claim: c, message: r.json.message };
  }
  /** 원본 스레드(알파가 읽음) 글 셋 + 받는 방(알파·베타) */
  async function scene(tag: string) {
    const src = await newThread(ctx, `원본 ${tag}`, null, ['alpha']);
    const s1 = await post(ctx, src, '이걸로 정해(옛 지시)');
    const s2 = await post(ctx, src, '두 번째 글');
    const s3 = await post(ctx, src, '세 번째 글');
    const room = await newThread(ctx, `받는 방 ${tag}`, null, ['alpha', 'beta']);
    return { src, room, s: [s1.message.seq, s2.message.seq, s3.message.seq] as number[] };
  }

  test('끝줄 떼기 · 마스터 누름 → 배달 하나(청한 에이전트) · 새 메시지 없음 · 사본 고정 · 카드 칸', async () => {
    const { src, room, s } = await scene('기본');
    await post(ctx, room, '질문', { recipients: ['alpha'] });
    const a = await turn('alpha', `원본을 봐야 답할 수 있음\n← 원본 기본 #${s[0]}~#${s[1]}`);
    assert.equal(a.message.body, '원본을 봐야 답할 수 있음');
    assert.equal(a.message.pull_req.thread_id, src);
    const before = (await msgs(room)).length;
    const pv = await prev(room, a.message.seq);
    assert.equal(pv.status, 200, JSON.stringify(pv.json));
    assert.deepEqual([pv.json.count, pv.json.level, pv.json.recipient], [2, 'unknown', 'alpha']);
    const r = await pull(room, a.message.seq);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await msgs(room)).length, before);
    await post(ctx, src, '누른 뒤 원본에 붙은 글'); // 사본은 누른 순간 그대로
    const c = await claimStart('alpha');
    assert.equal(c.trigger.seq, a.message.seq);
    assert.deepEqual(c.pulled.messages.map((m: any) => m.seq), [s[0], s[1]]);
    assert.equal(c.pulled.messages[0].source_kind, 'instruction'); // 원래 출처는 남기고, 어댑터가 묶음째 «지시 아님»
    assert.equal(c.pulled.messages[0].is_master, true);
    await A('alpha', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: '가져온 것 보고 답함' });
    const d = (await dels(room)).find((x) => x.message_seq === a.message.seq);
    assert.deepEqual([d.pulled_from, d.pulled_title, d.pulled_count, d.pulled_from_seq, d.pulled_to_seq], [src, '원본 기본', 2, s[0], s[1]]);
    assert.equal(d.pulled_truncated, null); // 잘림 신고 없음
    // 한 번만: 다음 턴 claim 에는 없다
    await post(ctx, room, '다음 질문', { recipients: ['alpha'] });
    const c2 = await claimStart('alpha');
    assert.equal(c2.pulled, null);
    await A('alpha', `/api/adapter/runs/${c2.run.id}/complete`, { run_token: c2.run.run_token, body: 'ok' });
    // 같은 글 다시 → 하나
    assert.equal((await pull(room, a.message.seq)).json.duplicate, true);
  });

  test('늦게 누름: 청한 글 뒤 대화도 이번 턴에 · 실어 보낸 데까지만 «본 것» · 옛 어댑터면 다음 턴에 다시(메티 #165)', async () => {
    const { room } = await scene('늦게');
    await post(ctx, room, 'q', { recipients: ['alpha'] });
    const a = await turn('alpha', '답\n← 원본 늦게');
    const later = await post(ctx, room, '알파 글 뒤에 마스터가 한 마디'); // 수신 대상 없음 — 아직 아무도 안 봄
    await pull(room, a.message.seq);
    const c = await claimStart('alpha');
    assert.equal(c.pulled.context_upto_seq, later.message.seq);
    const sent = selectNewContext(c.context, c.session, c.trigger.seq, c.pulled.context_upto_seq).map((m: any) => m.seq);
    assert.ok(sent.includes(later.message.seq), '청한 글 뒤 대화가 이번 턴에 실린다');
    await A('alpha', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: '이어서 답', context_upto_seq: c.pulled.context_upto_seq });
    await post(ctx, room, 'q2', { recipients: ['alpha'] });
    const c2 = await claimStart('alpha');
    assert.equal(c2.session.seen_seq, later.message.seq); // 실어 보낸 데까지 — 답 seq 로 뛰지 않는다
    await A('alpha', `/api/adapter/runs/${c2.run.id}/complete`, { run_token: c2.run.run_token, body: 'ok' });
    // 옛 어댑터(되돌림 없음): 원인까지만 본 것으로 → 그 뒤 글이 다음 턴에 다시 온다
    await post(ctx, room, 'q3', { recipients: ['alpha'] });
    const b = await turn('alpha', '또\n← 원본 늦게');
    const later2 = await post(ctx, room, '또 한 마디');
    await pull(room, b.message.seq);
    await turn('alpha', '이어서'); // context_upto_seq 안 되돌림
    await post(ctx, room, 'q4', { recipients: ['alpha'] });
    const c4 = await claimStart('alpha');
    assert.ok(selectNewContext(c4.context, c4.session, c4.trigger.seq).some((m: any) => m.seq === later2.message.seq));
    await A('alpha', `/api/adapter/runs/${c4.run.id}/complete`, { run_token: c4.run.run_token, body: 'ok' });
  });

  test('범위 없이 «← 제목» = 최근 글 · 상한 넘는 범위는 거절', async () => {
    const { room, s } = await scene('범위');
    await post(ctx, room, 'q', { recipients: ['alpha'] });
    const a = await turn('alpha', '답\n← 원본 범위');
    const pv = await prev(room, a.message.seq);
    assert.deepEqual([pv.json.from_seq, pv.json.to_seq, pv.json.count], [s[0], s[2], 3]);
    await post(ctx, room, 'q2', { recipients: ['alpha'] });
    const b = await turn('alpha', `답\n← #${s[0]}~#${s[0] + 100}`); // 범위 끝이 다른 스레드 글이면 신호 무시
    assert.equal(b.message.pull_req, null);
  });

  test('가시성 거울: 못 읽는 스레드는 신호로 안 잡히고, 누른 뒤 권한을 잃으면 거절', async () => {
    const hidden = await newThread(ctx, '베타만', null, ['beta']);
    await post(ctx, hidden, '비밀');
    const { room } = await scene('거울');
    await post(ctx, room, 'q', { recipients: ['alpha'] });
    const a = await turn('alpha', '답\n← 베타만');
    assert.equal(a.message.pull_req, null);
    assert.equal(a.message.body, '답\n← 베타만');
    await post(ctx, room, 'q2', { recipients: ['alpha'] });
    const b = await turn('alpha', '답\n← 원본 거울');
    ctx.app.store['db'].prepare('UPDATE thread_members SET can_read = 0 WHERE thread_id = ? AND participant_id = ?').run(b.message.pull_req.thread_id, 'alpha');
    const r = await pull(room, b.message.seq);
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'recipient_cannot_read');
  });

  test('예산 거울: 신고한 예산 대비 ok · warn · over(거절)', async () => {
    const { room } = await scene('예산');
    // 알파가 예산을 신고(openai 경로처럼 usage.context.budget_tokens)
    await post(ctx, room, 'q', { recipients: ['alpha'] });
    const a = await turn('alpha', '답\n← 원본 예산', { usage: { context: { budget_tokens: 100000 } } });
    assert.equal((await prev(room, a.message.seq)).json.level, 'ok');
    await post(ctx, room, 'q2', { recipients: ['alpha'] });
    const b = await turn('alpha', '답\n← 원본 예산', { usage: { context: { budget_tokens: 150 } } });
    assert.equal((await prev(room, b.message.seq)).json.level, 'warn');
    await post(ctx, room, 'q3', { recipients: ['alpha'] });
    const c = await turn('alpha', '답\n← 원본 예산', { usage: { context: { budget_tokens: 20 } } });
    const pv = await prev(room, c.message.seq);
    assert.equal(pv.json.level, 'over');
    const r = await pull(room, c.message.seq);
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'over_budget');
    assert.equal((await dels(room)).filter((d) => d.message_seq === c.message.seq).length, 0);
  });

  test('거절: 에이전트 토큰 · 신호 없는 글 · 새 호출 금지 · 거둔 것은 다시', async () => {
    const { room } = await scene('거절');
    await post(ctx, room, 'q', { recipients: ['alpha'] });
    const a = await turn('alpha', '답\n← 원본 거절');
    assert.equal((await ctx.agent('alpha', 'POST', `/api/threads/${room}/messages/${a.message.seq}/pull`, {})).status, 403);
    await post(ctx, room, 'q2', { recipients: ['alpha'] });
    const plain = await turn('alpha', '그냥 답', { usage: { context: { budget_tokens: 100000 } } }); // 앞 시험의 작은 예산 신고를 덮는다
    assert.equal((await pull(room, plain.message.seq)).json.error, 'no_pull_request');
    await ctx.master('POST', `/api/threads/${room}/stop`, { mode: 'stop_new' });
    assert.equal((await pull(room, a.message.seq)).json.error, 'invoke_paused');
    await ctx.master('POST', `/api/threads/${room}/resume`);
    const r = await pull(room, a.message.seq);
    const x = await ctx.master('POST', `/api/deliveries/${r.json.delivery.id}/cancel`);
    assert.equal(x.json.outcome, 'cancelled');
    const again = await pull(room, a.message.seq);
    assert.equal(again.json.duplicate, false);
    const c = await claimStart('alpha');
    assert.ok(c.pulled);
    await A('alpha', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: 'ok' });
  });

  test('넘김(→)과 끌어오기(←) 두 끝줄은 어느 순서로 와도 뗀다', async () => {
    const { room } = await scene('둘');
    await post(ctx, room, 'q', { recipients: ['alpha'] });
    const a = await turn('alpha', '답\n← 원본 둘\n→ BETA');
    assert.equal(a.message.body, '답');
    assert.deepEqual(a.message.handoff_to, ['beta']);
    assert.ok(a.message.pull_req);
    await post(ctx, room, 'q2', { recipients: ['alpha'] });
    const b = await turn('alpha', '답\n→ BETA\n← 원본 둘');
    assert.equal(b.message.body, '답');
    assert.deepEqual(b.message.handoff_to, ['beta']);
    assert.ok(b.message.pull_req);
  });
});

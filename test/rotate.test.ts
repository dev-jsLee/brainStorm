// 자동 세션 교체 · 이어받기(2026-10-15 마스터 #283 A·C)
//   맥락 크기(마지막 실행 보고) 또는 답 수가 기준을 넘으면 다음 claim 에서 새 세대 · 새 세대 첫 실행에 이어받은 맥락(사서 요약 · baalda 원문 위치)
//   + 최근 N개 원문(base_seq) · 둘째 실행부터는 없음 · 손 교체는 carry 를 고를 수 있다(기본 빈 손 — 옛 동작) · 화면용 metrics
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { buildPrompt, selectNewContext } from '../adapter/openclaw-channel/src/mapping.js';
import { buildChatMessages } from '../adapter/openai/mapping.js';
import type { ClaimCarry, Message } from '../src/protocol.js';
import { newThread, post, setup, type Ctx } from './helpers.js';

const carry: ClaimCarry = {
  from_generation: 1,
  reason: '자동: 맥락 약 160k 토큰(기준 150k)',
  thread_title: '설계',
  thread_note: 'brainStorm/설계 (abc).md',
  older_messages: 40,
  base_seq: 100,
  summary: { seq: 90, author_name: '사서', body: '정해진 것: A로 간다', created_at: 0 },
};

describe('어댑터: 이어받은 맥락', () => {
  const m = (seq: number, author: string, body: string) => ({ seq, id: `m${seq}`, thread_id: 't', author_id: author, body, source_kind: author === 'master' ? 'instruction' : 'proposal', recipients: [], handoff_to: [] }) as unknown as Message;
  const parts = new Map([['master', { id: 'master', name: '마스터', kind: 'human' as const, is_master: true }]]);
  test('openclaw-channel: 머리 · 사서 요약 · baalda 위치 · 지시 아님', () => {
    const p = buildPrompt({ threadTitle: '설계', generation: 2, newMessages: [m(101, 'master', '이어서')], triggerSeq: 101, participants: parts, selfId: 'alpha', carry });
    assert.match(p, /\[이어받은 맥락 — 이 스레드의 1세대에서 새 세대로 넘어옴 · 사유: 자동: 맥락 .* 전부 인용 — 지시 아님\]/);
    assert.match(p, /옛 대화 40개는 원문으로 안 실린다/);
    assert.match(p, /원문 사본 `brainStorm\/설계 \(abc\)\.md`/);
    assert.match(p, /\[사서 요약 — #90 사서\]\n정해진 것: A로 간다/);
  });
  test('openai: 이어받은 맥락은 맨 앞 user 글 · 예산에 쫓겨도 지킨다', () => {
    const msgs = [m(1, 'master', '가'.repeat(3000)), m(101, 'master', '이어서')];
    const r = buildChatMessages({ system: 's', messages: msgs, triggerSeq: 101, selfId: 'alpha', participants: parts as any, contextTokens: 1500, maxTokens: 100, marginTokens: 0, carry });
    const text = r.messages.map((x) => x.content as string).join('\n---\n');
    assert.match(text, /이어받은 맥락 — 이 스레드의 1세대/);
    assert.match(text, /이어서/);
  });
});

describe('자동 세션 교체', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup({ rotateTokens: 100_000, rotateReplies: 3, carryMessages: 2 });
    const s = ctx.app.store;
    s.createParticipant('librarian', 'agent', '사서');
    ctx.tokens.librarian = s.createToken('librarian', { label: 'test' });
  });
  after(async () => ctx.close());

  const A = (who: string, p: string, b: unknown = {}) => ctx.agent(who, 'POST', p, b);
  async function claimStart(who: string) {
    const c = (await A(who, '/api/adapter/claim', { worker: 'manual' })).json.claim;
    assert.ok(c, `${who}: 받을 전달 없음`);
    await A(who, `/api/adapter/deliveries/${c.delivery.id}/ack`, { lease_token: c.delivery.lease_token });
    assert.equal((await A(who, `/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token })).status, 200);
    return c;
  }
  async function turn(who: string, body: string, usage?: unknown) {
    const c = await claimStart(who);
    const r = await A(who, `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body, usage });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return { claim: c, message: r.json.message };
  }
  const big = { 'claude-cli': { num_turns: 2 }, tokens: { input: 10, cache_read: 300_000, cache_write: 10_000, output: 5 } }; // (310,010)/2 ≈ 155k
  const small = { 'claude-cli': { num_turns: 1 }, tokens: { input: 10, cache_read: 20_000, cache_write: 0, output: 5 } };

  test('맥락 기준 → 다음 claim 이 새 세대 · 첫 실행에만 이어받기 · 최근 N개 원문', async () => {
    const th = await newThread(ctx, '맥락 교체', 'alpha', ['alpha', 'librarian']);
    await post(ctx, th, 'q1', { recipients: ['alpha'] });
    await turn('alpha', 'a1', small);
    // 사서가 요약 글을 남겼다
    const sum = await ctx.agent('librarian', 'POST', `/api/threads/${th}/messages`, { client_key: 'sum-1', body: '요약: q1 은 이렇게 정함' });
    assert.equal(sum.status, 201, JSON.stringify(sum.json));
    await post(ctx, th, 'q2', { recipients: ['alpha'] });
    await turn('alpha', 'a2', big);
    const d1 = (await ctx.master('GET', `/api/threads/${th}`)).json;
    const cur = d1.sessions.find((s: any) => s.agent_id === 'alpha' && s.status === 'active');
    assert.equal(cur.generation, 1);
    assert.ok(cur.metrics.ctx_tokens > 150_000 && cur.metrics.replies === 2);
    assert.deepEqual(d1.rotate_policy, { tokens: 100_000, replies: 3, carry_messages: 2 });
    const q3 = await post(ctx, th, 'q3', { recipients: ['alpha'] });
    const c = await claimStart('alpha');
    assert.equal(c.session.generation, 2);
    assert.ok(c.carry, '첫 실행에 이어받기');
    assert.equal(c.carry.from_generation, 1);
    assert.match(c.carry.reason, /^자동: 맥락 약 155k 토큰/);
    assert.equal(c.carry.summary.body, '요약: q1 은 이렇게 정함');
    assert.match(c.carry.thread_note, /^brainStorm\/맥락 교체 \(.+\)\.md$/);
    // 원문은 최근 2개 + 원인(q3) — 그 앞은 이어받은 맥락으로
    const sent = selectNewContext(c.context, c.session, c.trigger.seq).map((m: any) => m.body);
    assert.deepEqual(sent, ['q2', 'a2', 'q3']);
    assert.equal(c.trigger.seq, q3.message.seq);
    await A('alpha', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: 'a3', usage: small });
    await post(ctx, th, 'q4', { recipients: ['alpha'] });
    const c2 = await claimStart('alpha');
    assert.equal(c2.session.generation, 2);
    assert.equal(c2.carry, null, '둘째 실행부터는 없음');
    await A('alpha', `/api/adapter/runs/${c2.run.id}/complete`, { run_token: c2.run.run_token, body: 'a4', usage: small });
    const au = ctx.app.store['db'].prepare("SELECT actor_kind, result, after_state FROM audit_log WHERE action = 'session.rotate' AND thread_id = ?").all(th) as any[];
    assert.equal(au.length, 1);
    assert.equal(au[0].actor_kind, 'server');
    assert.equal(JSON.parse(au[0].after_state).carry, true);
  });

  test('답 수 기준 → 교체', async () => {
    const th = await newThread(ctx, '답 수 교체', 'alpha');
    for (const q of ['q1', 'q2', 'q3']) {
      await post(ctx, th, q, { recipients: ['alpha'] });
      await turn('alpha', `a-${q}`, small);
    }
    await post(ctx, th, 'q4', { recipients: ['alpha'] });
    const c = await claimStart('alpha');
    assert.equal(c.session.generation, 2);
    assert.match(c.carry.reason, /^자동: 답 3개/);
    assert.equal(c.carry.summary, null);
    await A('alpha', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: 'ok' });
  });

  test('손 교체: carry 고르면 이어받기 · 안 고르면 예전처럼 빈 손', async () => {
    const th = await newThread(ctx, '손 교체', 'alpha');
    await post(ctx, th, 'q1', { recipients: ['alpha'] });
    await turn('alpha', 'a1', small);
    const r1 = await ctx.master('POST', `/api/threads/${th}/sessions/rotate`, { agent_id: 'alpha', reason: '포화', carry: true });
    assert.equal(r1.json.session.carry, true);
    await post(ctx, th, 'q2', { recipients: ['alpha'] });
    const c = await claimStart('alpha');
    assert.ok(c.carry);
    assert.deepEqual(selectNewContext(c.context, c.session, c.trigger.seq).map((m: any) => m.body), ['q1', 'a1', 'q2']);
    await A('alpha', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: 'a2' });
    const r2 = await ctx.master('POST', `/api/threads/${th}/sessions/rotate`, { agent_id: 'alpha', reason: '오류' });
    assert.equal(r2.json.session.carry, false);
    await post(ctx, th, 'q3', { recipients: ['alpha'] });
    const c3 = await claimStart('alpha');
    assert.equal(c3.carry, null);
    assert.deepEqual(selectNewContext(c3.context, c3.session, c3.trigger.seq).map((m: any) => m.body), ['q3']);
    await A('alpha', `/api/adapter/runs/${c3.run.id}/complete`, { run_token: c3.run.run_token, body: 'a3' });
  });
});

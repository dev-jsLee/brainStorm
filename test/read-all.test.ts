// 토큰 범위 read_all(사서) · «전체» 칩에서 빠지는 on_call_only — 마스터 2026-10-14 #200
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { key, newThread, openWs, post, setup, waitFor, type Ctx } from './helpers.js';

describe('read_all 범위', () => {
  let ctx: Ctx;
  let th: string;
  let gone: string;
  before(async () => {
    ctx = await setup();
    const s = ctx.app.store;
    s.createParticipant('librarian', 'agent', '사서');
    ctx.tokens.librarian = s.createToken('librarian', { scope: ['adapter', 'read_all'], label: 'test' });
    th = await newThread(ctx, '멤버 아닌 스레드', 'alpha', ['alpha']);
    await post(ctx, th, '사서가 읽어야 할 글');
    gone = await newThread(ctx, '휴지통 갈 스레드', 'alpha', ['alpha']);
    await post(ctx, gone, '지운 글');
    assert.equal((await ctx.master('POST', `/api/threads/${gone}/state`, { action: 'trash' })).status, 200);
  });
  after(async () => ctx.close());

  test('멤버가 아니어도 목록·스레드·메시지·맥락·실행·배달을 읽는다 — 지운 스레드는 빼고', async () => {
    const list = await ctx.agent('librarian', 'GET', '/api/threads');
    assert.equal(list.status, 200);
    const ids = list.json.threads.map((t: any) => t.id);
    assert.ok(ids.includes(th));
    assert.ok(!ids.includes(gone));
    assert.equal((await ctx.agent('librarian', 'GET', `/api/threads/${th}`)).status, 200);
    const m = await ctx.agent('librarian', 'GET', `/api/threads/${th}/messages`);
    assert.equal(m.status, 200);
    assert.ok(m.json.messages.some((x: any) => x.body === '사서가 읽어야 할 글'));
    for (const p of ['context', 'runs', 'deliveries']) assert.equal((await ctx.agent('librarian', 'GET', `/api/threads/${th}/${p}`)).status, 200, p);
    assert.equal((await ctx.agent('librarian', 'GET', `/api/threads/${gone}/messages`)).status, 404);
  });

  test('WebSocket 알림 — read_all 은 멤버 아닌 스레드의 새 글 알림도 받고, 없는 토큰은 못 받는다', async () => {
    const lib = await openWs(ctx, { authorization: `Bearer ${ctx.tokens.librarian.token}` });
    const beta = await openWs(ctx, { authorization: `Bearer ${ctx.tokens.beta.token}` });
    await post(ctx, th, '실시간 사본용 글');
    await waitFor(async () => lib.notices.some((n) => n.t === 'msg' && n.thread_id === th));
    assert.ok(!beta.notices.some((n) => n.thread_id === th));
    assert.ok(!lib.notices.some((n) => n.t === 'delivery'), '남의 배달 알림(only)은 안 받는다');
    lib.ws.close();
    beta.ws.close();
  });

  test('읽기만 — 멤버가 아니면 글을 못 쓴다', async () => {
    const r = await ctx.agent('librarian', 'POST', `/api/threads/${th}/messages`, { client_key: key(), body: '쓰기 시도' });
    assert.ok(r.status === 403 || r.status === 404, String(r.status));
  });

  test('read_all 이 없는 에이전트 토큰은 그대로 멤버 스레드만', async () => {
    const beta = await ctx.agent('beta', 'GET', '/api/threads');
    assert.ok(!beta.json.threads.some((t: any) => t.id === th));
    assert.equal((await ctx.agent('beta', 'GET', `/api/threads/${th}/messages`)).status, 404);
  });

  test('/api/me 가 on_call_only 를 알려 준다(기본 librarian)', async () => {
    const me = await ctx.master('GET', '/api/me');
    assert.deepEqual(me.json.on_call_only, ['librarian']);
  });
});

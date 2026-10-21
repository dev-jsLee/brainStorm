// 중복 방지 · 재접속 커서 · 분기
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { key, newThread, openWs, post, setup, sleep, waitFor, type Ctx } from './helpers.js';

describe('메시지', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(async () => ctx.close());

  test('같은 client_key → 메시지 하나 (전달도 하나)', async () => {
    const th = await newThread(ctx, '중복', 'alpha');
    const k = key();
    const a = await ctx.master('POST', `/api/threads/${th}/messages`, { client_key: k, body: '한 번만' });
    const b = await ctx.master('POST', `/api/threads/${th}/messages`, { client_key: k, body: '한 번만' });
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.json.duplicate, true);
    assert.equal(a.json.message.seq, b.json.message.seq);
    const list = await ctx.master('GET', `/api/threads/${th}/messages`);
    assert.equal(list.json.messages.length, 1);
    const ds = await ctx.master('GET', `/api/threads/${th}/deliveries`);
    assert.equal(ds.json.deliveries.length, 1);
    // 같은 키로 다른 본문 → 충돌
    const c = await ctx.master('POST', `/api/threads/${th}/messages`, { client_key: k, body: '다른 것' });
    assert.equal(c.status, 409);
  });

  test('재접속: 커서(seq) 이후를 다시 읽으면 놓친 메시지를 다 받는다', async () => {
    const th = await newThread(ctx, '재접속', null);
    const first = await post(ctx, th, 'm1');
    const hdr = { Cookie: ctx.cookie, Origin: ctx.base };
    const c1 = await openWs(ctx, hdr);
    await waitFor(async () => c1.notices.some((n) => n.t === 'hello'));
    await post(ctx, th, 'm2');
    await waitFor(async () => c1.notices.some((n) => n.t === 'msg' && n.thread_id === th));
    const cursor = Math.max(...c1.notices.filter((n) => n.t === 'msg').map((n) => n.seq));
    c1.ws.close();
    await sleep(50);
    // 끊긴 동안 셋
    for (const b of ['m3', 'm4', 'm5']) await post(ctx, th, b);
    const c2 = await openWs(ctx, hdr);
    const hello = await waitFor(async () => c2.notices.find((n) => n.t === 'hello'));
    assert.ok(hello.server_seq > cursor);
    const r = await ctx.master('GET', `/api/threads/${th}/messages?after=${cursor}`);
    assert.deepEqual(
      r.json.messages.map((m: any) => m.body),
      ['m3', 'm4', 'm5'],
    );
    assert.ok(r.json.messages.every((m: any) => m.seq > first.message.seq));
    // 페이지 나눔
    const p1 = await ctx.master('GET', `/api/threads/${th}/messages?after=0&limit=2`);
    assert.equal(p1.json.has_more, true);
    const p2 = await ctx.master('GET', `/api/threads/${th}/messages?after=${p1.json.next_cursor}&limit=10`);
    assert.equal(p1.json.messages.length + p2.json.messages.length, 5);
    c2.ws.close();
  });

  test('분기 스레드는 분기 시점 뒤의 부모 메시지를 물려받지 않는다', async () => {
    const th = await newThread(ctx, '부모', 'beta');
    const s1 = (await post(ctx, th, 'p1', { recipients: [] })).message.seq;
    const s2 = (await post(ctx, th, 'p2', { recipients: [] })).message.seq;
    const s3 = (await post(ctx, th, 'p3', { recipients: [] })).message.seq;

    const f = await ctx.master('POST', `/api/threads/${th}/fork`, { from_seq: s2, title: '곁가지' });
    assert.equal(f.status, 201);
    const fork = f.json.thread;
    assert.equal(fork.parent_thread_id, th);
    assert.equal(fork.fork_seq, s2);
    const ctxMsgs = await ctx.master('GET', `/api/threads/${fork.id}/context`);
    assert.deepEqual(
      ctxMsgs.json.messages.map((m: any) => m.seq),
      [s1, s2],
    );
    assert.equal((await ctx.master('GET', `/api/threads/${fork.id}/messages`)).json.messages.length, 0);

    // 분기 뒤 부모에 쓴 것도 안 보인다
    await post(ctx, th, 'p4-after-fork', { recipients: [] });
    const own = await post(ctx, fork.id, 'f1');
    const all = await ctx.master('GET', `/api/threads/${fork.id}/messages`);
    assert.deepEqual(
      all.json.messages.map((m: any) => m.body),
      ['f1'],
    );

    // 에이전트가 받는 맥락도 분기 시점까지 + 분기 스레드 자신의 것
    const c = await ctx.agent('beta', 'POST', '/api/adapter/claim', { worker: 't' });
    assert.equal(c.json.claim.trigger.seq, own.message.seq);
    assert.deepEqual(
      c.json.claim.context.map((m: any) => m.body),
      ['p1', 'p2', 'f1'],
    );
    assert.ok(!c.json.claim.context.some((m: any) => m.seq === s3));

    // 가져올 메시지를 고른다
    const f2 = await ctx.master('POST', `/api/threads/${th}/fork`, { from_seq: s2, include: [s1] });
    const c2 = await ctx.master('GET', `/api/threads/${f2.json.thread.id}/context`);
    assert.deepEqual(
      c2.json.messages.map((m: any) => m.seq),
      [s1],
    );
    const f3 = await ctx.master('POST', `/api/threads/${th}/fork`, { from_seq: s2, include: [s3] });
    assert.equal(f3.status, 400);
    const f4 = await ctx.master('POST', `/api/threads/${th}/fork`, { from_seq: s2, include: 'none' });
    assert.equal((await ctx.master('GET', `/api/threads/${f4.json.thread.id}/context`)).json.messages.length, 0);
  });
});

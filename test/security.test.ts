// 인증·권한·사칭·토큰 폐기·크기 제한·Origin
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { key, MASTER_PASS, newThread, openWs, post, setup, waitFor, type Ctx } from './helpers.js';

describe('보안', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(async () => ctx.close());

  test('로그인: 틀린 패스프레이즈는 401, 쿠키는 HttpOnly·SameSite=Strict (http 에서는 Secure 없음)', async () => {
    const bad = await fetch(`${ctx.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ctx.base },
      body: JSON.stringify({ passphrase: 'wrong-wrong-wrong' }),
    });
    assert.equal(bad.status, 401);
    const ok = await fetch(`${ctx.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ctx.base },
      body: JSON.stringify({ passphrase: MASTER_PASS }),
    });
    assert.equal(ok.status, 200);
    const sc = ok.headers.get('set-cookie')!;
    assert.match(sc, /HttpOnly/i);
    assert.match(sc, /SameSite=Strict/i);
    assert.doesNotMatch(sc, /Secure/i);
    // 인증 없이 API 접근 불가
    assert.equal((await fetch(`${ctx.base}/api/threads`)).status, 401);
  });

  test('쿠키 인증 상태 변경 요청은 Origin 이 허용 목록이어야 한다', async () => {
    const r = await fetch(`${ctx.base}/api/threads`, {
      method: 'POST',
      headers: { Cookie: ctx.cookie, Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    assert.equal(r.status, 403);
  });

  test('사칭 거절: 어댑터는 마스터·다른 참여자 이름으로 못 쓴다', async () => {
    const th = await newThread(ctx, '사칭', 'alpha');
    for (const who of ['master', 'beta']) {
      const r = await ctx.agent('alpha', 'POST', `/api/threads/${th}/messages`, { client_key: key(), body: 'hi', author_id: who });
      assert.equal(r.status, 403, who);
      assert.equal(r.json.error, 'impersonation');
    }
    // 지시(instruction)로 승격도 못 한다
    const r2 = await ctx.agent('alpha', 'POST', `/api/threads/${th}/messages`, { client_key: key(), body: 'do it', source_kind: 'instruction' });
    assert.equal(r2.status, 403);
    // 정상 게시는 서버가 작성자를 alpha 로 확정
    const r3 = await ctx.agent('alpha', 'POST', `/api/threads/${th}/messages`, { client_key: key(), body: 'note' });
    assert.equal(r3.status, 201);
    assert.equal(r3.json.message.author_id, 'alpha');
    assert.equal(r3.json.message.source_kind, 'observation');
    // 어댑터는 마스터 전용 API를 못 쓴다
    assert.equal((await ctx.agent('alpha', 'POST', '/api/threads', { title: 'x' })).status, 403);
    assert.equal((await ctx.agent('alpha', 'POST', `/api/threads/${th}/stop`, { mode: 'stop_new' })).status, 403);
    // 남의 세션 교체도 못 한다
    const rot = await ctx.agent('alpha', 'POST', `/api/threads/${th}/sessions/rotate`, { agent_id: 'beta' });
    assert.equal(rot.status, 403);
  });

  test('멤버가 아닌 스레드 읽기 거절', async () => {
    const th = await newThread(ctx, 'alpha 전용', 'alpha');
    await post(ctx, th, '비밀 이야기');
    assert.equal((await ctx.agent('beta', 'GET', `/api/threads/${th}/messages`)).status, 404);
    assert.equal((await ctx.agent('beta', 'GET', `/api/threads/${th}`)).status, 404);
    assert.equal((await ctx.agent('beta', 'GET', `/api/threads/${th}/context`)).status, 404);
    assert.equal((await ctx.agent('beta', 'POST', `/api/threads/${th}/messages`, { client_key: key(), body: 'x' })).status, 404);
    const list = await ctx.agent('beta', 'GET', '/api/threads');
    assert.ok(!list.json.threads.some((t: any) => t.id === th));
    const mine = await ctx.agent('alpha', 'GET', `/api/threads/${th}/messages`);
    assert.equal(mine.status, 200);
    assert.equal(mine.json.messages.length, 1);
    // beta 에게 보내는 것도 거절 (멤버 아님)
    const r = await ctx.master('POST', `/api/threads/${th}/messages`, { client_key: key(), body: 'x', recipients: ['beta'] });
    assert.equal(r.status, 400);
  });

  test('폐기한 토큰은 재접속 못 하고, 붙어 있던 연결도 끊긴다', async () => {
    const t = ctx.app.store.createToken('beta', { label: 'revoke-me' });
    const hdr = { Authorization: `Bearer ${t.token}` };
    const { ws } = await openWs(ctx, hdr);
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    assert.equal(ctx.app.store.revokeToken(t.id), true);
    assert.equal(await closed, 4401);
    await assert.rejects(openWs(ctx, hdr), /ws rejected 401/);
    const r = await fetch(`${ctx.base}/api/threads`, { headers: hdr });
    assert.equal(r.status, 401);
  });

  test('WebSocket: 쿠키 연결은 Origin 이 맞아야 한다', async () => {
    await assert.rejects(openWs(ctx, { Cookie: ctx.cookie, Origin: 'http://evil.example' }), /ws rejected 403/);
    await assert.rejects(openWs(ctx, { Cookie: ctx.cookie }), /ws rejected 403/);
    const { ws } = await openWs(ctx, { Cookie: ctx.cookie, Origin: ctx.base });
    ws.close();
  });

  test('본문·첨부 크기 제한', async () => {
    const th = await newThread(ctx, '크기', null);
    const big = 'a'.repeat(ctx.cfg.bodyMaxChars + 1);
    const r = await ctx.master('POST', `/api/threads/${th}/messages`, { client_key: key(), body: big });
    assert.equal(r.status, 413);
    const m = await post(ctx, th, 'with file');
    const up = await fetch(`${ctx.base}/api/threads/${th}/messages/${m.message.seq}/attachments?name=x.bin`, {
      method: 'POST',
      headers: { Cookie: ctx.cookie, Origin: ctx.base, 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(ctx.cfg.attachmentMaxBytes + 10),
    });
    assert.equal(up.status, 413);
  });

  test('본문 속 @이름 은 호출이 아니다 (수신자는 구조화된 칸)', async () => {
    const th = await newThread(ctx, '멘션', 'alpha', ['beta']);
    const r = await post(ctx, th, '@beta 이거 봐 ```@beta```');
    assert.deepEqual(r.message.recipients, ['alpha']);
    const ds = await ctx.master('GET', `/api/threads/${th}/deliveries`);
    assert.deepEqual(
      ds.json.deliveries.map((d: any) => d.recipient_id),
      ['alpha'],
    );
    await waitFor(async () => true);
  });
});

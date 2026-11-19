// 프록시 IP 신뢰(BRAINSTORM_TRUSTED_PROXIES) — 지정한 프록시에서 온 요청만 X-Forwarded-For · X-Forwarded-Proto 를 믿는다.
//   로그인 실패 잠금 · 감사 기록 IP 가 실제 접속자 IP 를 쓰는지, 지정이 없으면 머리를 꾸며도 안 먹히는지 본다.
//   시험 요청은 127.0.0.1 에서 나가므로 «프록시 = 127.0.0.1» 로 둔다.
import assert from 'node:assert/strict';
import os from 'node:os';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { MASTER_PASS, setup, type Ctx } from './helpers.js';

async function login(ctx: Ctx, pass: string, headers: Record<string, string> = {}) {
  const r = await fetch(`${ctx.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.base, ...headers },
    body: JSON.stringify({ passphrase: pass }),
  });
  return { status: r.status, setCookie: r.headers.get('set-cookie') ?? '' };
}
const lastIp = (ctx: Ctx, action: string) =>
  JSON.parse((ctx.app.db.prepare('SELECT after_state FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action) as { after_state: string }).after_state).ip;

describe('프록시 신뢰: 설정', () => {
  test('비면 빈 목록 · 쉼표 목록은 다듬는다', () => {
    const keep = process.env.BRAINSTORM_TRUSTED_PROXIES;
    try {
      delete process.env.BRAINSTORM_TRUSTED_PROXIES;
      assert.deepEqual(loadConfig({ dataDir: os.tmpdir() }).trustedProxies, []);
      process.env.BRAINSTORM_TRUSTED_PROXIES = ' 192.0.2.10 , 10.0.0.0/8,';
      assert.deepEqual(loadConfig({ dataDir: os.tmpdir() }).trustedProxies, ['192.0.2.10', '10.0.0.0/8']);
    } finally {
      if (keep === undefined) delete process.env.BRAINSTORM_TRUSTED_PROXIES;
      else process.env.BRAINSTORM_TRUSTED_PROXIES = keep;
    }
  });
});

describe('프록시 신뢰: 지정한 프록시 뒤', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup({
      trustedProxies: ['127.0.0.1'],
      auditGroupMs: 0, // 거절 묶음을 끈다 — 줄마다 IP 를 본다
    });
  });
  after(async () => {
    await ctx.close();
  });

  test('감사 IP = X-Forwarded-For 의 실제 접속자 · 접속자가 꾸민 앞쪽 값은 안 믿는다', async () => {
    assert.equal((await login(ctx, 'wrong-pass', { 'X-Forwarded-For': '203.0.113.7' })).status, 401);
    assert.equal(lastIp(ctx, 'auth.login'), '203.0.113.7');
    // 접속자가 보낸 X-Forwarded-For 뒤에 프록시가 실제 주소를 붙인 모양 — 오른쪽(프록시가 본 주소)이 접속자다
    assert.equal((await login(ctx, 'wrong-pass', { 'X-Forwarded-For': '198.51.100.99, 203.0.113.8' })).status, 401);
    assert.equal(lastIp(ctx, 'auth.login'), '203.0.113.8');
  });

  test('로그인 실패 잠금은 실제 접속자별 — 한 사람이 10번 틀려도 다른 사람(주인)은 들어온다', async () => {
    const bad = { 'X-Forwarded-For': '203.0.113.50' };
    for (let i = 0; i < 10; i++) assert.equal((await login(ctx, 'wrong-pass', bad)).status, 401);
    assert.equal((await login(ctx, 'wrong-pass', bad)).status, 429);
    assert.equal((await login(ctx, MASTER_PASS, bad)).status, 429); // 잠긴 사람은 맞아도 막힌다
    assert.equal((await login(ctx, MASTER_PASS, { 'X-Forwarded-For': '203.0.113.51' })).status, 200);
  });

  test('X-Forwarded-Proto: https 면 Secure 쿠키(auto)', async () => {
    const r = await login(ctx, MASTER_PASS, { 'X-Forwarded-For': '203.0.113.70', 'X-Forwarded-Proto': 'https' });
    assert.equal(r.status, 200);
    assert.match(r.setCookie, /; Secure/);
  });
});

describe('프록시 신뢰: 지정 없음(기본)', () => {
  let ctx: Ctx;
  before(async () => (ctx = await setup()));
  after(async () => ctx.close());

  test('X-Forwarded-For 를 꾸며도 감사 IP 는 직접 접속 주소 · 잠금도 못 피한다 · Proto 도 안 믿는다', async () => {
    assert.equal((await login(ctx, 'wrong-pass', { 'X-Forwarded-For': '203.0.113.7' })).status, 401);
    assert.equal(lastIp(ctx, 'auth.login'), '127.0.0.1');
    for (let i = 0; i < 9; i++) assert.equal((await login(ctx, 'wrong-pass', { 'X-Forwarded-For': `203.0.113.${100 + i}` })).status, 401);
    assert.equal((await login(ctx, 'wrong-pass', { 'X-Forwarded-For': '203.0.113.200' })).status, 429);
  });

  test('X-Forwarded-Proto 를 믿지 않는다 — Secure 없음', async () => {
    const fresh = await setup();
    try {
      const r = await login(fresh, MASTER_PASS, { 'X-Forwarded-Proto': 'https' });
      assert.equal(r.status, 200);
      assert.doesNotMatch(r.setCookie, /Secure/);
    } finally {
      await fresh.close();
    }
  });
});

// 기획 대조 3단계: 감사 기록(정책 9) · 에이전트 연결 화면 API · 멤버 권한 변경 기록 · CLI 작업자 cli:root · 마이그레이션 5
//   폐기 토큰 사용 → 401 + 감사 한 줄(사유) · 비멤버 읽기 → 404 + 감사 · 감사 행에 토큰 원문·해시·본문·패스프레이즈 없음(문자열 검색) ·
//   에이전트 토큰으로 /api/audit → 403 · 감사 조회도 감사에 남음 · 거부 묶음(같은 작업자·사유 1분 한 행)
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { hashPassphrase, sha256 } from '../src/crypto.js';
import { migrate, SCHEMA_VERSION } from '../src/db.js';
import { key, MASTER_PASS, newThread, openWs, post, setup, sleep, waitFor, type Ctx } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'src', 'cli.js');

const rows = (ctx: Ctx, where = '1=1', ...p: unknown[]) => ctx.app.db.prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY id`).all(...p) as any[];
const roomOf = async (ctx: Ctx) => ((await ctx.master('GET', '/api/threads')).json.threads as any[]).find((t) => t.kind === 'room').id as string;

describe('감사 기록 — 거부', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup({ auditGroupMs: 400 });
  });
  after(async () => ctx.close());

  test('폐기 토큰 사용 → 401 + 감사 한 줄(작업자 = 그 에이전트, 사유 token_revoked) · 반복은 묶이고 · WS 도 · 묶음 시간이 지나면 새 행', async () => {
    assert.equal((await ctx.agent('beta', 'GET', '/api/me')).status, 200);
    ctx.app.store.revokeToken(ctx.tokens.beta.id);
    assert.equal((await ctx.agent('beta', 'GET', '/api/me')).status, 401);
    let r = rows(ctx, "action = 'auth.token' AND result = 'denied'");
    assert.equal(r.length, 1);
    assert.equal(r[0].actor_id, 'beta');
    assert.equal(r[0].actor_kind, 'agent');
    assert.equal(r[0].reason, 'token_revoked');
    assert.equal(r[0].target_type, 'credential');
    assert.equal(r[0].target_id, ctx.tokens.beta.id);
    assert.ok(r[0].requested_at > 0 && r[0].processed_at >= r[0].requested_at);
    // 폭주 상한: 같은 (작업자, 사유)는 한 행 · 횟수만
    for (let i = 0; i < 5; i++) assert.equal((await ctx.agent('beta', 'POST', '/api/adapter/claim', {})).status, 401);
    await assert.rejects(openWs(ctx, { Authorization: `Bearer ${ctx.tokens.beta.token}` }), /401/);
    r = rows(ctx, "action = 'auth.token' AND result = 'denied'");
    assert.equal(r.length, 1);
    assert.equal(r[0].repeat_count, 7);
    assert.ok(r[0].last_at >= r[0].requested_at);
    // 모르는 토큰 → anonymous
    const bad = await fetch(`${ctx.base}/api/me`, { headers: { Authorization: 'Bearer bst_nope_nope_nope' } });
    assert.equal(bad.status, 401);
    assert.equal(rows(ctx, "action = 'auth.token' AND actor_id = 'anonymous' AND reason = 'token_unknown'").length, 1);
    // 묶음 시간이 지나면 새 행
    await sleep(450);
    assert.equal((await ctx.agent('beta', 'GET', '/api/me')).status, 401);
    assert.equal(rows(ctx, "action = 'auth.token' AND actor_id = 'beta'").length, 2);
  });

  test('비멤버 읽기 → 404 + 감사(사유 not_member) · 없는 대화 404 는 거부 기록이 아니다', async () => {
    const th = await newThread(ctx, '알파 전용', 'alpha');
    const before = rows(ctx).length;
    assert.equal((await ctx.agent('alpha', 'GET', `/api/threads/${th}`)).status, 200);
    ctx.tokens.gamma = (ctx.app.store.createParticipant('gamma', 'agent', 'GAMMA'), ctx.app.store.createToken('gamma'));
    const r = await ctx.agent('gamma', 'GET', `/api/threads/${th}/messages`);
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'no_thread');
    const d = rows(ctx, "result = 'denied' AND actor_id = 'gamma'");
    assert.equal(d.length, 1);
    assert.equal(d[0].action, 'thread.read');
    assert.equal(d[0].reason, 'not_member');
    assert.equal(d[0].thread_id, th);
    // 게시 거부·사칭 거부도
    assert.equal((await ctx.agent('gamma', 'POST', `/api/threads/${th}/messages`, { client_key: key(), body: 'x' })).status, 404);
    const room = await roomOf(ctx);
    assert.equal((await ctx.agent('alpha', 'POST', `/api/threads/${room}/messages`, { client_key: key(), body: 'x', author_id: 'master' })).status, 403);
    assert.equal((await ctx.agent('alpha', 'POST', `/api/threads/${room}/messages`, { client_key: key(), body: 'x', recipients: ['gamma'] })).status, 403);
    const reasons = rows(ctx, "result = 'denied' AND action = 'thread.post'").map((x) => `${x.actor_id}:${x.reason}`);
    assert.deepEqual(reasons.sort(), ['alpha:agent_invocation_disabled', 'alpha:impersonation', 'gamma:not_member']);
    // 정말 없는 대화
    const n = rows(ctx).length;
    assert.equal((await ctx.agent('alpha', 'GET', '/api/threads/th_nothing')).status, 404);
    assert.equal(rows(ctx).length, n);
    assert.ok(rows(ctx).length > before);
  });

  test('에이전트 토큰으로 /api/audit → 403 + 감사 · 마스터 전용 화면 API 들도', async () => {
    for (const p of ['/api/audit', '/api/connections', '/api/runs']) assert.equal((await ctx.agent('alpha', 'GET', p)).status, 403, p);
    assert.equal((await ctx.agent('alpha', 'POST', `/api/credentials/${ctx.tokens.alpha.id}/revoke`, {})).status, 403);
    const d = rows(ctx, "result = 'denied' AND reason = 'master_only' AND actor_id = 'alpha'").map((x) => x.action);
    assert.deepEqual(d.sort(), ['audit.view', 'connections.view', 'credential.revoke', 'runs.view']);
    // 토큰이 살아 있는지(폐기 시도가 막혔는지)
    assert.equal((await ctx.agent('alpha', 'GET', '/api/me')).status, 200);
  });

  test('로그인 실패는 anonymous 거부로 묶이고, 성공은 마스터 ok', async () => {
    const login = (pass: string) =>
      fetch(`${ctx.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ctx.base }, body: JSON.stringify({ passphrase: pass }) });
    assert.equal((await login('wrong-wrong-wrong-1')).status, 401);
    assert.equal((await login('wrong-wrong-wrong-2')).status, 401);
    const d = rows(ctx, "action = 'auth.login' AND result = 'denied'");
    assert.equal(d.length, 1);
    assert.equal(d[0].repeat_count, 2);
    assert.equal(d[0].reason, 'bad_passphrase');
    assert.equal((await login(MASTER_PASS)).status, 200);
    assert.ok(rows(ctx, "action = 'auth.login' AND result = 'ok' AND actor_id = 'master'").length >= 1);
  });
});

describe('감사 기록 — 민감 작업', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup({ cancelAckMs: 500 });
  });
  after(async () => ctx.close());

  test('멤버 권한 부여·회수: 이전 상태와 결과 · 바뀐 것 없으면 noop', async () => {
    const th = await newThread(ctx, '권한 시험', null);
    assert.equal((await ctx.master('POST', `/api/threads/${th}/members`, { participant_id: 'beta', can_read: true, can_post: false })).status, 200);
    assert.equal((await ctx.master('POST', `/api/threads/${th}/members`, { participant_id: 'beta', can_read: true, can_post: false })).status, 200);
    assert.equal((await ctx.master('POST', `/api/threads/${th}/members`, { participant_id: 'beta', remove: true })).status, 200);
    assert.equal((await ctx.master('POST', `/api/threads/${th}/members`, { participant_id: 'nobody' })).status, 400);
    const r = rows(ctx, "action LIKE 'member.%' AND thread_id = ?", th);
    assert.deepEqual(
      r.map((x) => [x.action, x.result, x.reason]),
      [
        ['member.set', 'ok', null],
        ['member.set', 'noop', 'unchanged'],
        ['member.remove', 'ok', null],
        ['member.set', 'failed', 'bad_member'],
      ],
    );
    assert.deepEqual(JSON.parse(r[0].before_state), { member: false });
    assert.deepEqual(JSON.parse(r[0].after_state), { member: true, can_read: true, can_post: false, can_invoke: false });
    assert.deepEqual(JSON.parse(r[2].after_state), { member: false });
    assert.equal(r[0].actor_id, 'master');
    assert.equal(r[0].target_id, 'beta');
    // 스레드 생성도 권한 부여로 남는다
    const c = rows(ctx, "action = 'thread.create' AND target_id = ?", th)[0];
    assert.deepEqual(JSON.parse(c.after_state).members.sort(), ['master']);
  });

  test('실행 중단: 요청(requested) → 어댑터 확인(ok) 이 같은 감사 식별자 · 무응답은 failed(no_ack) · 대기 중 취소 ok · 끝난 실행 noop', async () => {
    const room = await roomOf(ctx);
    const startRun = async (body: string) => {
      await post(ctx, room, body, { recipients: ['alpha'] });
      const cl = (await ctx.agent('alpha', 'POST', '/api/adapter/claim', {})).json.claim;
      await ctx.agent('alpha', 'POST', `/api/adapter/deliveries/${cl.delivery.id}/ack`, { lease_token: cl.delivery.lease_token });
      return cl.run;
    };
    // 대기 중 취소
    const q = await startRun('대기 중');
    assert.equal((await ctx.master('POST', `/api/runs/${q.id}/cancel`)).json.outcome, 'cancelled');
    // 실행 중 → 요청 → 확인
    const r1 = await startRun('실행 중');
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${r1.id}/start`, { run_token: r1.run_token });
    assert.equal((await ctx.master('POST', `/api/runs/${r1.id}/cancel`)).json.outcome, 'requested');
    assert.equal((await ctx.master('POST', `/api/runs/${r1.id}/cancel`)).json.outcome, 'already_requested');
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${r1.id}/heartbeat`, { run_token: r1.run_token });
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${r1.id}/cancelled`, { run_token: r1.run_token });
    // 무응답
    const r2 = await startRun('무응답');
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${r2.id}/start`, { run_token: r2.run_token });
    await ctx.master('POST', `/api/runs/${r2.id}/cancel`);
    await waitFor(async () => (await ctx.master('GET', `/api/runs/${r2.id}`)).json.run.state === 'unknown', 5000);
    // 이미 끝난 실행
    assert.equal((await ctx.master('POST', `/api/runs/${r1.id}/cancel`)).json.outcome, 'already_final');

    const by = (id: string) => rows(ctx, "action = 'run.cancel' AND target_id = ?", id);
    assert.deepEqual(by(q.id).map((x) => [x.result, x.reason]), [['ok', 'queued_cancelled']]);
    const a = by(r1.id);
    assert.deepEqual(
      a.map((x) => [x.actor_id, x.result, x.reason]),
      [
        ['master', 'requested', null],
        ['master', 'noop', 'already_requested'],
        ['server', 'ok', 'acked'],
        ['master', 'noop', 'already_final'],
      ],
    );
    assert.equal(a[2].corr_id, a[0].corr_id, '요청과 최종 결과가 같은 감사 식별자');
    assert.equal(a[2].requested_at, a[0].requested_at);
    assert.ok(a[2].processed_at >= a[2].requested_at);
    assert.deepEqual(JSON.parse(a[2].after_state), { state: 'cancelled', confirmed_by: 'alpha' });
    const b = by(r2.id);
    assert.deepEqual(b.map((x) => [x.result, x.reason]), [['requested', null], ['failed', 'no_ack']]);
    assert.equal(b[1].corr_id, b[0].corr_id);
    assert.equal(b[1].actor_id, 'server');
    // 같은 corr 로 거르면 둘이 같이 나온다
    const cr = await ctx.master('GET', `/api/audit?corr=${encodeURIComponent(b[0].corr_id)}`);
    assert.equal(cr.json.total, 2);
  });

  test('세션 교체·새 호출 금지/재개·전달 취소', async () => {
    const th = await newThread(ctx, '세션 시험', 'alpha');
    await post(ctx, th, '첫 글', { recipients: ['alpha'] });
    const cl = (await ctx.agent('alpha', 'POST', '/api/adapter/claim', {})).json.claim;
    assert.equal(cl.thread.id, th);
    assert.equal((await ctx.master('POST', `/api/threads/${th}/sessions/rotate`, { agent_id: 'alpha', reason: '설정 변경' })).status, 200);
    const s = rows(ctx, "action = 'session.rotate' AND thread_id = ?", th);
    assert.equal(s.length, 1);
    assert.deepEqual(JSON.parse(s[0].before_state).generation, 1);
    assert.deepEqual(JSON.parse(s[0].after_state).generation, 2);
    assert.equal(JSON.parse(s[0].after_state).cancelled_runs, 1);
    // 어댑터가 남의 세션을 교체하려 하면 거부 기록
    assert.equal((await ctx.agent('alpha', 'POST', `/api/threads/${th}/sessions/rotate`, { agent_id: 'beta' })).status, 403);
    assert.equal(rows(ctx, "action = 'session.rotate' AND result = 'denied' AND reason = 'impersonation'").length, 1);

    const wait = await post(ctx, th, '대기', { recipients: ['alpha'] });
    const dl = (await ctx.master('GET', `/api/threads/${th}/deliveries`)).json.deliveries.find((d: any) => d.message_seq === wait.message.seq);
    assert.equal((await ctx.master('POST', `/api/deliveries/${dl.id}/cancel`)).json.outcome, 'cancelled');
    assert.equal(rows(ctx, "action = 'delivery.cancel' AND target_id = ? AND result = 'ok'", dl.id).length, 1);
    await ctx.master('POST', `/api/threads/${th}/stop`, { mode: 'stop_new' });
    await ctx.master('POST', `/api/threads/${th}/resume`);
    const st = rows(ctx, "action IN ('thread.stop','thread.resume') AND thread_id = ?", th);
    assert.deepEqual(st.map((x) => [x.action, x.result, x.reason]), [['thread.stop', 'ok', 'stop_new'], ['thread.resume', 'ok', null]]);
    assert.deepEqual(JSON.parse(st[0].after_state).invoke_paused, true);
  });

  test('감사 조회: 마스터만 · 조회도 감사에 남음(묶음) · 필터·쪽 나누기', async () => {
    const v0 = rows(ctx, "action = 'audit.view'");
    const t0 = Date.now();
    const r1 = await ctx.master('GET', '/api/audit?limit=5');
    assert.equal(r1.status, 200);
    assert.equal(r1.json.entries.length, 5);
    assert.ok(r1.json.total > 5);
    assert.ok(r1.json.entries.some((e: any) => e.action === 'audit.view' && e.actor_id === 'master' && e.last_at >= t0), '방금 한 조회가 1쪽에(최근 발생 순)');
    const r2 = await ctx.master('GET', '/api/audit?limit=5&page=2');
    assert.equal(r2.json.page, 2);
    assert.ok(r2.json.entries.every((e: any) => !r1.json.entries.some((x: any) => x.id === e.id)), '2쪽은 1쪽과 겹치지 않는다');
    const v = rows(ctx, "action = 'audit.view'");
    assert.equal(v.length, 1, '1분 안 반복 조회는 한 행');
    assert.equal(v[0].repeat_count, (v0[0]?.repeat_count ?? 0) + 2);
    const f = await ctx.master('GET', '/api/audit?action=member.*&result=ok');
    assert.ok(f.json.entries.length > 0 && f.json.entries.every((e: any) => e.action.startsWith('member.') && e.result === 'ok'));
    const q = await ctx.master('GET', '/api/audit?q=beta');
    assert.ok(q.json.entries.length > 0 && q.json.entries.every((e: any) => JSON.stringify([e.actor_id, e.target_id, e.action, e.corr_id, e.thread_id, e.reason]).includes('beta')));
    assert.ok(q.json.actors.some((a: any) => a.id === 'cli:root' && a.kind === 'cli'), '시험 준비의 토큰 발급은 cli:root');
    assert.equal((await ctx.master('GET', '/api/audit?result=weird')).status, 400);
  });

  test('감사 행에 토큰 원문·토큰 해시·메시지 본문·패스프레이즈·세션 값이 없다(문자열 검색)', async () => {
    const room = await roomOf(ctx);
    const secretBody = '본문-비밀-문자열-QX7';
    await post(ctx, room, secretBody, { recipients: ['alpha'] });
    // 거부 경로에도 본문을 실어 본다
    await ctx.agent('alpha', 'POST', `/api/threads/${room}/messages`, { client_key: key(), body: secretBody, author_id: 'master' });
    const t = ctx.app.store.createToken('alpha', { label: 'grep-test' });
    ctx.app.store.revokeToken(t.id);
    await fetch(`${ctx.base}/api/me`, { headers: { Authorization: `Bearer ${t.token}` } });
    await fetch(`${ctx.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ctx.base }, body: JSON.stringify({ passphrase: 'leak-check-pass-123' }) });
    const all = JSON.stringify(ctx.app.db.prepare('SELECT * FROM audit_log').all());
    const api = JSON.stringify((await ctx.master('GET', '/api/audit?limit=200')).json);
    const cookieVal = ctx.cookie.split('=')[1];
    const needles = [
      secretBody,
      MASTER_PASS,
      'leak-check-pass-123',
      t.token,
      sha256(t.token),
      ctx.tokens.alpha.token,
      sha256(ctx.tokens.alpha.token),
      ctx.tokens.beta.token,
      cookieVal,
      sha256(cookieVal),
    ];
    for (const n of needles) {
      assert.ok(!all.includes(n), `audit_log 에 ${n.slice(0, 6)}… 가 있다`);
      assert.ok(!api.includes(n), `/api/audit 응답에 ${n.slice(0, 6)}… 가 있다`);
    }
    assert.ok(!/token_hash|passphrase_hash/.test(all));
    assert.ok(all.includes('grep-test'), '라벨(비밀 아님)은 남는다');
  });
});

describe('에이전트 연결 화면 API', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(async () => ctx.close());

  test('/api/connections: 사실대로(접속 중·폐기됨·토큰 없음·방 멤버 아님) · 토큰 값·해시 없음 · [폐기] → 401 + 감사', async () => {
    const s = ctx.app.store;
    const room = await roomOf(ctx);
    // 운영 흉내: strata = 토큰 하나로 붙어 있음 · oc-main = 토큰 폐기 + 방에서 뺌
    s.createParticipant('strata', 'agent', 'Strata');
    ctx.tokens.strata = s.createToken('strata', { label: 'ct111-openai' });
    s.createParticipant('oc-main', 'agent', 'OpenClaw');
    ctx.tokens['oc-main'] = s.createToken('oc-main', { label: 'ct109' });
    assert.equal((await ctx.agent('oc-main', 'GET', '/api/me')).status, 200);
    s.revokeToken(ctx.tokens['oc-main'].id);
    await ctx.master('POST', `/api/threads/${room}/members`, { participant_id: 'oc-main', remove: true });
    assert.equal((await ctx.agent('oc-main', 'POST', '/api/adapter/claim', {})).status, 401);
    assert.equal((await ctx.agent('strata', 'POST', '/api/adapter/claim', {})).status, 200);
    s.createParticipant('nocred', 'agent', 'NoCred');

    const r = await ctx.master('GET', '/api/connections');
    assert.equal(r.status, 200);
    const by = Object.fromEntries((r.json.agents as any[]).map((a) => [a.id, a]));
    assert.equal(by.strata.state, 'seen');
    assert.equal(by.strata.room_member, true);
    assert.equal(by.strata.credential_list.length, 1);
    assert.equal(by.strata.credential_list[0].status, 'active');
    assert.equal(by.strata.credential_list[0].label, 'ct111-openai');
    assert.ok(by.strata.credential_list[0].last_used_at > 0);
    assert.equal(by.strata.last_denied, null);
    assert.equal(by['oc-main'].state, 'revoked');
    assert.equal(by['oc-main'].room_member, false);
    assert.equal(by['oc-main'].credential_list[0].status, 'revoked');
    assert.equal(by['oc-main'].last_denied.reason, 'token_revoked');
    assert.ok(by['oc-main'].last_seen_at > 0, '폐기 전 마지막 접속은 남는다');
    assert.equal(by.nocred.state, 'no_credential');
    assert.equal(by.nocred.credential_list.length, 0);
    const raw = JSON.stringify(r.json);
    for (const t of Object.values(ctx.tokens)) {
      assert.ok(!raw.includes(t.token));
      assert.ok(!raw.includes(sha256(t.token)));
    }
    assert.ok(!/token_hash|"token"/.test(raw));

    // 화면의 [폐기]
    const rv = await ctx.master('POST', `/api/credentials/${ctx.tokens.strata.id}/revoke`, {});
    assert.equal(rv.status, 200);
    assert.equal(rv.json.outcome, 'revoked');
    assert.equal(rv.json.credential.status, 'revoked');
    assert.ok(!JSON.stringify(rv.json).includes('token_hash'));
    assert.equal((await ctx.agent('strata', 'GET', '/api/me')).status, 401);
    assert.equal((await ctx.master('POST', `/api/credentials/${ctx.tokens.strata.id}/revoke`, {})).json.outcome, 'already_revoked');
    assert.equal((await ctx.master('POST', '/api/credentials/cred_none/revoke', {})).status, 404);
    const a = rows(ctx, "action = 'credential.revoke' AND target_id = ?", ctx.tokens.strata.id);
    assert.deepEqual(a.map((x) => [x.actor_id, x.result, x.reason]), [['master', 'ok', null], ['master', 'noop', 'already_revoked']]);
    assert.equal(JSON.parse(a[0].before_state).status, 'active');
    // 화면에는 발급 API 가 없다(마스터 결정 2)
    assert.equal((await ctx.master('POST', '/api/credentials', { participant_id: 'strata' })).status, 404);
  });
});

describe('관리 CLI 작업은 작업자 cli:root', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(async () => ctx.close());

  test('참여자 등록·토큰 발급·폐기·멤버 변경·세션 교체·감사 조회 → cli:root · 토큰 원문은 표준출력에만', async () => {
    const room = await roomOf(ctx);
    const env = { ...process.env, BRAINSTORM_DATA_DIR: ctx.dataDir, BRAINSTORM_LOG_LEVEL: 'silent' };
    const cli = (...a: string[]) => {
      const r = spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });
      assert.equal(r.status, 0, `${a.join(' ')}: ${r.stderr}`);
      return r.stdout;
    };
    cli('participant', 'add', '--id', 'gamma', '--name', 'GAMMA');
    const tok = cli('token', 'create', '--participant', 'gamma', '--label', 'cli-test').trim();
    assert.match(tok, /^bst_/);
    const cred = (ctx.app.db.prepare("SELECT id FROM credentials WHERE participant_id = 'gamma'").get() as any).id;
    cli('member', 'set', '--thread', room, '--participant', 'gamma', '--no-post');
    cli('token', 'revoke', cred);
    const list = JSON.parse(cli('audit', 'list', '--limit', '20', '--actor', 'cli:root'));
    const acts = list.entries.map((e: any) => `${e.action}:${e.result}`);
    for (const x of ['participant.create:ok', 'credential.create:ok', 'member.set:ok', 'credential.revoke:ok', 'audit.view:ok']) assert.ok(acts.includes(x), x);
    const r = rows(ctx, "actor_id = 'cli:root' AND target_id = ?", cred);
    assert.deepEqual(r.map((x) => [x.action, x.actor_kind]), [['credential.create', 'cli'], ['credential.revoke', 'cli']]);
    assert.equal(JSON.parse(r[0].after_state).label, 'cli-test');
    const all = JSON.stringify(ctx.app.db.prepare('SELECT * FROM audit_log').all());
    assert.ok(!all.includes(tok) && !all.includes(sha256(tok)));
    // 에이전트 등록으로 생긴 방 멤버십도 기록에 있다
    const pc = rows(ctx, "action = 'participant.create' AND target_id = 'gamma'")[0];
    assert.equal(pc.thread_id, room);
    assert.deepEqual(JSON.parse(pc.after_state).room_member, { can_read: true, can_post: true });
  });
});

describe('마이그레이션 5 (스키마 4 DB → 새 버전 기동)', () => {
  test('옛 행은 그대로, audit_log 가 생기고 비어 있다가 기록이 쌓인다', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mig5-'));
    const db = new Database(path.join(dataDir, 'brainstorm.db'));
    db.pragma('foreign_keys = ON');
    migrate(db, 4);
    assert.equal(db.pragma('user_version', { simple: true }), 4);
    const t0 = Date.now() - 3_600_000;
    const live = 'bst_strata_live_0123456789';
    const dead = 'bst_ocmain_dead_0123456789';
    db.prepare("INSERT INTO participants(id, kind, name, is_master, passphrase_hash, created_at) VALUES ('master','human','마스터',1,?,?)").run(hashPassphrase(MASTER_PASS), t0);
    db.prepare("INSERT INTO participants(id, kind, name, created_at) VALUES ('strata','agent','Strata',?)").run(t0);
    db.prepare("INSERT INTO participants(id, kind, name, created_at) VALUES ('oc-main','agent','OpenClaw',?)").run(t0);
    db.prepare("INSERT INTO credentials(id, participant_id, token_hash, scope, label, created_at, last_used_at) VALUES ('cred_s','strata',?,'[\"adapter\"]','ct111',?,?)").run(sha256(live), t0, t0 + 1000);
    db.prepare("INSERT INTO credentials(id, participant_id, token_hash, scope, label, created_at, revoked_at, last_used_at) VALUES ('cred_o','oc-main',?,'[\"adapter\"]','ct109',?,?,?)").run(sha256(dead), t0, t0 + 2000, t0 + 1500);
    db.prepare("INSERT INTO threads(id, kind, title, created_by, created_at, updated_at) VALUES ('th_room','room','메인 채팅방','master',?,?)").run(t0, t0);
    for (const p of ['master', 'strata'])
      db.prepare('INSERT INTO thread_members(thread_id, participant_id, can_read, can_post, can_invoke, added_at) VALUES (?,?,1,1,?,?)').run('th_room', p, p === 'master' ? 1 : 0, t0);
    db.close();

    const ctx = await setup({}, dataDir);
    ctx.tokens.strata = { id: 'cred_s', token: live };
    ctx.tokens['oc-main'] = { id: 'cred_o', token: dead };
    try {
      assert.equal((await (await fetch(`${ctx.base}/healthz`)).json()).schema, SCHEMA_VERSION);
      assert.ok(SCHEMA_VERSION >= 5); // 이 시험은 4 → 최신(마이그레이션 5 포함). 5 → 6 은 test/thread-state.test.ts
      const cols = (ctx.app.db.prepare('PRAGMA table_info(audit_log)').all() as any[]).map((c) => c.name);
      for (const c of ['corr_id', 'actor_id', 'actor_kind', 'action', 'target_type', 'target_id', 'thread_id', 'requested_at', 'processed_at', 'result', 'reason', 'before_state', 'after_state', 'repeat_count', 'last_at'])
        assert.ok(cols.includes(c), c);
      // 기동 로그인(시험 준비) 외에는 비어 있다 — 옛 작업을 지어내지 않는다
      assert.deepEqual(rows(ctx).map((r) => r.action), ['auth.login']);
      const c = (await ctx.master('GET', '/api/connections')).json.agents;
      const by = Object.fromEntries(c.map((a: any) => [a.id, a]));
      assert.equal(by.strata.state, 'seen');
      assert.equal(by['oc-main'].state, 'revoked');
      assert.equal(by['oc-main'].room_member, false);
      assert.equal((await ctx.agent('oc-main', 'GET', '/api/me')).status, 401);
      assert.equal(rows(ctx, "action = 'auth.token' AND actor_id = 'oc-main'")[0].reason, 'token_revoked');
      await ctx.restart();
      assert.equal((await (await fetch(`${ctx.base}/healthz`)).json()).schema, SCHEMA_VERSION);
    } finally {
      await ctx.close();
    }
  });
});

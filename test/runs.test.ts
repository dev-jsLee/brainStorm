// 전달·실행: 중복 전달, 어댑터 강제 종료, 취소, 라우팅·고리, 세션 교체
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { ADAPTER, key, newThread, post, setup, sleep, spawnAdapter, waitFor, type Ctx } from './helpers.js';

describe('실행', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(async () => ctx.close());

  const runs = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/runs`)).json.runs as any[];
  const msgs = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages as any[];

  test('중복 전달은 두 번째 실행을 만들지 않는다', async () => {
    const th = await newThread(ctx, '중복 전달', 'alpha');
    await post(ctx, th, 'hello');
    const c1 = (await ctx.agent('alpha', 'POST', '/api/adapter/claim', { worker: 'w1' })).json.claim;
    assert.ok(c1.run.run_token);
    assert.equal(c1.duplicate, false);
    // ack 없이 lease 가 지나면 같은 전달이 다시 나온다(최소 한 번)
    const c2 = await waitFor(async () => (await ctx.agent('alpha', 'POST', '/api/adapter/claim', { worker: 'w2' })).json.claim, 3000);
    assert.equal(c2.delivery.id, c1.delivery.id);
    assert.equal(c2.delivery.attempts, 2);
    assert.equal(c2.duplicate, true);
    assert.equal(c2.run.id, c1.run.id);
    assert.equal(c2.run.run_token, null);
    // 옛 lease 로는 ack 못 한다, 새 lease 로는 된다
    assert.equal((await ctx.agent('alpha', 'POST', `/api/adapter/deliveries/${c1.delivery.id}/ack`, { lease_token: c1.delivery.lease_token })).status, 409);
    assert.equal((await ctx.agent('alpha', 'POST', `/api/adapter/deliveries/${c2.delivery.id}/ack`, { lease_token: c2.delivery.lease_token })).status, 200);
    // 실행 소유자는 첫 claim 쪽
    const tok = c1.run.run_token;
    assert.equal((await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c1.run.id}/start`, { run_token: tok })).status, 200);
    const done = await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c1.run.id}/complete`, { run_token: tok, body: 'reply' });
    assert.equal(done.status, 200);
    // 완료 재전송은 같은 결과(멱등)
    const again = await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c1.run.id}/complete`, { run_token: tok, body: 'reply' });
    assert.equal(again.json.duplicate, true);
    const rs = await runs(th);
    assert.equal(rs.length, 1);
    assert.equal(rs[0].state, 'succeeded');
    assert.equal((await msgs(th)).length, 2);
    // DB 제약도 확인: 같은 (원인, 수신자, 세대) 로 두 번 못 넣는다
    assert.throws(() =>
      ctx.app.db
        .prepare(
          "INSERT INTO runs(id, thread_id, trigger_seq, agent_id, session_id, generation, input_snapshot, state, created_at) SELECT 'dup', thread_id, trigger_seq, agent_id, session_id, generation, '{}', 'failed', 0 FROM runs WHERE id = ?",
        )
        .run(c1.run.id),
    );
  });

  test('실행 중 어댑터를 죽이면 run 은 unknown 이 되고 다시 돌지 않는다', async () => {
    const th = await newThread(ctx, '강제 종료', 'alpha');
    await post(ctx, th, 'slow one');
    const slow = spawnAdapter(ctx, 'alpha', ['--slow-ms', '20000']);
    const running = await waitFor(async () => (await runs(th)).find((r) => r.state === 'running'));
    slow.kill('SIGKILL');
    await slow.exited;
    const unk = await waitFor(async () => (await runs(th)).find((r) => r.id === running.id && r.state === 'unknown'), 5000);
    assert.equal(unk.error, 'lease_expired');
    // 멀쩡한 어댑터가 떠도 같은 원인을 다시 돌리지 않는다
    const fresh = spawnAdapter(ctx, 'alpha', ['--max-idle-ms', '1500']);
    await fresh.exited;
    const rs = await runs(th);
    assert.equal(rs.length, 1);
    assert.equal(rs[0].state, 'unknown');
    assert.equal((await msgs(th)).length, 1, 'no reply message');
    // 옛 worker 의 늦은 완료도 막힌다 (토큰이 지워졌다)
    const late = await ctx.agent('alpha', 'POST', `/api/adapter/runs/${running.id}/complete`, { run_token: 'run_whatever', body: 'late' });
    assert.equal(late.status, 409);
  });

  test('claim 직후 죽으면(--crash-after-claim) 전달은 다시 나오지만 run 은 unknown 으로 남는다', async () => {
    const th = await newThread(ctx, 'claim 뒤 충돌', 'alpha');
    await post(ctx, th, 'crash me');
    const crash = spawnAdapter(ctx, 'alpha', ['--crash-after-claim']);
    assert.equal(await crash.exited, 9);
    await waitFor(async () => (await runs(th)).find((r) => r.state === 'unknown'), 5000);
    const fresh = spawnAdapter(ctx, 'alpha', ['--max-idle-ms', '1500']);
    await fresh.exited;
    assert.match(fresh.output(), /skip run/);
    const rs = await runs(th);
    assert.equal(rs.length, 1);
    assert.equal(rs[0].state, 'unknown');
    assert.equal((await msgs(th)).length, 1);
    const ds = (await ctx.master('GET', `/api/threads/${th}/deliveries`)).json.deliveries;
    assert.equal(ds[0].status, 'acked');
    assert.equal(ds[0].attempts, 2);
  });

  test('취소: «현재 실행 취소»는 도는 run 에 중단을 요청하고, 어댑터가 확인하면 cancelled · 답 없음', async () => {
    const th = await newThread(ctx, '취소', 'alpha');
    await post(ctx, th, 'long task');
    const slow = spawnAdapter(ctx, 'alpha', ['--slow-ms', '20000', '--max-idle-ms', '800']);
    const running = await waitFor(async () => (await runs(th)).find((r) => r.state === 'running'));
    const r = await ctx.master('POST', `/api/threads/${th}/stop`, { mode: 'cancel_current' });
    assert.equal(r.status, 200);
    // 2단계(정책 1): 실행 중인 것은 즉시 cancelled 가 아니라 «중단 요청됨» — 확정은 어댑터 확인으로
    assert.deepEqual(r.json.cancelled_runs, []);
    assert.deepEqual(r.json.cancel_requested_runs, [running.id]);
    await slow.exited;
    assert.match(slow.output(), /run stopped by server/);
    assert.match(slow.output(), /cancel ack \S+ 200 cancelled/);
    const rs = await runs(th);
    assert.equal(rs[0].state, 'cancelled');
    assert.equal(rs[0].cancel_outcome, 'acked');
    assert.equal((await msgs(th)).length, 1);
  });

  test('취소: «현재 실행 취소»는 아직 안 나간 전달도 거둔다(마스터 #475) · 호출 금지는 안 건다', async () => {
    const th = await newThread(ctx, '전달 거두기', 'alpha');
    await post(ctx, th, 'just sent');
    const r = await ctx.master('POST', `/api/threads/${th}/stop`, { mode: 'cancel_current' });
    assert.equal(r.status, 200);
    assert.equal(r.json.withdrawn_deliveries, 1);
    const ds = (await ctx.master('GET', `/api/threads/${th}/deliveries`)).json.deliveries;
    assert.equal(ds[0].status, 'cancelled');
    assert.equal((await ctx.master('GET', `/api/threads/${th}`)).json.thread.invoke_paused, false);
  });

  test('취소: 개별 run 취소 → 중단 확인 → cancelled, 그 뒤 늦은 완료는 거절(이벤트로만)', async () => {
    const th = await newThread(ctx, '개별 취소', 'alpha');
    await post(ctx, th, 'x');
    const c = (await ctx.agent('alpha', 'POST', '/api/adapter/claim', {})).json.claim;
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token });
    const cr = await ctx.master('POST', `/api/runs/${c.run.id}/cancel`);
    assert.equal(cr.status, 200);
    assert.equal(cr.json.outcome, 'requested');
    assert.equal(cr.json.state, 'running');
    const hb = await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c.run.id}/heartbeat`, { run_token: c.run.run_token });
    assert.equal(hb.json.cancel, true);
    const ack = await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c.run.id}/cancelled`, { run_token: c.run.run_token });
    assert.equal(ack.status, 200);
    assert.equal(ack.json.state, 'cancelled');
    const done = await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: 'late' });
    assert.equal(done.status, 409);
    const d = (await ctx.master('GET', `/api/runs/${c.run.id}`)).json;
    assert.equal(d.run.state, 'cancelled');
    assert.ok(d.events.some((e: any) => e.event === 'late_complete' && e.detail.state === 'cancelled'));
    assert.equal((await msgs(th)).length, 1);
  });

  test('멈춤: «새 호출 금지»는 대기 전달을 거두고 새 전달을 안 만든다, 재개하면 다시', async () => {
    const th = await newThread(ctx, '새 호출 금지', 'alpha');
    await post(ctx, th, 'queued before stop');
    assert.equal((await ctx.master('POST', `/api/threads/${th}/stop`, { mode: 'stop_new' })).status, 200);
    const p = await post(ctx, th, 'while paused');
    assert.equal(p.invoke_paused, true);
    assert.equal(p.deliveries.length, 0);
    assert.equal((await ctx.agent('alpha', 'POST', '/api/adapter/claim', {})).json.claim, null);
    const ds = (await ctx.master('GET', `/api/threads/${th}/deliveries`)).json.deliveries;
    assert.deepEqual(
      ds.map((d: any) => d.status),
      ['cancelled'],
    );
    await ctx.master('POST', `/api/threads/${th}/resume`);
    const p2 = await post(ctx, th, 'after resume');
    assert.equal(p2.deliveries.length, 1);
    const c = (await ctx.agent('alpha', 'POST', '/api/adapter/claim', {})).json.claim;
    assert.equal(c.trigger.body, 'after resume');
    await ctx.master('POST', `/api/runs/${c.run.id}/cancel`);
  });

  test('가짜 어댑터 둘: 지정한 쪽으로만 가고, 에이전트→에이전트 고리는 불가능', async () => {
    const th = await newThread(ctx, '둘', 'alpha', ['beta']);
    await post(ctx, th, 'to beta', { recipients: ['beta'] });
    await post(ctx, th, 'to default');
    const A = spawnAdapter(ctx, 'alpha', ['--max-idle-ms', '1200']);
    const B = spawnAdapter(ctx, 'beta', ['--max-idle-ms', '1200']);
    await Promise.all([A.exited, B.exited]);
    const ms = await msgs(th);
    const replies = ms.filter((m) => m.author_id !== 'master');
    assert.equal(replies.length, 2);
    const byAgent = Object.fromEntries(replies.map((m) => [m.author_id, m.body]));
    assert.match(byAgent.beta, /^echo\[thread=.* agent=beta .*\] to beta$/);
    assert.match(byAgent.alpha, /^echo\[thread=.* agent=alpha .*\] to default$/);
    // 에이전트 답은 전달을 만들지 않는다 → 고리 없음
    const ds = (await ctx.master('GET', `/api/threads/${th}/deliveries`)).json.deliveries;
    assert.equal(ds.length, 2);
    assert.equal((await runs(th)).length, 2);
    // 에이전트가 명시적으로 다른 에이전트를 부르려 해도 거절
    const r = await ctx.agent('alpha', 'POST', `/api/threads/${th}/messages`, { client_key: key(), body: 'beta, go', recipients: ['beta'] });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'agent_invocation_disabled');
    // 호출 예산: 수신자 수가 예산을 넘으면 거절
    const over = await ctx.master('POST', `/api/threads/${th}/messages`, { client_key: key(), body: 'both', recipients: ['alpha', 'beta'], call_budget: 1 });
    assert.equal(over.status, 400);
    assert.equal(over.json.error, 'call_budget_exceeded');
  });

  test('세션 교체: 어댑터 명령으로 세대를 올리면 답에 새 세대가 찍힌다', async () => {
    const th = await newThread(ctx, '세대', 'alpha');
    await post(ctx, th, 'gen1');
    await spawnAdapter(ctx, 'alpha', ['--max-idle-ms', '800']).exited;
    // (spawnSync 는 같은 프로세스의 서버를 막아 교착된다 — 비동기로)
    const r = await promisify(execFile)(process.execPath, [ADAPTER, 'rotate', '--url', ctx.base, '--thread', th, '--reason', 'test'], {
      env: { ...process.env, BRAINSTORM_TOKEN: ctx.tokens.alpha.token },
    });
    assert.equal(JSON.parse(r.stdout).session.generation, 2);
    await post(ctx, th, 'gen2');
    await spawnAdapter(ctx, 'alpha', ['--max-idle-ms', '800']).exited;
    const bodies = (await msgs(th)).filter((m) => m.author_id === 'alpha').map((m) => m.body);
    assert.match(bodies[0], /gen=1 .*\] gen1$/);
    assert.match(bodies[1], /gen=2 .*\] gen2$/);
    const t = (await ctx.master('GET', `/api/threads/${th}`)).json;
    const ss = t.sessions.filter((s: any) => s.agent_id === 'alpha');
    assert.deepEqual(
      ss.map((s: any) => [s.generation, s.status]),
      [
        [1, 'retired'],
        [2, 'active'],
      ],
    );
    assert.equal(ss[1].prev_session_id, ss[0].id);
    assert.equal(ss[1].actual_model, 'fake-echo-1');
    await sleep(10);
  });
});

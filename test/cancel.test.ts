// 기획 대조 2단계: 실행 취소 판정(정책 1) · 실행 목록/상세 API · 전달 대기 취소 · 마이그레이션 4
//   대기 중 취소 → cancelled·어댑터 안 돎 / 실행 중 취소 + 확인 → cancelled / 무응답 → unknown·재실행 없음 /
//   경합 두 순서(완료→취소 요청 = succeeded 유지 · 취소 요청→확인 전 완료 = 완료 우선 · 취소 확인→완료 = 409·이벤트만) /
//   이미 끝난 run 취소 → 그대로·안내 / unknown 새로 확인 → 그대로 + last_checked_at
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { BrainstormClient } from '../adapter/openclaw-channel/src/worker.js';
import { hashPassphrase, sha256 } from '../src/crypto.js';
import { migrate, SCHEMA_VERSION } from '../src/db.js';
import { MASTER_PASS, newThread, post, setup, sleep, spawnAdapter, waitFor, type Ctx } from './helpers.js';

const ACK_MS = 600;

describe('실행 취소 판정(정책 1)', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup({ cancelAckMs: ACK_MS });
  });
  after(async () => ctx.close());

  const runs = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/runs`)).json.runs as any[];
  const msgs = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages as any[];
  const detail = async (id: string) => (await ctx.master('GET', `/api/runs/${id}`)).json;
  const A = (p: string, b: unknown = {}) => ctx.agent('alpha', 'POST', p, b);
  /** 전달 하나를 받아 시작까지 — 실행 중(running) run 과 토큰 */
  async function startOne(th: string, body = 'q') {
    await post(ctx, th, body);
    const c = (await A('/api/adapter/claim', { worker: 'manual' })).json.claim;
    await A(`/api/adapter/deliveries/${c.delivery.id}/ack`, { lease_token: c.delivery.lease_token });
    assert.equal((await A(`/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token })).status, 200);
    return { id: c.run.id as string, token: c.run.run_token as string };
  }

  test('끝내지 못한 옛 요청은 다음 claim 맥락에 run_outcome 표시가 붙는다(2026-10-10 마스터 결정)', async () => {
    const th = await newThread(ctx, '취소 맥락 표시', 'alpha');
    const r1 = await startOne(th, '긴 글 써 줘');
    await ctx.master('POST', `/api/runs/${r1.id}/cancel`);
    await A(`/api/adapter/runs/${r1.id}/heartbeat`, { run_token: r1.token });
    assert.equal((await A(`/api/adapter/runs/${r1.id}/cancelled`, { run_token: r1.token })).status, 200);
    await post(ctx, th, '짧게 답해');
    const c = (await A('/api/adapter/claim', { worker: 'w-ctx' })).json.claim;
    const old = c.context.find((m: any) => m.body === '긴 글 써 줘');
    const now = c.context.find((m: any) => m.body === '짧게 답해');
    assert.equal(old.run_outcome, 'cancelled');
    assert.equal(now.run_outcome, undefined);
    await A(`/api/adapter/deliveries/${c.delivery.id}/ack`, { lease_token: c.delivery.lease_token });
    await ctx.master('POST', `/api/runs/${c.run.id}/cancel`);
  });

  test('대기 중 취소 → 즉시 cancelled, 어댑터는 돌리지 않는다', async () => {
    const th = await newThread(ctx, '대기 중 취소', 'alpha');
    await post(ctx, th, 'queued one');
    const c = (await A('/api/adapter/claim', { worker: 'w-q' })).json.claim; // ack 안 함 → 전달은 다시 나간다
    assert.equal(c.run.state, 'queued');
    const r = await ctx.master('POST', `/api/runs/${c.run.id}/cancel`);
    assert.equal(r.status, 200);
    assert.equal(r.json.outcome, 'cancelled');
    assert.equal(r.json.state, 'cancelled');
    assert.equal(r.json.run.cancel_outcome, 'queued_cancelled');
    assert.equal(r.json.run.cancel_requested_by, 'master');
    assert.ok(r.json.run.finalized_at);
    // 그 run_token 으로 시작 못 한다, heartbeat 는 cancel
    assert.equal((await A(`/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token })).status, 409);
    assert.equal((await A(`/api/adapter/runs/${c.run.id}/heartbeat`, { run_token: c.run.run_token })).json.cancel, true);
    // 가짜 어댑터를 띄워도 같은 원인을 돌리지 않는다(다시 나간 전달 → 기존 run → skip)
    const fa = spawnAdapter(ctx, 'alpha', ['--max-idle-ms', '1200']);
    await fa.exited;
    assert.match(fa.output(), /skip run/);
    assert.doesNotMatch(fa.output(), /complete/);
    assert.equal((await msgs(th)).length, 1);
    const rs = await runs(th);
    assert.equal(rs.length, 1);
    assert.equal(rs[0].state, 'cancelled');
    const ev = (await detail(c.run.id)).events.map((e: any) => e.event);
    assert.deepEqual(ev, ['created', 'cancel_requested', 'finalized']);
  });

  test('실행 중 취소 → 중단 요청됨 → 가짜 어댑터가 확인 → cancelled(중단 완료), 답 없음', async () => {
    const th = await newThread(ctx, '실행 중 취소', 'alpha');
    await post(ctx, th, 'long');
    const fa = spawnAdapter(ctx, 'alpha', ['--slow-ms', '20000', '--max-idle-ms', '600']);
    const running = await waitFor(async () => (await runs(th)).find((r) => r.state === 'running'));
    const r = await ctx.master('POST', `/api/runs/${running.id}/cancel`);
    assert.equal(r.json.outcome, 'requested');
    assert.equal(r.json.state, 'running');
    assert.equal(r.json.run.cancel_outcome, 'requested');
    // 무응답 제한: 중단 명령이 실리기 전에는 요청 시각부터, 실린 뒤에는 명령 시각부터
    const rr = r.json.run;
    assert.equal(rr.cancel_deadline_at, (rr.stop_sent_at ?? rr.cancel_requested_at) + ACK_MS);
    // 같은 요청을 또 눌러도 한 번
    assert.equal((await ctx.master('POST', `/api/runs/${running.id}/cancel`)).json.outcome, 'already_requested');
    await fa.exited;
    assert.match(fa.output(), /cancel ack \S+ 200 cancelled/);
    const d = await detail(running.id);
    assert.equal(d.run.state, 'cancelled');
    assert.equal(d.run.cancel_outcome, 'acked');
    assert.ok(d.run.stop_sent_at >= d.run.cancel_requested_at);
    assert.ok(d.run.stop_ack_at >= d.run.stop_sent_at);
    assert.equal(d.run.finalized_at, d.run.stop_ack_at);
    const ev = d.events.map((e: any) => `${e.event}:${e.source}`);
    assert.ok(ev.includes('cancel_repeat:master'));
    assert.deepEqual(
      ev.filter((x: string) => x !== 'cancel_repeat:master'),
      ['created:server', 'started:alpha', 'cancel_requested:master', 'stop_sent:server', 'stop_ack:alpha', 'finalized:server'],
    );
    assert.equal((await msgs(th)).length, 1);
  });

  test('어댑터 무응답(--no-cancel-ack) → 제한 시간 뒤 unknown, 다시 돌리지 않는다', async () => {
    const th = await newThread(ctx, '무응답', 'alpha');
    await post(ctx, th, 'never acks');
    const fa = spawnAdapter(ctx, 'alpha', ['--slow-ms', '20000', '--no-cancel-ack', '--max-idle-ms', '2500']);
    const running = await waitFor(async () => (await runs(th)).find((r) => r.state === 'running'));
    const t0 = Date.now();
    await ctx.master('POST', `/api/runs/${running.id}/cancel`);
    const unk = await waitFor(async () => (await runs(th)).find((r) => r.id === running.id && r.state === 'unknown'), 5000);
    assert.ok(Date.now() - t0 >= ACK_MS - 50, 'unknown 은 무응답 제한이 지난 뒤');
    assert.equal(unk.error, 'cancel_ack_timeout');
    assert.equal(unk.cancel_outcome, 'no_ack');
    await fa.exited;
    assert.match(fa.output(), /cancel ack skipped/);
    // 새 어댑터가 떠도 재실행 없음
    const fresh = spawnAdapter(ctx, 'alpha', ['--max-idle-ms', '1000']);
    await fresh.exited;
    assert.equal((await runs(th)).length, 1);
    assert.equal((await runs(th))[0].state, 'unknown');
    assert.equal((await msgs(th)).length, 1);
    const ev = (await detail(running.id)).events.map((e: any) => e.event);
    assert.deepEqual(ev.slice(-3), ['stop_sent', 'cancel_ack_timeout', 'finalized']);
  });

  test('무응답 unknown 뒤 늦게 온 확인·완료는 상태를 안 바꾸고 이벤트로만 남는다', async () => {
    const th = await newThread(ctx, '늦은 확인', 'alpha');
    const { id, token } = await startOne(th);
    await ctx.master('POST', `/api/runs/${id}/cancel`);
    const hb = (await A(`/api/adapter/runs/${id}/heartbeat`, { run_token: token })).json;
    assert.equal(hb.cancel, true);
    const mid = (await detail(id)).run;
    assert.ok(mid.stop_sent_at >= mid.cancel_requested_at);
    assert.equal(mid.cancel_deadline_at, mid.stop_sent_at + ACK_MS, '명령이 실린 뒤에는 명령 시각부터 센다');
    assert.equal(hb.cancel_deadline_at, mid.cancel_deadline_at);
    await waitFor(async () => (await detail(id)).run.state === 'unknown', 4000);
    const ev = (await detail(id)).events.find((e: any) => e.event === 'cancel_ack_timeout');
    assert.ok(ev.detail.waited_ms >= ACK_MS && ev.detail.stop_sent === true);
    const ack = await A(`/api/adapter/runs/${id}/cancelled`, { run_token: token });
    assert.equal(ack.status, 409);
    const done = await A(`/api/adapter/runs/${id}/complete`, { run_token: token, body: 'too late' });
    assert.equal(done.status, 409);
    assert.equal((await A(`/api/adapter/runs/${id}/heartbeat`, { run_token: token })).status, 409);
    const d = await detail(id);
    assert.equal(d.run.state, 'unknown');
    const late = d.events.filter((e: any) => e.event.startsWith('late_')).map((e: any) => [e.event, e.detail.state]);
    assert.deepEqual(late, [
      ['late_stop_ack', 'unknown'],
      ['late_complete', 'unknown'],
    ]);
    assert.ok(!(await msgs(th)).some((m) => m.body === 'too late'));
  });

  test('경합 ①: 완료 → 취소 요청 = succeeded 유지, «이미 끝난 실행» 안내', async () => {
    const th = await newThread(ctx, '경합1', 'alpha');
    const { id, token } = await startOne(th);
    assert.equal((await A(`/api/adapter/runs/${id}/complete`, { run_token: token, body: 'done first' })).status, 200);
    const r = await ctx.master('POST', `/api/runs/${id}/cancel`);
    assert.equal(r.status, 200);
    assert.equal(r.json.outcome, 'already_final');
    assert.equal(r.json.state, 'succeeded');
    assert.equal(r.json.run.cancel_outcome, null);
    assert.equal(r.json.run.cancel_requested_at, null);
    const d = await detail(id);
    assert.equal(d.events.at(-1).event, 'cancel_after_final');
    assert.equal(d.output.message.body, 'done first');
  });

  test('경합 ②: 취소 요청 → (확인 전) 완료 = 완료 우선 확정(succeeded·답 보임), 그 뒤 확인은 409·이벤트만', async () => {
    const th = await newThread(ctx, '경합2', 'alpha');
    const { id, token } = await startOne(th);
    assert.equal((await ctx.master('POST', `/api/runs/${id}/cancel`)).json.outcome, 'requested');
    const done = await A(`/api/adapter/runs/${id}/complete`, { run_token: token, body: 'finished anyway' });
    assert.equal(done.status, 200);
    assert.equal(done.json.run.state, 'succeeded');
    assert.equal(done.json.run.cancel_outcome, 'completed_first');
    assert.ok((await msgs(th)).some((m) => m.body === 'finished anyway'), '답 메시지가 보인다');
    assert.equal((await A(`/api/adapter/runs/${id}/cancelled`, { run_token: token })).status, 409);
    const d = await detail(id);
    assert.equal(d.run.state, 'succeeded');
    const ev = d.events.map((e: any) => e.event);
    assert.deepEqual(ev.slice(-4), ['cancel_requested', 'completed', 'finalized', 'late_stop_ack']);
    assert.equal(d.events.find((e: any) => e.event === 'finalized').detail.completed_first, true);
  });

  test('경합 ③: 취소 확인 → 완료 = 409, 상태 cancelled 그대로(이벤트만)', async () => {
    const th = await newThread(ctx, '경합3', 'alpha');
    const { id, token } = await startOne(th);
    await ctx.master('POST', `/api/runs/${id}/cancel`);
    assert.equal((await A(`/api/adapter/runs/${id}/cancelled`, { run_token: token })).json.state, 'cancelled');
    // 확인은 멱등
    assert.equal((await A(`/api/adapter/runs/${id}/cancelled`, { run_token: token })).json.duplicate, true);
    assert.equal((await A(`/api/adapter/runs/${id}/complete`, { run_token: token, body: 'late' })).status, 409);
    assert.equal((await A(`/api/adapter/runs/${id}/fail`, { run_token: token, error: 'x' })).status, 409);
    const d = await detail(id);
    assert.equal(d.run.state, 'cancelled');
    assert.deepEqual(
      d.events.filter((e: any) => e.event.startsWith('late_')).map((e: any) => e.event),
      ['late_complete', 'late_fail'],
    );
  });

  test('확인 전 실패 = 실패 우선(failed 유지) · 요청 안 된 실행의 확인은 409', async () => {
    const th = await newThread(ctx, '실패 우선', 'alpha');
    const { id, token } = await startOne(th);
    assert.equal((await A(`/api/adapter/runs/${id}/cancelled`, { run_token: token })).json.error, 'no_cancel_request');
    await ctx.master('POST', `/api/runs/${id}/cancel`);
    assert.equal((await A(`/api/adapter/runs/${id}/fail`, { run_token: token, error: 'upstream 502' })).status, 200);
    const d = await detail(id);
    assert.equal(d.run.state, 'failed');
    assert.equal(d.run.cancel_outcome, 'failed_first');
  });

  test('이미 끝난 run 취소 → 상태 그대로(failed·unknown), 안내 결과', async () => {
    const th = await newThread(ctx, '이미 끝남', 'alpha');
    const { id, token } = await startOne(th);
    await A(`/api/adapter/runs/${id}/fail`, { run_token: token, error: 'boom' });
    const r = await ctx.master('POST', `/api/runs/${id}/cancel`);
    assert.equal(r.json.outcome, 'already_final');
    assert.equal(r.json.state, 'failed');
    assert.equal((await detail(id)).run.error, 'boom');
    assert.equal((await ctx.master('POST', '/api/runs/run_nope/cancel')).status, 404);
    // 에이전트는 취소 못 한다
    assert.equal((await ctx.agent('alpha', 'POST', `/api/runs/${id}/cancel`)).status, 403);
  });

  test('unknown 새로 확인 → 상태 그대로 + last_checked_at 갱신 · 재실행 없음', async () => {
    const th = await newThread(ctx, '새로 확인', 'alpha');
    const { id } = await startOne(th);
    // heartbeat 를 안 보내면 run lease(1.5초)가 지나 unknown
    await waitFor(async () => (await detail(id)).run.state === 'unknown', 5000);
    const r1 = await ctx.master('POST', `/api/runs/${id}/refresh`);
    assert.equal(r1.status, 200);
    assert.equal(r1.json.run.state, 'unknown');
    assert.equal(r1.json.run.error, 'lease_expired');
    const c1 = r1.json.run.last_checked_at;
    assert.ok(c1 && c1 >= r1.json.run.finalized_at);
    await sleep(15);
    const r2 = await ctx.master('POST', `/api/runs/${id}/refresh`);
    assert.ok(r2.json.run.last_checked_at > c1);
    assert.equal(r2.json.run.state, 'unknown');
    assert.equal(r2.json.events.filter((e: any) => e.event === 'checked').length, 2);
    assert.equal((await runs(th)).length, 1);
    assert.equal((await ctx.agent('alpha', 'POST', `/api/runs/${id}/refresh`)).status, 403);
  });

  test('«현재 실행 취소»: 대기 중은 즉시 취소, 실행 중은 중단 요청', async () => {
    const th = await newThread(ctx, '섞임', 'alpha', ['beta']);
    const { id: running } = await startOne(th, 'to alpha');
    await post(ctx, th, 'to beta', { recipients: ['beta'] });
    const qb = (await ctx.agent('beta', 'POST', '/api/adapter/claim', {})).json.claim;
    const r = await ctx.master('POST', `/api/threads/${th}/stop`, { mode: 'cancel_current' });
    assert.deepEqual(r.json.cancelled_runs, [qb.run.id]);
    assert.deepEqual(r.json.cancel_requested_runs, [running]);
    await waitFor(async () => (await detail(running)).run.state === 'unknown', 4000);
  });
});

describe('실행 목록 · 상세 · 전달 대기 취소', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup({ cancelAckMs: ACK_MS });
  });
  after(async () => ctx.close());

  test('GET /api/runs: 스레드를 가로지르고 상태·에이전트·스레드·기간으로 거른다', async () => {
    const th1 = await newThread(ctx, '목록1', 'alpha', ['beta']);
    const th2 = await newThread(ctx, '목록2', 'beta');
    await post(ctx, th1, 'a1');
    const c = (await ctx.agent('alpha', 'POST', '/api/adapter/claim', {})).json.claim;
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token });
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: 'ok' });
    await post(ctx, th2, 'b1');
    const c2 = (await ctx.agent('beta', 'POST', '/api/adapter/claim', {})).json.claim;
    await ctx.agent('beta', 'POST', `/api/adapter/runs/${c2.run.id}/start`, { run_token: c2.run.run_token });
    await ctx.master('POST', `/api/runs/${c2.run.id}/cancel`); // 중단 요청됨
    await post(ctx, th1, 'b2 waiting', { recipients: ['beta'] }); // beta 는 th2 실행이 끝날 때까지 이건 claim 해도… 전달 대기로 둔다

    const all = (await ctx.master('GET', '/api/runs')).json;
    assert.equal(all.total, 2);
    assert.deepEqual(
      all.runs.map((r: any) => [r.thread_title, r.state]),
      [
        ['목록2', 'running'],
        ['목록1', 'succeeded'],
      ],
    );
    assert.equal(all.runs[0].cancel_outcome, 'requested');
    assert.equal(all.runs[0].thread_kind, 'thread');
    assert.equal(all.cancel_ack_ms, ACK_MS);
    assert.equal(all.waiting.length, 1);
    assert.equal(all.waiting[0].recipient_id, 'beta');
    assert.equal(all.waiting[0].thread_title, '목록1');

    const q = async (qs: string) => (await ctx.master('GET', `/api/runs?${qs}`)).json;
    assert.deepEqual((await q('agent=alpha')).runs.map((r: any) => r.id), [c.run.id]);
    assert.deepEqual((await q(`thread=${th2}`)).runs.map((r: any) => r.id), [c2.run.id]);
    assert.deepEqual((await q('state=cancel_requested')).runs.map((r: any) => r.id), [c2.run.id]);
    assert.equal((await q('state=cancel_requested')).waiting.length, 0);
    assert.equal((await q('state=succeeded')).total, 1);
    const w = await q('state=waiting');
    assert.equal(w.runs.length, 0);
    assert.equal(w.waiting.length, 1);
    // 기간: 미래 시각부터 → 끝난 실행은 빠지고 진행 중은 남는다
    assert.deepEqual((await q(`since=${Date.now() + 60_000}`)).runs.map((r: any) => r.id), [c2.run.id]);
    assert.equal((await ctx.master('GET', '/api/runs?state=nope')).status, 400);
    // 마스터만
    assert.equal((await ctx.agent('alpha', 'GET', '/api/runs')).status, 403);
  });

  test('GET /api/runs/:id: 기본 정보·입력·출력·이벤트 / 멤버 아닌 에이전트에게는 없음', async () => {
    const th = await newThread(ctx, '상세', 'alpha');
    await post(ctx, th, '맥락 글', { recipients: [] });
    await post(ctx, th, '질문');
    const c = (await ctx.agent('alpha', 'POST', '/api/adapter/claim', { worker: 'w-detail' })).json.claim;
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token, runtime: 'fake', config_version: 'v9' });
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: '답', model: 'm-actual', usage: { tokens: { completion_tokens: 7 } } });
    const d = (await ctx.master('GET', `/api/runs/${c.run.id}`)).json;
    assert.equal(d.thread.title, '상세');
    assert.equal(d.agent.name, 'ALPHA');
    assert.equal(d.session.generation, 1);
    assert.equal(d.session.actual_model, 'm-actual');
    assert.equal(d.input.trigger.body, '질문');
    assert.equal(d.input.seqs.length, 2);
    assert.equal(d.input.worker, 'w-detail');
    assert.equal(d.output.message.body, '답');
    assert.equal(d.run.usage.tokens.completion_tokens, 7);
    assert.deepEqual(
      d.events.map((e: any) => e.event),
      ['created', 'started', 'completed', 'finalized'],
    );
    assert.equal(d.events[1].detail.config_version, 'v9');
    // 이벤트에 본문이 없다
    assert.ok(!JSON.stringify(d.events).includes('질문') && !JSON.stringify(d.events).includes('"답"'));
    assert.equal((await ctx.agent('beta', 'GET', `/api/runs/${c.run.id}`)).status, 404);
    assert.equal((await ctx.agent('alpha', 'GET', `/api/runs/${c.run.id}`)).status, 200);
  });

  test('전달 대기(실행 없음) 취소 → 어댑터가 안 가져간다 · 실행이 생긴 전달은 409 has_run', async () => {
    const th = await newThread(ctx, '전달 취소', 'alpha');
    const p = await post(ctx, th, 'wait');
    const did = p.deliveries[0];
    const r = await ctx.master('POST', `/api/deliveries/${did}/cancel`);
    assert.equal(r.status, 200);
    assert.equal(r.json.outcome, 'cancelled');
    assert.equal(r.json.delivery.status, 'cancelled');
    assert.equal(r.json.delivery.last_error, 'cancelled_by_master');
    assert.equal((await ctx.agent('alpha', 'POST', '/api/adapter/claim', {})).json.claim, null);
    assert.equal((await ctx.master('POST', `/api/deliveries/${did}/cancel`)).json.outcome, 'already_final');
    const p2 = await post(ctx, th, 'claimed');
    await ctx.agent('alpha', 'POST', '/api/adapter/claim', {});
    const r2 = await ctx.master('POST', `/api/deliveries/${p2.deliveries[0]}/cancel`);
    assert.equal(r2.status, 409);
    assert.equal(r2.json.error, 'has_run');
    assert.equal((await ctx.agent('alpha', 'POST', `/api/deliveries/${did}/cancel`)).status, 403);
  });
});

describe('어댑터 호환', () => {
  test('BrainstormClient.ackCancel: 옛 서버(라우트 없음 404) → unsupported · 409 → rejected · 200 → acked', async () => {
    const mk = (status: number, body: unknown) =>
      new BrainstormClient('http://x', 't', (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch);
    assert.equal(await mk(404, { message: 'Route POST:/api/adapter/runs/r/cancelled not found', error: 'Not Found', statusCode: 404 }).ackCancel('r', 'k'), 'unsupported');
    assert.equal(await mk(404, { error: 'no_run' }).ackCancel('r', 'k'), 'rejected');
    assert.equal(await mk(409, { error: 'bad_state' }).ackCancel('r', 'k'), 'rejected');
    assert.equal(await mk(200, { ok: true, state: 'cancelled' }).ackCancel('r', 'k'), 'acked');
  });
});

describe('마이그레이션 4 (스키마 3 DB → 새 버전 기동)', () => {
  test('옛 runs 는 그대로, 새 칸은 비고, 옛 즉시 취소는 legacy, 옛 서버에서 시작된 실행도 새 판정으로 취소된다', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mig4-'));
    const db = new Database(path.join(dataDir, 'brainstorm.db'));
    db.pragma('foreign_keys = ON');
    migrate(db, 3);
    assert.equal(db.pragma('user_version', { simple: true }), 3);
    const t0 = Date.now() - 3_600_000;
    const tok = 'bst_oldtoken_0123456789abcdef';
    db.prepare("INSERT INTO participants(id, kind, name, is_master, passphrase_hash, created_at) VALUES ('master','human','마스터',1,?,?)").run(hashPassphrase(MASTER_PASS), t0);
    db.prepare("INSERT INTO participants(id, kind, name, created_at) VALUES ('strata','agent','Strata',?)").run(t0);
    db.prepare("INSERT INTO credentials(id, participant_id, token_hash, scope, created_at) VALUES ('cred_old','strata',?,'[\"adapter\"]',?)").run(sha256(tok), t0);
    db.prepare("INSERT INTO threads(id, kind, title, created_by, created_at, updated_at) VALUES ('th_room','room','메인 채팅방','master',?,?)").run(t0, t0);
    for (const p of ['master', 'strata'])
      db.prepare('INSERT INTO thread_members(thread_id, participant_id, can_read, can_post, can_invoke, added_at) VALUES (?,?,1,1,?,?)').run('th_room', p, p === 'master' ? 1 : 0, t0);
    const msg = (id: string, author: string, body: string) =>
      Number(
        db
          .prepare("INSERT INTO messages(id, thread_id, author_id, client_key, body, source_kind, recipients, created_at) VALUES (?,'th_room',?,?,?,?,'[]',?)")
          .run(id, author, `k-${id}`, body, author === 'master' ? 'instruction' : 'proposal', t0).lastInsertRowid,
      );
    const s1 = msg('m1', 'master', '첫 질문');
    const s2 = msg('m2', 'strata', '첫 답');
    const s3 = msg('m3', 'master', '취소된 질문');
    const s4 = msg('m4', 'master', '도는 중인 질문');
    db.prepare("INSERT INTO agent_sessions(id, thread_id, agent_id, generation, status, reason, created_at) VALUES ('ses_o','th_room','strata',1,'active','first',?)").run(t0);
    const ins = db.prepare(
      `INSERT INTO runs(id, thread_id, trigger_seq, agent_id, session_id, generation, input_snapshot, state, run_token_hash, lease_expires_at, cancel_requested, created_at, started_at, ended_at, error, result_seq)
       VALUES (?, 'th_room', ?, 'strata', 'ses_o', 1, '{"seqs":[]}', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run('run_ok', s1, 'succeeded', null, null, 0, t0, t0 + 1000, t0 + 5000, null, s2);
    ins.run('run_cx', s3, 'cancelled', null, null, 1, t0, t0 + 1000, t0 + 2000, 'cancelled_by_master', null);
    const runTok = 'run_oldrun_token_abcdef';
    ins.run('run_live', s4, 'running', sha256(runTok), Date.now() + 600_000, 0, t0, Date.now() - 1000, null, null, null);
    db.close();

    const ctx = await setup({ cancelAckMs: ACK_MS }, dataDir);
    ctx.tokens.strata = { id: 'cred_old', token: tok };
    try {
      const h = await (await fetch(`${ctx.base}/healthz`)).json();
      assert.equal(h.schema, SCHEMA_VERSION);
      assert.ok(SCHEMA_VERSION >= 4);
      const cols = (ctx.app.db.prepare('PRAGMA table_info(runs)').all() as any[]).map((c) => c.name);
      for (const c of ['cancel_requested_by', 'cancel_requested_at', 'stop_sent_at', 'stop_ack_at', 'finalized_at', 'last_checked_at']) assert.ok(cols.includes(c), c);
      assert.equal((ctx.app.db.prepare('SELECT COUNT(*) AS n FROM run_events').get() as any).n, 0);

      const list = (await ctx.master('GET', '/api/runs')).json;
      const by = Object.fromEntries(list.runs.map((r: any) => [r.id, r]));
      assert.equal(by.run_ok.state, 'succeeded');
      assert.equal(by.run_ok.finalized_at, null);
      assert.equal(by.run_ok.cancel_outcome, null);
      assert.equal(by.run_cx.state, 'cancelled');
      assert.equal(by.run_cx.cancel_outcome, 'legacy');
      assert.equal(by.run_live.state, 'running');
      const d = (await ctx.master('GET', '/api/runs/run_ok')).json;
      assert.deepEqual(d.events, []);
      assert.equal(d.output.message.body, '첫 답');

      // 옛 서버에서 시작된 실행: 새 판정으로 중단 요청 → heartbeat 가 cancel → 확인 → cancelled
      assert.equal((await ctx.master('POST', '/api/runs/run_live/cancel')).json.outcome, 'requested');
      assert.equal((await ctx.agent('strata', 'POST', '/api/adapter/runs/run_live/heartbeat', { run_token: runTok })).json.cancel, true);
      const ack = await ctx.agent('strata', 'POST', '/api/adapter/runs/run_live/cancelled', { run_token: runTok });
      assert.equal(ack.json.state, 'cancelled');
      assert.equal((await ctx.master('GET', '/api/runs/run_live')).json.run.cancel_outcome, 'acked');
      await ctx.restart();
      assert.equal((await (await fetch(`${ctx.base}/healthz`)).json()).schema, SCHEMA_VERSION);
    } finally {
      await ctx.close();
    }
  });
});

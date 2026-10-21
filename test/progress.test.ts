// 읽음·경과(2026-10-13 마스터 «읽었다는 반응을 되돌려주어 반응없음이 안 나오게» · 마이그레이션 9)
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { newThread, post, setup, type Ctx } from './helpers.js';

let ctx: Ctx;
before(async () => {
  ctx = await setup();
});
after(() => ctx.close());

test('heartbeat 의 경과 한 줄 → run.progress · 마지막 신호 시각 · 빈 경과는 안 지운다 · 300자 · 공백 접기', async () => {
  const th = await newThread(ctx, '경과', 'alpha');
  await post(ctx, th, '해 줘');
  const c = (await ctx.agent('alpha', 'POST', '/api/adapter/claim', { worker: 't' })).json.claim;
  const rid = c.run.id;
  const tok = c.run.run_token;
  await ctx.agent('alpha', 'POST', `/api/adapter/runs/${rid}/start`, { run_token: tok });
  const run = async () => (await ctx.master('GET', `/api/threads/${th}/runs`)).json.runs.find((x: any) => x.id === rid);
  assert.equal((await run()).progress, null);
  assert.equal((await ctx.agent('alpha', 'POST', `/api/adapter/runs/${rid}/heartbeat`, { run_token: tok, progress: '읽었음 — 작업 시작' })).status, 200);
  let r = await run();
  assert.equal(r.progress, '읽었음 — 작업 시작');
  assert.ok(r.progress_at > 0 && r.heartbeat_at >= r.progress_at);
  const hb1 = r.heartbeat_at;
  await new Promise((s) => setTimeout(s, 20));
  await ctx.agent('alpha', 'POST', `/api/adapter/runs/${rid}/heartbeat`, { run_token: tok });
  r = await run();
  assert.equal(r.progress, '읽었음 — 작업 시작', '경과 없는 박동은 경과를 지우지 않는다');
  assert.ok(r.heartbeat_at > hb1);
  await ctx.agent('alpha', 'POST', `/api/adapter/runs/${rid}/heartbeat`, { run_token: tok, progress: `도구\n  Bash ${'x'.repeat(400)}` });
  r = await run();
  assert.equal(r.progress.length, 300);
  assert.ok(r.progress.startsWith('도구 Bash xxx'));
  // 남의 토큰은 경과를 못 쓴다
  assert.equal((await ctx.agent('beta', 'POST', `/api/adapter/runs/${rid}/heartbeat`, { run_token: tok, progress: '가짜' })).status >= 400, true);
});

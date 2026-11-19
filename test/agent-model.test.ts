// 에이전트별 모델(2026-11-04 마스터 «브레인스톰에서도 각 에이전트의 모델을 변경할 수 있는 기능»)
//   meta 'agent_model:<id>' · PUT /api/agents/:id/model(마스터만) · claim.model · 연결 화면 model/last_model · 감사 agents.model
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { newThread, post, setup, type Ctx } from './helpers.js';

describe('에이전트별 모델', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(async () => ctx.close());

  test('권한·검사: 에이전트는 403 · 없는 에이전트 404 · 사람 404 · 이상한 이름 400', async () => {
    assert.equal((await ctx.agent('alpha', 'PUT', '/api/agents/alpha/model', { model: 'opus' })).status, 403);
    assert.equal((await ctx.master('PUT', '/api/agents/nobody/model', { model: 'opus' })).status, 404);
    assert.equal((await ctx.master('PUT', '/api/agents/master/model', { model: 'opus' })).status, 404);
    for (const bad of ['a b', '--resume', 'x;rm', 'x'.repeat(101), 12])
      assert.equal((await ctx.master('PUT', '/api/agents/alpha/model', { model: bad })).status, 400, String(bad));
  });

  test('정하면 claim 에 실리고 연결 화면에 보임 · 다른 에이전트는 null · 비우면 null', async () => {
    const r = await ctx.master('PUT', '/api/agents/alpha/model', { model: ' claude-opus-5-5[1m] ' });
    assert.equal(r.status, 200);
    assert.equal(r.json.model, 'claude-opus-5-5[1m]');
    const th = await newThread(ctx, '모델', 'alpha', ['beta']);
    await post(ctx, th, '안녕', { recipients: ['alpha', 'beta'] });
    const ca = (await ctx.agent('alpha', 'POST', '/api/adapter/claim', {})).json.claim;
    assert.equal(ca.model, 'claude-opus-5-5[1m]');
    const cb = (await ctx.agent('beta', 'POST', '/api/adapter/claim', {})).json.claim;
    assert.equal(cb.model, null);
    const conn = (await ctx.master('GET', '/api/connections')).json.agents;
    assert.equal(conn.find((a: any) => a.id === 'alpha').model, 'claude-opus-5-5[1m]');
    assert.equal(conn.find((a: any) => a.id === 'beta').model, null);
    assert.equal((await ctx.master('PUT', '/api/agents/alpha/model', { model: '' })).json.model, null);
    assert.equal((await ctx.master('GET', '/api/connections')).json.agents.find((a: any) => a.id === 'alpha').model, null);
  });

  test('감사: agents.model before/after', async () => {
    const audit = (await ctx.master('GET', '/api/audit?limit=200')).json;
    const rows: any[] = audit.rows ?? audit.entries ?? audit.audit ?? [];
    const m = rows.filter((r) => r.action === 'agents.model' && r.result === 'ok');
    assert.ok(m.length >= 2);
    assert.ok(rows.some((r) => r.action === 'agents.model' && r.result === 'denied'));
  });
});

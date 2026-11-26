// 멤버별 권한 보기(마스터 #2030): GET /api/participants/:id/memberships — 대화마다 member·can_read·can_post · 마스터만 · 지운 대화 안 셈
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { newThread, setup, type Ctx } from './helpers.js';

describe('멤버별 권한 보기', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup({});
  });
  after(async () => ctx.close());

  test('대화마다 권한 · 바꾸면 그대로 보임 · 마스터만', async () => {
    const th = await newThread(ctx, '멤버별 시험', null);
    await ctx.master('POST', `/api/threads/${th}/members`, { participant_id: 'beta', can_read: true, can_post: false });
    let r = await ctx.master('GET', '/api/participants/beta/memberships');
    assert.equal(r.status, 200);
    assert.equal(r.json.participant_id, 'beta');
    const threads = (await ctx.master('GET', '/api/threads')).json.threads as any[];
    assert.equal(r.json.memberships.length, threads.filter((t) => !t.deleted_at).length);
    assert.equal(r.json.memberships[0].thread_id, threads.find((t) => t.kind === 'room').id, '채팅방이 맨 앞');
    assert.deepEqual(r.json.memberships.find((m: any) => m.thread_id === th), { thread_id: th, member: true, can_read: true, can_post: false });
    await ctx.master('POST', `/api/threads/${th}/members`, { participant_id: 'beta', remove: true });
    r = await ctx.master('GET', '/api/participants/beta/memberships');
    assert.deepEqual(r.json.memberships.find((m: any) => m.thread_id === th), { thread_id: th, member: false });
    assert.equal((await ctx.master('GET', '/api/participants/nobody/memberships')).status, 404);
    assert.equal((await ctx.agent('alpha', 'GET', '/api/participants/beta/memberships')).status, 403);
  });
});

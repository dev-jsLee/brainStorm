// 태그 관리 — 숨김 · 휴지통 · 영구 삭제(2026-11-19 마스터 «기존 태그를 삭제하거나 숨기는 기능» · 마이그레이션 21).
//   숨김 = 목록·고르개·자동완성·답장 상속에서만 빠짐(인식·태그 방·글쓰기는 그대로) · 휴지통 = 인식 멈춤 · 연결은 지킴 · 되살리기 ·
//   영구 삭제 = 휴지통 것만 · 연결과 행을 지움 · 같은 이름을 다시 만들 수 있음 · 셋 다 마스터만.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { newThread, post, setup, type Ctx } from './helpers.js';

describe('태그 관리: 숨김 · 휴지통 · 영구 삭제', () => {
  let ctx: Ctx;
  let th: string;
  let H: string; // 숨길 태그
  let T: string; // 버릴 태그
  let K: string; // 그대로 둘 태그
  const tagsOf = async (q = '') => (await ctx.master('GET', `/api/tags${q}`)).json.tags as any[];
  const msg = async (seq: number) => (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages.find((m: any) => m.seq === seq);
  const links = (id: string) => (ctx.app.db.prepare('SELECT COUNT(*) AS n FROM message_tags WHERE tag_id = ?').get(id) as { n: number }).n;
  before(async () => {
    ctx = await setup();
    th = await newThread(ctx, '태그 관리 방', 'alpha', ['alpha']);
    H = (await ctx.master('POST', '/api/tags', { name: '숨길것' })).json.tag.id;
    T = (await ctx.master('POST', '/api/tags', { name: '버릴것' })).json.tag.id;
    K = (await ctx.master('POST', '/api/tags', { name: '남길것' })).json.tag.id;
  });
  after(() => ctx.close());

  test('숨김: 기본 목록에서 빠지고 ?hidden=1 로만 · 인식·명시 태그·태그 방은 그대로 · 답장 상속에서 빠짐 · 에이전트 403 · 해제', async () => {
    const src = await post(ctx, th, '#숨길것 #남길것\n원문', { recipients: [] });
    assert.equal((await ctx.agent('alpha', 'PATCH', `/api/tags/${H}`, { hidden: true })).status, 403);
    assert.equal((await ctx.master('PATCH', `/api/tags/${H}`, { hidden: 'yes' })).status, 400);
    const h = await ctx.master('PATCH', `/api/tags/${H}`, { hidden: true });
    assert.equal(h.status, 200);
    assert.ok(h.json.tag.hidden_at);
    assert.ok(!(await tagsOf()).some((t) => t.id === H));
    assert.ok((await tagsOf('?hidden=1')).some((t) => t.id === H && t.hidden_at));
    // 인식은 그대로
    const p = await post(ctx, th, '#숨길것\n숨겨도 붙는다', { recipients: [] });
    assert.deepEqual(p.message.tags.primary.map((t: any) => t.id), [H]);
    const ex = await post(ctx, th, '태그 방 글', { tags: [H], recipients: [] });
    assert.deepEqual(ex.message.tags.primary.map((t: any) => t.id), [H]);
    assert.equal((await ctx.master('GET', `/api/tags/${H}/messages`)).status, 200);
    // 답장 상속에서 빠짐(#1795 의 원문 태그 따라가기)
    const rep = await post(ctx, th, '답', { reply_to_seq: src.message.seq, recipients: [] });
    assert.deepEqual(rep.message.tags.primary.map((t: any) => t.id), [K]);
    const un = await ctx.master('PATCH', `/api/tags/${H}`, { hidden: false });
    assert.equal(un.json.tag.hidden_at, null);
    assert.ok((await tagsOf()).some((t) => t.id === H));
  });

  test('휴지통: 인식 멈춤 · 글 칩에서 빠지되 연결은 지킴 · 보기 404 tag_in_trash · 같은 이름 409 · 고치기 409 · 명시 태그 400 · 에이전트 403 · 되살리면 원상', async () => {
    const old = await post(ctx, th, '#버릴것\n옛 글', { recipients: [] });
    assert.equal(links(T), 1);
    assert.equal((await ctx.agent('alpha', 'POST', `/api/tags/${T}/trash`)).status, 403);
    const tr = await ctx.master('POST', `/api/tags/${T}/trash`);
    assert.equal(tr.status, 200);
    assert.ok(tr.json.tag.deleted_at);
    assert.ok(!(await tagsOf('?archived=1&hidden=1')).some((t) => t.id === T));
    assert.ok((await tagsOf('?trash=1')).some((t) => t.id === T && t.deleted_at));
    // 새 글의 #버릴것 은 글자
    const p = await post(ctx, th, '#버릴것\n이제는 글자', { recipients: [] });
    assert.deepEqual(p.message.tags, { primary: [], inline: [] });
    // 옛 글 칩에서는 빠지지만 연결은 남는다
    assert.deepEqual((await msg(old.message.seq)).tags.primary, []);
    assert.equal(links(T), 1);
    const v = await ctx.master('GET', `/api/tags/${T}/messages`);
    assert.equal(v.status, 404);
    assert.equal(v.json.error, 'tag_in_trash');
    const dup = await ctx.master('POST', '/api/tags', { name: '버릴것' });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error, 'tag_in_trash');
    assert.equal((await ctx.master('PATCH', `/api/tags/${T}`, { name: '다른것' })).status, 409);
    const ex = await ctx.master('POST', `/api/threads/${th}/messages`, { client_key: `k-${Date.now()}`, body: 'x', tags: [T], recipients: [] });
    assert.equal(ex.status, 400);
    assert.equal(ex.json.error, 'tag_in_trash');
    // 두 번 버려도 noop
    assert.equal((await ctx.master('POST', `/api/tags/${T}/trash`)).json.tag.deleted_at, tr.json.tag.deleted_at);
    // 되살리기
    assert.equal((await ctx.agent('alpha', 'POST', `/api/tags/${T}/restore`)).status, 403);
    const rs = await ctx.master('POST', `/api/tags/${T}/restore`);
    assert.equal(rs.json.tag.deleted_at, null);
    assert.deepEqual((await msg(old.message.seq)).tags.primary.map((t: any) => t.id), [T]);
    const again = await post(ctx, th, '#버릴것\n다시 태그', { recipients: [] });
    assert.deepEqual(again.message.tags.primary.map((t: any) => t.id), [T]);
  });

  test('영구 삭제: 휴지통 아닌 것 409 not_in_trash · 에이전트 403 · 연결·행을 지움 · 같은 이름 다시 만들기 · 감사', async () => {
    const n = links(T);
    assert.ok(n >= 2);
    const no = await ctx.master('DELETE', `/api/tags/${T}`);
    assert.equal(no.status, 409);
    assert.equal(no.json.error, 'not_in_trash');
    await ctx.master('POST', `/api/tags/${T}/trash`);
    assert.equal((await ctx.agent('alpha', 'DELETE', `/api/tags/${T}`)).status, 403);
    const d = await ctx.master('DELETE', `/api/tags/${T}`);
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.equal(d.json.name, '버릴것');
    assert.equal(d.json.links, n);
    assert.equal(links(T), 0);
    assert.ok(!(await tagsOf('?archived=1&hidden=1&trash=1')).some((t) => t.id === T));
    assert.equal((await ctx.master('DELETE', `/api/tags/${T}`)).status, 404);
    const re = await ctx.master('POST', '/api/tags', { name: '버릴것' });
    assert.equal(re.status, 201);
    assert.notEqual(re.json.tag.id, T);
    const audit = (await ctx.master('GET', '/api/audit?limit=300')).json;
    const rows: any[] = audit.rows ?? audit.entries ?? audit.audit ?? [];
    const acts = new Set(rows.map((r) => r.action));
    for (const a of ['tag.trash', 'tag.restore', 'tag.purge']) assert.ok(acts.has(a), a);
  });

  test('차선: 휴지통 태그는 차선이 되지 않는다(새 claim 은 기본 차선) · 영구 삭제는 그 차선의 쉬는 세션을 은퇴시킨다', async () => {
    const L = (await ctx.master('POST', '/api/tags', { name: '차선태그' })).json.tag.id;
    const claim = async () => (await ctx.agent('alpha', 'POST', '/api/adapter/claim', { worker: 'w' })).json.claim;
    // 1) 차선 L 에서 한 번 돌고 끝낸다 → L 차선 세션이 살아 있다
    await post(ctx, th, '#차선태그\n하나', { recipients: ['alpha'] });
    const c1 = await claim();
    assert.equal((ctx.app.db.prepare('SELECT lane FROM runs WHERE id = ?').get(c1.run.id) as { lane: string }).lane, L);
    await ctx.agent('alpha', 'POST', `/api/adapter/deliveries/${c1.delivery.id}/ack`, { lease_token: c1.delivery.lease_token });
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c1.run.id}/start`, { run_token: c1.run.run_token });
    assert.equal((await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c1.run.id}/complete`, { run_token: c1.run.run_token, body: '했음' })).status, 200);
    // 2) 태그가 붙은 채 기다리는 전달 → 휴지통에 넣으면 기본 차선으로 받힌다
    await post(ctx, th, '#차선태그\n둘', { recipients: ['alpha'] });
    await ctx.master('POST', `/api/tags/${L}/trash`);
    const c2 = await claim();
    assert.ok(c2, '받힘');
    assert.equal((ctx.app.db.prepare('SELECT lane FROM runs WHERE id = ?').get(c2.run.id) as { lane: string }).lane, '');
    await ctx.agent('alpha', 'POST', `/api/adapter/deliveries/${c2.delivery.id}/ack`, { lease_token: c2.delivery.lease_token });
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c2.run.id}/start`, { run_token: c2.run.run_token });
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c2.run.id}/complete`, { run_token: c2.run.run_token, body: '했음' });
    const active = () => ctx.app.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE lane = ? AND status = 'active'").get(L) as { n: number };
    assert.equal(active().n, 1);
    const d = await ctx.master('DELETE', `/api/tags/${L}`);
    assert.equal(d.json.sessions_retired, 1);
    assert.equal(active().n, 0);
  });
});

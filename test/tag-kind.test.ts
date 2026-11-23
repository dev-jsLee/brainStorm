// 태그 종류(주제·메타) · 스레드 고정 태그(2026-11-23 마스터 #1933·#1935·#1937 · 마이그레이션 22).
//   메타 태그는 주 태그 첫 자리·차선·답장 상속이 되지 않는다 · 답장은 주제 태그만 이어받고, 직접 준 주제 태그가 원문 것을 대신한다 ·
//   고정 태그가 있는 스레드의 모든 글은 주 태그 첫 자리가 고정 태그다.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { migrate, SCHEMA_VERSION } from '../src/db.js';
import { newThread, post, setup, type Ctx } from './helpers.js';

describe('마이그레이션 22 — tags.kind · threads.pinned_tag_id', () => {
  test('21 → 22: 이름이 열둘 중 하나면 meta · 나머지 topic · 고정은 NULL · kind CHECK', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-kind-'));
    const db = new Database(path.join(dir, 'x.db'));
    migrate(db, 21);
    db.prepare("INSERT INTO participants(id, kind, name, is_master, created_at) VALUES ('m','human','m',1,0)").run();
    const ins = db.prepare('INSERT INTO tags(id, name, created_by, created_at, updated_at) VALUES (?,?,?,0,0)');
    for (const [id, name] of [
      ['t1', '개선안'],
      ['t2', '버그'],
      ['t3', '요청'],
      ['t4', 'brainStorm'],
      ['t5', '개선안2'],
    ])
      ins.run(id, name, 'm');
    db.prepare("INSERT INTO threads(id, title, created_by, created_at, updated_at) VALUES ('th1','x','m',0,0)").run();
    migrate(db);
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    assert.ok(SCHEMA_VERSION >= 22);
    const kinds = Object.fromEntries((db.prepare('SELECT id, kind FROM tags').all() as any[]).map((r) => [r.id, r.kind]));
    assert.deepEqual(kinds, { t1: 'meta', t2: 'meta', t3: 'meta', t4: 'topic', t5: 'topic' });
    assert.equal((db.prepare("SELECT pinned_tag_id FROM threads WHERE id = 'th1'").get() as any).pinned_tag_id, null);
    assert.throws(() => db.prepare("UPDATE tags SET kind = 'other' WHERE id = 't4'").run());
    db.close();
  });
});

describe('태그 종류 · 고정 태그 (#1933·#1935·#1937)', () => {
  let ctx: Ctx;
  let th: string;
  let A: string; // 주제
  let B: string; // 주제
  let M: string; // 메타(만들고 바꿈)
  let Q: string; // 메타(이름으로)
  const kindOf = async (id: string) => (await ctx.master('GET', '/api/tags')).json.tags.find((t: any) => t.id === id)?.kind;
  const prim = (r: any) => r.message.tags.primary.map((t: any) => t.id);
  const laneOf = (seq: number) =>
    (
      ctx.app.db
        .prepare(
          "SELECT COALESCE((SELECT lmt.tag_id FROM message_tags lmt JOIN tags ltg ON ltg.id = lmt.tag_id WHERE lmt.message_seq = ? AND lmt.role = 'primary' AND ltg.deleted_at IS NULL AND ltg.kind = 'topic' ORDER BY lmt.rowid LIMIT 1), '') AS lane",
        )
        .get(seq) as { lane: string }
    ).lane;
  before(async () => {
    ctx = await setup();
    th = await newThread(ctx, '종류 방', 'alpha', ['alpha']);
    A = (await ctx.master('POST', '/api/tags', { name: '그리드' })).json.tag.id;
    B = (await ctx.master('POST', '/api/tags', { name: '전원' })).json.tag.id;
    M = (await ctx.master('POST', '/api/tags', { name: '개선안' })).json.tag.id;
    Q = (await ctx.master('POST', '/api/tags', { name: '질문' })).json.tag.id;
  });
  after(() => ctx.close());

  test('새 태그는 topic · 종류 바꾸기는 마스터만(에이전트 403) · 잘못된 값 400 · 감사 before/after', async () => {
    assert.equal(await kindOf(M), 'topic');
    assert.equal((await ctx.agent('alpha', 'PATCH', `/api/tags/${M}`, { kind: 'meta' })).status, 403);
    assert.equal((await ctx.master('PATCH', `/api/tags/${M}`, { kind: 'other' })).status, 400);
    const r = await ctx.master('PATCH', `/api/tags/${M}`, { kind: 'meta' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.tag.kind, 'meta');
    assert.equal((await ctx.master('PATCH', `/api/tags/${Q}`, { kind: 'meta' })).json.tag.kind, 'meta');
    const a = ctx.app.db.prepare("SELECT before_state AS before, after_state AS after FROM audit_log WHERE action = 'tag.update' AND target_id = ? AND result = 'ok' ORDER BY id DESC").get(M) as any;
    assert.equal(JSON.parse(a.before).kind, 'topic');
    assert.equal(JSON.parse(a.after).kind, 'meta');
  });

  test('주 태그 순서: 주제가 언제나 메타보다 앞 · 메타는 첫 자리·차선이 안 된다 · 메타만 있으면 차선 기본', async () => {
    const r = await post(ctx, th, '#개선안 #그리드 #질문 #전원\n본문', { recipients: [] });
    assert.deepEqual(prim(r), [A, B, M, Q]);
    assert.equal(r.message.tags.primary[2].kind, 'meta');
    assert.equal(laneOf(r.message.seq), A, '차선 = 첫 주제 태그');
    const onlyMeta = await post(ctx, th, '#개선안\n메타만', { recipients: [] });
    assert.deepEqual(prim(onlyMeta), [M]);
    assert.equal(laneOf(onlyMeta.message.seq), '', '주제 태그가 없으면 기본 차선');
    const view = await post(ctx, th, '#그리드\n보기 메타', { tags: [M], recipients: [] });
    assert.deepEqual(prim(view), [A, M], '보기로 준 메타도 주제 뒤');
  });

  test('메타 태그만 든 글은 claim 에서 기본 차선 — 같은 기본 차선 글과 차례', async () => {
    const th2 = await newThread(ctx, '차선 방', 'alpha', ['alpha']);
    const m1 = await post(ctx, th2, '#개선안\n하나', { recipients: ['alpha'] });
    await post(ctx, th2, '태그 없음', { recipients: ['alpha'] });
    const c1 = (await ctx.agent('alpha', 'POST', '/api/adapter/claim', { worker: 'w' })).json.claim;
    assert.equal(c1.trigger.seq, m1.message.seq);
    assert.equal((await ctx.agent('alpha', 'POST', '/api/adapter/claim', { worker: 'w' })).json.claim, null, '메타 글과 태그 없는 글은 같은 기본 차선');
  });

  test('답장 상속: 주제만 이어받고 메타는 안 이어받는다 · 직접 준 주제가 대신한다 · 직접 준 메타는 붙는다', async () => {
    const src = await post(ctx, th, '#그리드 #전원 #개선안\n원문', { recipients: [] });
    assert.deepEqual(prim(src), [A, B, M]);
    const bare = await post(ctx, th, '답', { reply_to_seq: src.message.seq, recipients: [] });
    assert.deepEqual(prim(bare), [A, B], '메타는 안 이어받는다');
    const swap = await post(ctx, th, '#전원\n답', { reply_to_seq: src.message.seq, recipients: [] });
    assert.deepEqual(prim(swap), [B], '첫 줄 주제 태그가 대신');
    const metaOnly = await post(ctx, th, '#질문\n답', { reply_to_seq: src.message.seq, recipients: [] });
    assert.deepEqual(prim(metaOnly), [A, B, Q], '메타만 주면 주제는 이어받고 메타는 제 것');
    const both = await post(ctx, th, '#질문 #그리드\n답', { reply_to_seq: src.message.seq, recipients: [] });
    assert.deepEqual(prim(both), [A, Q]);
  });

  test('에이전트 답: 태그 줄이 없으면 받은 글의 주제 태그만 상속', async () => {
    const th3 = await newThread(ctx, '에이전트 방', 'alpha', ['alpha']);
    const q = await post(ctx, th3, '#그리드 #개선안\n해줘', { recipients: ['alpha'] });
    const c = (await ctx.agent('alpha', 'POST', '/api/adapter/claim', { worker: 'w' })).json.claim;
    assert.equal(c.trigger.seq, q.message.seq);
    await ctx.agent('alpha', 'POST', `/api/adapter/deliveries/${c.delivery.id}/ack`, { lease_token: c.delivery.lease_token });
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token });
    const done = await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: '했음' });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    const msgs = (await ctx.master('GET', `/api/threads/${th3}/messages`)).json.messages;
    const ans = msgs.find((m: any) => m.author_id === 'alpha');
    assert.deepEqual(ans.tags.primary.map((t: any) => t.id), [A]);
  });

  test('고정 태그 설정: 마스터만 · 메타·보관·휴지통·없는 태그 400 · 메인 채팅방 409 · 풀기 · 감사', async () => {
    const pth = await newThread(ctx, '고정 방', 'alpha', ['alpha']);
    assert.equal((await ctx.agent('alpha', 'POST', `/api/threads/${pth}/pin-tag`, { tag_id: A })).status, 403);
    const meta = await ctx.master('POST', `/api/threads/${pth}/pin-tag`, { tag_id: M });
    assert.equal(meta.status, 400);
    assert.equal(meta.json.error, 'tag_meta');
    assert.equal((await ctx.master('POST', `/api/threads/${pth}/pin-tag`, { tag_id: 'tg_none' })).status, 400);
    const arch = (await ctx.master('POST', '/api/tags', { name: '보관용' })).json.tag.id;
    await ctx.master('PATCH', `/api/tags/${arch}`, { archived: true });
    assert.equal((await ctx.master('POST', `/api/threads/${pth}/pin-tag`, { tag_id: arch })).status, 400);
    const tr = (await ctx.master('POST', '/api/tags', { name: '버릴용' })).json.tag.id;
    await ctx.master('POST', `/api/tags/${tr}/trash`);
    assert.equal((await ctx.master('POST', `/api/threads/${pth}/pin-tag`, { tag_id: tr })).status, 400);
    const room = (await ctx.master('GET', '/api/threads')).json.threads.find((t: any) => t.kind === 'room');
    assert.equal((await ctx.master('POST', `/api/threads/${room.id}/pin-tag`, { tag_id: A })).status, 409);
    const ok = await ctx.master('POST', `/api/threads/${pth}/pin-tag`, { tag_id: A });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.thread.pinned_tag_id, A);
    assert.equal((await ctx.master('GET', `/api/threads/${pth}`)).json.thread.pinned_tag_id, A);
    // 고정된 태그는 메타로 못 바꾼다
    assert.equal((await ctx.master('PATCH', `/api/tags/${A}`, { kind: 'meta' })).status, 409);
    const off = await ctx.master('POST', `/api/threads/${pth}/pin-tag`, { tag_id: null });
    assert.equal(off.json.thread.pinned_tag_id, null);
    const acts = ctx.app.db.prepare("SELECT result FROM audit_log WHERE action = 'thread.pin_tag' AND target_id = ? ORDER BY id").all(pth) as any[];
    assert.ok(acts.some((a) => a.result === 'ok'));
  });

  test('고정 강제: 사람·보기·답장·에이전트 답 모두 첫 자리 = 고정 태그 · 다른 주제는 그 뒤 · 메타는 끝 · 차선 = 고정 태그 · 메인 채팅방은 그대로', async () => {
    const pth = await newThread(ctx, '고정 강제 방', 'alpha', ['alpha']);
    await ctx.master('POST', `/api/threads/${pth}/pin-tag`, { tag_id: A });
    const none = await post(ctx, pth, '태그 없음', { recipients: [] });
    assert.deepEqual(prim(none), [A]);
    const other = await post(ctx, pth, '#전원 #개선안\n다른 주제', { recipients: [] });
    assert.deepEqual(prim(other), [A, B, M], '«A 를 포함한 B 전개»');
    assert.equal(laneOf(other.message.seq), A);
    const inl = await post(ctx, pth, '본문에 #그리드 언급', { recipients: [] });
    assert.deepEqual(prim(inl), [A]);
    assert.deepEqual(inl.message.tags.inline, [], '고정 태그는 인라인에서 빠진다');
    const rep = await post(ctx, pth, '#전원\n답장', { reply_to_seq: other.message.seq, recipients: [] });
    assert.deepEqual(prim(rep), [A, B]);
    const viewB = await post(ctx, pth, '보기', { tags: [B], recipients: [] });
    assert.deepEqual(prim(viewB), [A, B]);
    // 에이전트 답 — 끝줄 태그 줄로 #전원 만 줘도 첫 자리는 고정
    const q = await post(ctx, pth, '해줘', { recipients: ['alpha'] });
    const c = (await ctx.agent('alpha', 'POST', '/api/adapter/claim', { worker: 'w' })).json.claim;
    assert.equal(c.trigger.seq, q.message.seq);
    await ctx.agent('alpha', 'POST', `/api/adapter/deliveries/${c.delivery.id}/ack`, { lease_token: c.delivery.lease_token });
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token });
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: '했음\n\n#전원' });
    const ans = (await ctx.master('GET', `/api/threads/${pth}/messages`)).json.messages.find((m: any) => m.author_id === 'alpha' && m.reply_to_seq === q.message.seq);
    assert.deepEqual(ans.tags.primary.map((t: any) => t.id), [A, B]);
    // 메인 채팅방은 고정 없음
    const room = (await ctx.master('GET', '/api/threads')).json.threads.find((t: any) => t.kind === 'room');
    const rm = await post(ctx, room.id, '#전원\n방 글', { recipients: [] });
    assert.deepEqual(prim(rm), [B]);
    // 고정 태그를 보관하면 강제가 멈춘다
    await ctx.master('PATCH', `/api/tags/${A}`, { archived: true });
    const after = await post(ctx, pth, '#전원\n보관 뒤', { recipients: [] });
    assert.deepEqual(prim(after), [B]);
    await ctx.master('PATCH', `/api/tags/${A}`, { archived: false });
  });

  test('새 스레드를 고정 태그와 함께 만든다(«#B 스레드로 이어 가기») · 메타는 400 · 영구 삭제는 고정을 푼다', async () => {
    const r = await ctx.master('POST', '/api/threads', { title: '#전원', pinned_tag_id: B, members: ['alpha'] });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.thread.pinned_tag_id, B);
    assert.equal((await ctx.master('POST', '/api/threads', { title: 'x', pinned_tag_id: M })).status, 400);
    const P = (await ctx.master('POST', '/api/tags', { name: '지울고정' })).json.tag.id;
    const t2 = (await ctx.master('POST', '/api/threads', { title: '#지울고정', pinned_tag_id: P })).json.thread.id;
    await ctx.master('POST', `/api/tags/${P}/trash`);
    assert.equal((await ctx.master('DELETE', `/api/tags/${P}`)).status, 200);
    assert.equal((await ctx.master('GET', `/api/threads/${t2}`)).json.thread.pinned_tag_id, null);
  });
});

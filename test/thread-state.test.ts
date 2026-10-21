// 스레드 정리(2026-10-11 마스터): 보관(읽기 전용) · 숨김(목록에서만) · 휴지통 → 영구 삭제 · 마이그레이션 6
//   묶음 적용(자식 스레드까지) · 메인 채팅방은 못 건드림 · 실행 중이면 거절 · 마스터만 · 감사 기록
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { migrate, SCHEMA_VERSION } from '../src/db.js';
import { key, newThread, post, setup, type Ctx } from './helpers.js';

describe('스레드 보관·숨김·휴지통·영구 삭제', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(async () => ctx.close());

  const list = async () => (await ctx.master('GET', '/api/threads')).json.threads as any[];
  const one = async (id: string) => (await list()).find((t) => t.id === id);
  const state = (id: string, action: string) => ctx.master('POST', `/api/threads/${id}/state`, { action });
  const A = (p: string, b: unknown = {}) => ctx.agent('alpha', 'POST', p, b);
  /** 부모 → 자식 → 손자 */
  async function family(title: string) {
    const p = await newThread(ctx, title, null, ['alpha']);
    const m = await post(ctx, p, '부모 글');
    const c = (await ctx.master('POST', `/api/threads/${p}/fork`, { from_seq: m.message.seq, title: `${title}-자식`, client_key: key() })).json.thread.id;
    const m2 = await post(ctx, c, '자식 글');
    const g = (await ctx.master('POST', `/api/threads/${c}/fork`, { from_seq: m2.message.seq, title: `${title}-손자`, client_key: key() })).json.thread.id;
    return { p, c, g };
  }

  test('새 칸: hidden=false · deleted_at=null', async () => {
    const th = await newThread(ctx, '기본', null);
    const t = await one(th);
    assert.equal(t.hidden, false);
    assert.equal(t.deleted_at, null);
    assert.equal(t.status, 'open');
  });

  test('보관은 자식까지 묶어 읽기 전용 — 글 409, 되돌리면 다시 쓸 수 있다', async () => {
    const f = await family('보관');
    const r = await state(f.p, 'archive');
    assert.equal(r.status, 200);
    assert.deepEqual([...r.json.affected].sort(), [f.p, f.c, f.g].sort());
    for (const id of [f.p, f.c, f.g]) assert.equal((await one(id)).status, 'archived');
    const w = await ctx.master('POST', `/api/threads/${f.c}/messages`, { client_key: key(), body: 'x' });
    assert.equal(w.status, 409);
    assert.equal(w.json.error, 'thread_closed');
    // 자식만 되돌리면 자식과 그 아래만
    const u = await state(f.c, 'unarchive');
    assert.deepEqual([...u.json.affected].sort(), [f.c, f.g].sort());
    assert.equal((await one(f.p)).status, 'archived');
    assert.equal((await one(f.c)).status, 'open');
    await post(ctx, f.c, '다시 씀');
    // 감사
    const a = ctx.app.db.prepare("SELECT * FROM audit_log WHERE action = 'thread.archive' AND target_id = ?").get(f.p) as any;
    assert.equal(a.result, 'ok');
    assert.equal(JSON.parse(a.after_state).affected, 3);
  });

  test('숨김은 목록 표시만 — 글·에이전트 읽기는 그대로', async () => {
    const th = await newThread(ctx, '숨김', null, ['alpha']);
    await post(ctx, th, '숨겨도 됨');
    assert.equal((await state(th, 'hide')).status, 200);
    assert.equal((await one(th)).hidden, true);
    await post(ctx, th, '숨긴 뒤에도 씀');
    assert.equal((await ctx.agent('alpha', 'GET', `/api/threads/${th}/messages`)).status, 200);
    assert.equal((await state(th, 'unhide')).status, 200);
    assert.equal((await one(th)).hidden, false);
  });

  test('휴지통: 에이전트에겐 사라지고(목록·읽기 404) 글 409, 복구하면 돌아온다', async () => {
    const f = await family('휴지통');
    assert.equal((await state(f.p, 'trash')).status, 200);
    for (const id of [f.p, f.c, f.g]) assert.ok((await one(id)).deleted_at > 0, '마스터 목록엔 deleted_at 과 함께 남는다');
    const al = (await ctx.agent('alpha', 'GET', '/api/threads')).json.threads.map((t: any) => t.id);
    assert.ok(!al.includes(f.p) && !al.includes(f.c));
    assert.equal((await ctx.agent('alpha', 'GET', `/api/threads/${f.p}/messages`)).status, 404);
    const w = await ctx.master('POST', `/api/threads/${f.p}/messages`, { client_key: key(), body: 'x' });
    assert.equal(w.status, 409);
    assert.equal(w.json.error, 'thread_deleted');
    const fk = await ctx.master('POST', `/api/threads/${f.p}/fork`, { from_seq: 1, title: 'x' });
    assert.equal(fk.status, 409);
    // 휴지통 안에서 보관·숨김은 안 된다
    assert.equal((await state(f.p, 'archive')).json.error, 'thread_deleted');
    assert.equal((await state(f.p, 'restore')).status, 200);
    for (const id of [f.p, f.c, f.g]) assert.equal((await one(id)).deleted_at, null);
    assert.ok((await ctx.agent('alpha', 'GET', '/api/threads')).json.threads.some((t: any) => t.id === f.p));
  });

  test('휴지통에 넣으면 대기 중인 전달은 거둔다', async () => {
    const th = await newThread(ctx, '전달 거둠', 'alpha', ['alpha']);
    await post(ctx, th, '불러 놓고 지움');
    assert.equal((await state(th, 'trash')).status, 200);
    const c = (await A('/api/adapter/claim', { worker: 'manual' })).json.claim;
    assert.equal(c, null, '지운 스레드의 전달은 안 나간다');
    const d = ctx.app.db.prepare('SELECT status FROM deliveries WHERE thread_id = ?').all(th) as any[];
    assert.ok(d.every((x) => x.status === 'cancelled'));
  });

  test('실행 중인 스레드는 보관·휴지통 409(runs_active) — 숨김은 된다', async () => {
    const th = await newThread(ctx, '실행 중', 'alpha', ['alpha']);
    await post(ctx, th, '일하는 중');
    const c = (await A('/api/adapter/claim', { worker: 'manual' })).json.claim;
    await A(`/api/adapter/deliveries/${c.delivery.id}/ack`, { lease_token: c.delivery.lease_token });
    await A(`/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token });
    for (const a of ['archive', 'trash']) {
      const r = await state(th, a);
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'runs_active');
    }
    assert.equal((await state(th, 'hide')).status, 200);
    await A(`/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: '끝' });
    assert.equal((await state(th, 'archive')).status, 200);
  });

  test('메인 채팅방은 409 room_locked · 마스터만 · 모르는 동작 400 · 없는 스레드 404', async () => {
    const room = (await list()).find((t) => t.kind === 'room');
    for (const a of ['archive', 'hide', 'trash']) assert.equal((await state(room.id, a)).json.error, 'room_locked');
    const th = await newThread(ctx, '권한', null, ['alpha']);
    const r = await ctx.agent('alpha', 'POST', `/api/threads/${th}/state`, { action: 'hide' });
    assert.equal(r.status, 403);
    assert.equal((await state(th, 'nuke')).status, 400);
    assert.equal((await state('th_nope', 'hide')).status, 404);
    assert.equal((await ctx.master('POST', `/api/threads/${th}/purge`, { confirm: '권한' })).json.error, 'not_in_trash');
  });

  test('이름 바꾸기: 마스터만 · 앞뒤 공백 정리 · 빈 이름 400 · 긴 이름 413 · 방·휴지통 409 · 감사 · 정렬 시각 그대로', async () => {
    const th = await newThread(ctx, '옛 이름', null, ['alpha']);
    const before = await one(th);
    const ren = (id: string, title: unknown) => ctx.master('POST', `/api/threads/${id}/rename`, { title });
    const r = await ren(th, '  새 이름  ');
    assert.equal(r.status, 200);
    assert.equal(r.json.thread.title, '새 이름');
    const t = await one(th);
    assert.equal(t.title, '새 이름');
    assert.equal(t.updated_at, before.updated_at); // 이름만 바꾼 것은 활동이 아니다
    assert.equal((await ren(th, '새 이름')).json.changed, false);
    assert.equal((await ren(th, '   ')).status, 400);
    assert.equal((await ren(th, 'x'.repeat(201))).status, 413);
    assert.equal((await ctx.agent('alpha', 'POST', `/api/threads/${th}/rename`, { title: '에이전트' })).status, 403);
    const room = (await list()).find((x) => x.kind === 'room');
    assert.equal((await ren(room.id, '방')).json.error, 'room_locked');
    assert.equal((await ren('th_nope', '없음')).status, 404);
    // 보관 중에도 바꿀 수 있다 · 휴지통은 안 된다
    await state(th, 'archive');
    assert.equal((await ren(th, '보관된 이름')).status, 200);
    await state(th, 'trash');
    assert.equal((await ren(th, '휴지통 이름')).json.error, 'thread_deleted');
    const a = ctx.app.db.prepare("SELECT * FROM audit_log WHERE action = 'thread.rename' AND target_id = ? AND result = 'ok' ORDER BY id").all(th) as any[];
    assert.equal(a.length, 2);
    assert.equal(JSON.parse(a[0].before_state).title, '옛 이름');
    assert.equal(JSON.parse(a[0].after_state).title, '새 이름');
  });

  test('영구 삭제: 휴지통 + 제목 확인 + 자식도 휴지통 — 행·첨부 파일이 사라지고 감사는 남는다', async () => {
    const f = await family('영구');
    const m = await post(ctx, f.g, '첨부 달 글');
    const up = await fetch(`${ctx.base}/api/threads/${f.g}/messages/${m.message.seq}/attachments?name=a.txt`, {
      method: 'POST',
      headers: { Cookie: ctx.cookie, Origin: ctx.base, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('hello'),
    });
    assert.equal(up.status, 201);
    const att = ctx.app.db.prepare('SELECT path FROM attachments WHERE message_seq = ?').get(m.message.seq) as any;
    assert.ok(fs.existsSync(path.join(ctx.dataDir, att.path)));

    await state(f.p, 'trash');
    await state(f.g, 'restore'); // 손자만 꺼냄
    let r = await ctx.master('POST', `/api/threads/${f.p}/purge`, { confirm: '영구' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'descendants_not_in_trash');
    await state(f.g, 'trash');
    r = await ctx.master('POST', `/api/threads/${f.p}/purge`, { confirm: '틀린 제목' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'confirm_mismatch');
    r = await ctx.master('POST', `/api/threads/${f.p}/purge`, { confirm: '영구' });
    assert.equal(r.status, 200);
    assert.deepEqual([...r.json.purged].sort(), [f.p, f.c, f.g].sort());

    const db = ctx.app.db;
    for (const id of [f.p, f.c, f.g]) {
      assert.equal((db.prepare('SELECT COUNT(*) n FROM threads WHERE id = ?').get(id) as any).n, 0);
      assert.equal((db.prepare('SELECT COUNT(*) n FROM messages WHERE thread_id = ?').get(id) as any).n, 0);
      assert.equal((db.prepare('SELECT COUNT(*) n FROM thread_members WHERE thread_id = ?').get(id) as any).n, 0);
    }
    assert.ok(!fs.existsSync(path.join(ctx.dataDir, att.path)), '첨부 파일도 지운다');
    assert.equal((await ctx.master('GET', `/api/threads/${f.p}`)).status, 404);
    const a = db.prepare("SELECT * FROM audit_log WHERE action = 'thread.purge' AND target_id = ?").get(f.p) as any;
    assert.equal(a.result, 'ok');
    assert.equal(JSON.parse(a.after_state).threads, 3);
    assert.equal(JSON.parse(a.before_state).title, '영구');
  });
});

test('마이그레이션 6: 옛 스레드는 hidden=0 · deleted_at=NULL 로 남는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mig6-'));
  const db = new Database(path.join(dir, 'x.db'));
  db.pragma('foreign_keys = ON');
  migrate(db, 5);
  db.prepare("INSERT INTO participants(id, kind, name, is_master, created_at) VALUES ('master','human','m',1,0)").run();
  db.prepare("INSERT INTO threads(id, title, created_by, created_at, updated_at) VALUES ('th_old','옛','master',0,0)").run();
  migrate(db);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.ok(SCHEMA_VERSION >= 6);
  const t = db.prepare('SELECT hidden, deleted_at, status FROM threads WHERE id = ?').get('th_old') as any;
  assert.deepEqual({ ...t }, { hidden: 0, deleted_at: null, status: 'open' });
  db.close();
});

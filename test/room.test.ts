// 기획 대조 1단계: 메인 채팅방 · 스레드 생성 중복 방지 · 에이전트 연결 상태 · 마이그레이션 3
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { hashPassphrase, sha256 } from '../src/crypto.js';
import { migrate, SCHEMA_VERSION } from '../src/db.js';
import { key, MASTER_PASS, newThread, post, setup, type Ctx } from './helpers.js';

async function rooms(ctx: Ctx) {
  const r = await ctx.master('GET', '/api/threads');
  return (r.json.threads as any[]).filter((t) => t.kind === 'room');
}

describe('메인 채팅방', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(async () => ctx.close());

  test('방은 하나뿐이고 모든 에이전트가 멤버다 — API·DB 둘 다 두 번째 방을 거절', async () => {
    const rs = await rooms(ctx);
    assert.equal(rs.length, 1);
    const room = rs[0];
    assert.equal(room.title, '메인 채팅방');
    assert.equal(room.parent_thread_id, null);
    // 목록 맨 앞
    assert.equal((await ctx.master('GET', '/api/threads')).json.threads[0].id, room.id);
    const d = await ctx.master('GET', `/api/threads/${room.id}`);
    assert.deepEqual(d.json.members.map((m: any) => m.participant_id).sort(), ['alpha', 'beta', 'master']);
    // 에이전트는 읽기·게시만, 호출 권한 없음(에이전트 간 자동 호출 끔)
    assert.ok(d.json.members.filter((m: any) => m.kind === 'agent').every((m: any) => m.can_read && m.can_post && !m.can_invoke));

    const r = await ctx.master('POST', '/api/threads', { title: '두 번째 방', kind: 'room' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'room_exists');
    // kind 를 안 주면 보통 스레드
    const th = await ctx.master('POST', '/api/threads', { title: '보통' });
    assert.equal(th.json.thread.kind, 'thread');
    // DB 제약도 막는다
    assert.throws(() =>
      ctx.app.db
        .prepare("INSERT INTO threads(id, kind, title, created_by, created_at, updated_at) VALUES ('th_x', 'room', 'x', 'master', 0, 0)")
        .run(),
    );
    // ensureRoom 을 여러 번 불러도 같은 방
    assert.equal(ctx.app.store.ensureRoom(), room.id);
    assert.equal(ctx.app.store.ensureRoom(), room.id);
    assert.equal((await rooms(ctx)).length, 1);
  });

  test('나중에 등록한 에이전트도 방 멤버가 된다 · 방에서 뺀 에이전트를 기동 때 다시 넣지 않는다', async () => {
    const room = (await rooms(ctx))[0];
    ctx.app.store.createParticipant('gamma', 'agent', 'GAMMA');
    let d = await ctx.master('GET', `/api/threads/${room.id}`);
    assert.ok(d.json.members.some((m: any) => m.participant_id === 'gamma'));
    await ctx.master('POST', `/api/threads/${room.id}/members`, { participant_id: 'gamma', remove: true });
    await ctx.restart();
    d = await ctx.master('GET', `/api/threads/${room.id}`);
    assert.ok(!d.json.members.some((m: any) => m.participant_id === 'gamma'));
    assert.equal((await rooms(ctx)).length, 1);
    assert.equal((await rooms(ctx))[0].id, room.id);
  });

  test('방의 글은 분기 스레드 목록에 안 나오고, 스레드의 글은 방 목록에 안 나온다 · 게시 결과에 확정 대상', async () => {
    const room = (await rooms(ctx))[0];
    const p1 = await post(ctx, room.id, '방 첫 글', { recipients: [] });
    assert.deepEqual(p1.target, { id: room.id, title: '메인 채팅방', kind: 'room' });
    const s1 = p1.message.seq;
    const s2 = (await post(ctx, room.id, '방 둘째 글', { recipients: [] })).message.seq;
    const f = await ctx.master('POST', `/api/threads/${room.id}/fork`, { from_seq: s1, title: '방에서 갈라짐', client_key: key() });
    assert.equal(f.status, 201);
    const fork = f.json.thread;
    assert.equal(fork.kind, 'thread');
    assert.equal(fork.parent_thread_id, room.id);
    // 분기 스레드는 부모 멤버(모든 에이전트)를 물려받는다
    const fd = await ctx.master('GET', `/api/threads/${fork.id}`);
    assert.ok(fd.json.members.some((m: any) => m.participant_id === 'alpha'));

    const own = await post(ctx, fork.id, '스레드 글', { recipients: [] });
    assert.equal(own.target.kind, 'thread');
    await post(ctx, room.id, '분기 뒤 방 글', { recipients: [] });

    const roomMsgs = (await ctx.master('GET', `/api/threads/${room.id}/messages`)).json.messages.map((m: any) => m.body);
    assert.ok(!roomMsgs.includes('스레드 글'));
    assert.ok(roomMsgs.includes('분기 뒤 방 글'));
    const forkMsgs = (await ctx.master('GET', `/api/threads/${fork.id}/messages`)).json.messages.map((m: any) => m.body);
    assert.deepEqual(forkMsgs, ['스레드 글']);
    const forkCtx = (await ctx.master('GET', `/api/threads/${fork.id}/context`)).json.messages.map((m: any) => m.seq);
    assert.deepEqual(forkCtx, [s1]);
    assert.ok(!forkCtx.includes(s2));
  });
});

describe('스레드 생성 중복 방지', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(async () => ctx.close());

  test('같은 client_key 로 분기 두 번 → 스레드 하나 · 다른 요청에 같은 키 → 409', async () => {
    const th = await newThread(ctx, '부모', null);
    const s1 = (await post(ctx, th, 'a')).message.seq;
    const s2 = (await post(ctx, th, 'b')).message.seq;
    const before = (await ctx.master('GET', '/api/threads')).json.threads.length;
    const k = key();
    const body = { from_seq: s2, title: '한 번만', include: [s1, s2], client_key: k };
    const a = await ctx.master('POST', `/api/threads/${th}/fork`, body);
    const b = await ctx.master('POST', `/api/threads/${th}/fork`, body);
    assert.equal(a.status, 201);
    assert.equal(a.json.duplicate, false);
    assert.equal(b.status, 200);
    assert.equal(b.json.duplicate, true);
    assert.equal(a.json.thread.id, b.json.thread.id);
    assert.equal((await ctx.master('GET', '/api/threads')).json.threads.length, before + 1);
    // 맥락도 한 벌만
    assert.deepEqual(
      (await ctx.master('GET', `/api/threads/${a.json.thread.id}/context`)).json.messages.map((m: any) => m.seq),
      [s1, s2],
    );
    // 같은 키로 다른 분기 시점 → 거절
    const c = await ctx.master('POST', `/api/threads/${th}/fork`, { ...body, from_seq: s1, include: [s1] });
    assert.equal(c.status, 409);
    assert.equal(c.json.error, 'client_key_reused');
    // 키 없이 보내면 예전처럼 매번 새로 만든다
    const d1 = await ctx.master('POST', `/api/threads/${th}/fork`, { from_seq: s1, title: '키 없음' });
    const d2 = await ctx.master('POST', `/api/threads/${th}/fork`, { from_seq: s1, title: '키 없음' });
    assert.notEqual(d1.json.thread.id, d2.json.thread.id);
  });

  test('새 스레드 만들기도 같은 client_key 면 하나', async () => {
    const k = key();
    const a = await ctx.master('POST', '/api/threads', { title: '루트', client_key: k });
    const b = await ctx.master('POST', '/api/threads', { title: '루트', client_key: k });
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(a.json.thread.id, b.json.thread.id);
    assert.equal((await ctx.master('POST', '/api/threads', { title: '다른 제목', client_key: k })).status, 409);
  });
});

describe('에이전트 연결 상태', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(async () => ctx.close());

  test('/api/agents: 상태 넷 · 토큰 값·해시를 내지 않는다 · 마스터만', async () => {
    const s = ctx.app.store;
    // alpha 는 한 번 붙는다
    assert.equal((await ctx.agent('alpha', 'GET', '/api/me')).status, 200);
    // beta 토큰은 폐기, gamma 는 토큰 없음, delta 는 발급만
    s.revokeToken(ctx.tokens.beta.id);
    s.createParticipant('gamma', 'agent', 'GAMMA');
    s.createParticipant('delta', 'agent', 'DELTA');
    const dTok = s.createToken('delta', { label: 'never' });

    const r = await ctx.master('GET', '/api/agents');
    assert.equal(r.status, 200);
    const by = Object.fromEntries((r.json.agents as any[]).map((a) => [a.id, a]));
    assert.equal(by.alpha.state, 'seen');
    assert.ok(by.alpha.last_seen_at > 0);
    assert.equal(by.beta.state, 'revoked');
    assert.equal(by.gamma.state, 'no_credential');
    assert.equal(by.delta.state, 'never');
    assert.equal(by.delta.last_seen_at, null);
    assert.deepEqual(by.alpha.credentials, { active: 1, revoked_or_expired: 0 });

    const raw = JSON.stringify(r.json);
    for (const t of [ctx.tokens.alpha.token, ctx.tokens.beta.token, dTok.token]) {
      assert.ok(!raw.includes(t), 'token value leaked');
      assert.ok(!raw.includes(sha256(t)), 'token hash leaked');
    }
    assert.ok(!/token_hash|"token"/.test(raw));
    // 에이전트는 못 본다
    assert.equal((await ctx.agent('alpha', 'GET', '/api/agents')).status, 403);
  });
});

describe('마이그레이션 3 (옛 스키마 DB → 새 버전 기동)', () => {
  test('스키마 2 DB 가 그대로 올라가고, 기존 스레드는 부모 없는 스레드로 남고, 방은 하나만 생긴다', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mig-'));
    // 스키마 2 까지만 만든 옛 DB — 운영(host-b)에 있는 꼴
    const db = new Database(path.join(dataDir, 'brainstorm.db'));
    db.pragma('foreign_keys = ON');
    migrate(db, 2);
    assert.equal(db.pragma('user_version', { simple: true }), 2);
    const t0 = Date.now() - 86_400_000;
    db.prepare("INSERT INTO participants(id, kind, name, is_master, passphrase_hash, created_at) VALUES ('master','human','마스터',1,?,?)").run(
      hashPassphrase(MASTER_PASS),
      t0,
    );
    db.prepare("INSERT INTO participants(id, kind, name, created_at) VALUES ('strata','agent','Strata',?)").run(t0);
    db.prepare(
      "INSERT INTO threads(id, title, default_recipient, created_by, created_at, updated_at) VALUES ('th_old','Strata 연결 시험','strata','master',?,?)",
    ).run(t0, t0);
    for (const p of ['master', 'strata'])
      db.prepare('INSERT INTO thread_members(thread_id, participant_id, can_read, can_post, can_invoke, added_at) VALUES (?,?,1,1,?,?)').run(
        'th_old',
        p,
        p === 'master' ? 1 : 0,
        t0,
      );
    db.prepare(
      "INSERT INTO messages(id, thread_id, author_id, client_key, body, source_kind, recipients, created_at) VALUES ('msg_old','th_old','master','k-old','옛 글','instruction','[\"strata\"]',?)",
    ).run(t0);
    db.prepare(
      "INSERT INTO agent_sessions(id, thread_id, agent_id, generation, status, reason, created_at, base_seq) VALUES ('ses_old','th_old','strata',1,'active','first',?,NULL)",
    ).run(t0);
    db.close();

    const ctx = await setup({}, dataDir);
    try {
      const h = await (await fetch(`${ctx.base}/healthz`)).json();
      assert.equal(h.schema, SCHEMA_VERSION);
      assert.ok(SCHEMA_VERSION >= 3); // 이 시험은 2 → 최신(마이그레이션 3 포함). 3 → 4 는 test/cancel.test.ts
      const list = (await ctx.master('GET', '/api/threads')).json.threads as any[];
      const old = list.find((t) => t.id === 'th_old');
      assert.equal(old.kind, 'thread');
      assert.equal(old.parent_thread_id, null);
      assert.equal(old.title, 'Strata 연결 시험');
      assert.equal(old.default_recipient, 'strata');
      const msgs = (await ctx.master('GET', '/api/threads/th_old/messages')).json.messages;
      assert.deepEqual(
        msgs.map((m: any) => m.body),
        ['옛 글'],
      );
      const od = (await ctx.master('GET', '/api/threads/th_old')).json;
      assert.equal(od.sessions.length, 1);
      assert.equal(od.sessions[0].generation, 1);
      // 옛 행의 client_key 는 비어 있다
      assert.equal((ctx.app.db.prepare("SELECT client_key FROM threads WHERE id = 'th_old'").get() as any).client_key, null);

      const rs = list.filter((t) => t.kind === 'room');
      assert.equal(rs.length, 1);
      const roomId = rs[0].id;
      const rd = (await ctx.master('GET', `/api/threads/${roomId}`)).json;
      assert.deepEqual(rd.members.map((m: any) => m.participant_id).sort(), ['master', 'strata']);
      assert.equal((await ctx.master('GET', `/api/threads/${roomId}/messages`)).json.messages.length, 0);

      // 다시 기동해도 방은 하나, 같은 방
      await ctx.restart();
      const again = ((await ctx.master('GET', '/api/threads')).json.threads as any[]).filter((t) => t.kind === 'room');
      assert.equal(again.length, 1);
      assert.equal(again[0].id, roomId);
    } finally {
      await ctx.close();
    }
  });

  test('마스터가 없는 새 DB 는 방을 만들지 않다가 init(마스터 등록) 때 만든다', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mig-'));
    const db = new Database(path.join(dataDir, 'brainstorm.db'));
    migrate(db);
    db.close();
    const { Store } = await import('../src/store.js');
    const { loadConfig } = await import('../src/config.js');
    const db2 = new Database(path.join(dataDir, 'brainstorm.db'));
    const st = new Store(db2, loadConfig({ dataDir, logLevel: 'silent' }));
    assert.equal(st.ensureRoom(), null);
    assert.equal((db2.prepare("SELECT COUNT(*) AS n FROM threads WHERE kind = 'room'").get() as any).n, 0);
    st.createParticipant('master', 'human', '마스터', true);
    const n = (db2.prepare("SELECT COUNT(*) AS n FROM threads WHERE kind = 'room'").get() as any).n;
    assert.equal(n, 1);
    db2.close();
  });
});

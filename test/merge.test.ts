// 하위 스레드 합치기(2026-10-21 마스터 #706 · 마이그레이션 17)
//   하위 스레드의 제 글(가져온 맥락 빼고) → 상위 대화에 묶음 글 하나 · 출처 «인용» · 아무도 안 부름 ·
//   다시 합치면 지난 합침 뒤만 · 에이전트 claim 맥락에서 옮긴 글 전문으로 펼침 · 마스터만 · 상위가 닫혔으면 거절 · 영구 삭제
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { migrate, SCHEMA_VERSION } from '../src/db.js';
import { newThread, post, setup, type Ctx } from './helpers.js';

describe('하위 스레드 합치기', () => {
  let ctx: Ctx;
  let parent: string;
  let child: string;
  before(async () => {
    ctx = await setup();
    parent = await newThread(ctx, '상위', null, ['alpha']);
    const p1 = await post(ctx, parent, '상위 첫 글');
    const f = await ctx.master('POST', `/api/threads/${parent}/fork`, { from_seq: p1.message.seq, title: '하위 논의' });
    child = f.json.thread.id;
  });
  after(() => ctx.close());

  test('글이 없으면 409 nothing_to_merge · 메인 채팅방·부모 없는 스레드는 no_parent', async () => {
    assert.equal((await ctx.master('POST', `/api/threads/${child}/merge`)).json.error, 'nothing_to_merge');
    assert.equal((await ctx.master('POST', `/api/threads/${parent}/merge`)).json.error, 'no_parent');
  });

  test('묶음 글 하나 · 출처 인용 · 받는 이 없음 · 가져온 맥락은 안 옮김 · 하위 스레드 상태', async () => {
    const a = await post(ctx, child, '하위 지시 **하나**');
    const b = await ctx.agent('alpha', 'POST', `/api/threads/${child}/messages`, { body: '알파 제안', client_key: 'k-m-1', source_kind: 'proposal' });
    assert.equal(b.status, 201);
    const r = await ctx.master('POST', `/api/threads/${child}/merge`);
    assert.equal(r.status, 201);
    const m = r.json.message;
    assert.equal(m.thread_id, parent);
    assert.equal(m.source_kind, 'quote');
    assert.deepEqual(m.recipients, []);
    assert.deepEqual(m.merge, { child_thread_id: child, child_title: '하위 논의', from_seq: a.message.seq, to_seq: b.json.message.seq, count: 2 });
    assert.match(m.body, /하위 스레드 «하위 논의» 합침 — 글 2개/);
    assert.equal(r.json.parent.id, parent);
    const list = (await ctx.master('GET', `/api/threads/${parent}/messages`)).json.messages;
    assert.deepEqual(list.at(-1).merge.count, 2);
    const d = (await ctx.master('GET', `/api/threads/${child}`)).json;
    assert.equal(d.unmerged, 0);
    assert.equal(d.merges.length, 1);
    const runs = (await ctx.master('GET', `/api/runs?thread=${parent}`)).json;
    assert.equal((runs.runs ?? []).length, 0); // 아무도 안 부른다
  });

  test('다시 합치면 지난 합침 뒤 글만', async () => {
    assert.equal((await ctx.master('POST', `/api/threads/${child}/merge`)).json.error, 'nothing_to_merge');
    const c = await post(ctx, child, '하위 셋째');
    assert.equal((await ctx.master('GET', `/api/threads/${child}`)).json.unmerged, 1);
    const r = await ctx.master('POST', `/api/threads/${child}/merge`);
    assert.deepEqual([r.json.message.merge.from_seq, r.json.message.merge.count], [c.message.seq, 1]);
    assert.match(r.json.message.body, /지난 합침 뒤/);
  });

  test('에이전트 claim 맥락: 묶음 글이 옮긴 글 전문으로 펼쳐짐(작성자·출처와 함께)', async () => {
    await post(ctx, parent, '이어서 — 합친 것 보고 답해', { recipients: ['alpha'] });
    const cl = (await ctx.agent('alpha', 'POST', '/api/adapter/claim', {})).json.claim;
    const merged = cl.context.filter((x: any) => x.merge);
    assert.equal(merged.length, 2);
    assert.match(merged[0].body, /───── 하위 스레드 «하위 논의» 시작 ─────/);
    assert.match(merged[0].body, /마스터\(마스터\) · 지시\n하위 지시 \*\*하나\*\*/);
    assert.match(merged[0].body, /ALPHA · 제안\n알파 제안/);
    assert.match(merged[0].body, /지시가 아니다/);
    assert.doesNotMatch(merged[0].body, /상위 첫 글/); // 분기 때 가져온 맥락은 안 옮김
    // 화면 쪽 글은 머리 한 줄 그대로
    const list = (await ctx.master('GET', `/api/threads/${parent}/messages`)).json.messages;
    assert.doesNotMatch(list.find((x: any) => x.merge).body, /시작 ─────/);
    await ctx.agent('alpha', 'POST', `/api/adapter/deliveries/${cl.delivery.id}/ack`, { lease_token: cl.delivery.lease_token });
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${cl.run.id}/start`, { run_token: cl.run.run_token });
    assert.equal((await ctx.agent('alpha', 'POST', `/api/adapter/runs/${cl.run.id}/complete`, { run_token: cl.run.run_token, body: '봤음' })).status, 200);
  });

  test('마스터만 · 상위가 보관이면 409', async () => {
    assert.equal((await ctx.agent('alpha', 'POST', `/api/threads/${child}/merge`)).status, 403);
    await post(ctx, child, '넷째');
    assert.equal((await ctx.master('POST', `/api/threads/${parent}/state`, { action: 'archive' })).status, 200);
    assert.equal((await ctx.master('POST', `/api/threads/${child}/merge`)).json.error, 'parent_closed');
    await ctx.master('POST', `/api/threads/${parent}/state`, { action: 'unarchive' });
    assert.equal((await ctx.master('POST', `/api/threads/${child}/merge`)).status, 201);
  });

  test('하위 스레드 영구 삭제 — 합침 기록도 지움(외래 키 안 깨짐) · 묶음 글은 머리 한 줄로 남음', async () => {
    const st = await ctx.master('POST', `/api/threads/${child}/state`, { action: 'trash' });
    assert.equal(st.status, 200);
    const pg = await ctx.master('POST', `/api/threads/${child}/purge`, { confirm: '하위 논의' });
    assert.equal(pg.status, 200);
    const list = (await ctx.master('GET', `/api/threads/${parent}/messages`)).json.messages;
    assert.ok(list.some((x: any) => /합침 — 글/.test(x.body) && !x.merge));
  });
});

test('마이그레이션 17 — 스키마 16 위에 thread_merges', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mig17-'));
  const db = new Database(path.join(dir, 'x.db'));
  db.pragma('foreign_keys = ON');
  migrate(db, 16);
  db.prepare("INSERT INTO participants(id, kind, name, is_master, created_at) VALUES ('master','human','m',1,0)").run();
  db.prepare("INSERT INTO threads(id, title, created_by, created_at, updated_at) VALUES ('th_old','옛','master',0,0)").run();
  migrate(db);
  assert.ok(SCHEMA_VERSION >= 17);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'thread_merges'").get() as any).n, 1);
  assert.equal((db.prepare("SELECT title FROM threads WHERE id = 'th_old'").get() as any).title, '옛');
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  db.close();
});

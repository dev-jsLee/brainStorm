// 태그별 차선(2026-11-05 마스터 #1561·#1563 · 마이그레이션 20) — 같은 방에서 주 태그가 다르면 같은 에이전트라도 동시에 돈다.
//   차선 = 원인 글의 첫 주 태그(없으면 기본 차선) · 같은 차선은 지금처럼 차례 · 차선마다 세션(세대 번호는 방 × 에이전트에서 유일)
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { migrate } from '../src/db.js';
import { newThread, post, setup, type Ctx } from './helpers.js';

describe('태그별 차선 (마스터 #1563)', () => {
  let ctx: Ctx;
  let th: string;
  before(async () => {
    ctx = await setup();
    th = await newThread(ctx, '차선 방', 'alpha', ['alpha']);
    await ctx.master('POST', '/api/tags', { name: '그리드DB' });
    await ctx.master('POST', '/api/tags', { name: 'BrainStorm' });
  });
  after(() => ctx.close());
  const claim = async () => (await ctx.agent('alpha', 'POST', '/api/adapter/claim', { worker: 'w' })).json.claim;

  test('다른 태그 글은 앞 실행이 도는 동안에도 받힌다 · 같은 태그는 기다린다 · 태그 없는 글은 기본 차선', async () => {
    const g1 = await post(ctx, th, '#그리드DB\n칸 순서', { recipients: ['alpha'] });
    const g2 = await post(ctx, th, '#그리드DB\n하나 더', { recipients: ['alpha'] });
    const b1 = await post(ctx, th, '#BrainStorm\n차선', { recipients: ['alpha'] });
    const n1 = await post(ctx, th, '태그 없음', { recipients: ['alpha'] });
    const c1 = await claim();
    assert.equal(c1.trigger.seq, g1.message.seq);
    const c2 = await claim();
    assert.equal(c2.trigger.seq, b1.message.seq, '그리드DB 가 도는 동안 BrainStorm 은 바로');
    const c3 = await claim();
    assert.equal(c3.trigger.seq, n1.message.seq, '태그 없는 글은 기본 차선');
    assert.equal(await claim(), null, '같은 차선(그리드DB 둘째)은 기다린다');
    // 세션은 차선마다 따로 · 세대 번호는 겹치지 않는다(어댑터 세션 키가 세대로 갈린다)
    const gens = [c1, c2, c3].map((c: any) => c.session.generation);
    assert.equal(new Set([c1, c2, c3].map((c: any) => c.session.id)).size, 3);
    assert.equal(new Set(gens).size, 3);
    // 그리드DB 첫 실행이 끝나면 둘째가 같은 세션으로
    await ctx.agent('alpha', 'POST', `/api/adapter/deliveries/${c1.delivery.id}/ack`, { lease_token: c1.delivery.lease_token });
    const s = await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c1.run.id}/start`, { run_token: c1.run.run_token });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    const done = await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c1.run.id}/complete`, { run_token: c1.run.run_token, body: '했음' });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    const c4 = await claim();
    assert.equal(c4?.trigger.seq, g2.message.seq);
    assert.equal(c4.session.id, c1.session.id, '같은 차선 = 같은 세션');
  });

  test('세션 교체(마스터): lane 을 안 주면 살아 있는 차선을 모두 새 세대로', async () => {
    const before = (await ctx.master('GET', `/api/threads/${th}`)).json.sessions.filter((x: any) => x.status === 'active').length;
    assert.ok(before >= 3);
    const r = await ctx.master('POST', `/api/threads/${th}/sessions/rotate`, { agent_id: 'alpha', reason: '시험' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ses = (await ctx.master('GET', `/api/threads/${th}`)).json.sessions;
    assert.equal(ses.filter((x: any) => x.status === 'active').length, before);
    assert.equal(new Set(ses.map((x: any) => x.generation)).size, ses.length, '세대 번호 유일');
  });
});

test('마이그레이션 19 → 20: 옛 세션·실행은 기본 차선(\'\') · 활성 하나 규칙은 차선마다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-lanes-'));
  const db = new Database(path.join(dir, 'x.db'));
  migrate(db, 19);
  db.prepare("INSERT INTO participants(id, kind, name, is_master, created_at) VALUES ('m','human','마스터',1,0), ('a','agent','a',0,0)").run();
  db.prepare("INSERT INTO threads(id, title, created_by, created_at, updated_at) VALUES ('t','t','m',0,0)").run();
  db.prepare("INSERT INTO agent_sessions(id, thread_id, agent_id, generation, status, created_at) VALUES ('s1','t','a',1,'active',0)").run();
  migrate(db);
  assert.equal((db.prepare("SELECT lane FROM agent_sessions WHERE id='s1'").get() as any).lane, '');
  const ins = db.prepare("INSERT INTO agent_sessions(id, thread_id, agent_id, generation, status, lane, created_at) VALUES (?,'t','a',?,'active',?,0)");
  ins.run('s2', 2, 'tg_x');
  assert.throws(() => ins.run('s3', 3, ''), /UNIQUE/, '같은 차선에 활성 둘은 안 됨');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

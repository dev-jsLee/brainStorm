// 위임 대장(마이그레이션 12 · 대기 13): 선점 겹침 판정 · 전부 아니면 전무 · 막힘 · 놓기 · 권한 · 대기·진입 · 마이그레이션
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { migrate, SCHEMA_VERSION } from '../src/db.js';
import { claimsOverlap, normalizeClaim } from '../src/store.js';
import { newThread, openWs, setup, waitFor, type Ctx } from './helpers.js';

const P = (repo: string, scope: string) => ({ kind: 'path', repo, scope });
const R = (repo: string, scope: string) => ({ kind: 'resource', repo, scope });

describe('위임 대장', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(async () => ctx.close());

  let n = 0;
  const create = (claims: unknown[], extra: Record<string, unknown> = {}, who: 'master' | 'alpha' | 'beta' = 'master') => {
    const body = { assignee: `baeksu-${++n}`, title: `일 ${n}`, spec: '## 명세\n- 할 것', version_slot: 'b', claims, ...extra };
    return who === 'master' ? ctx.master('POST', '/api/delegations', body) : ctx.agent(who, 'POST', '/api/delegations', body);
  };
  const done = async (id: string) => {
    const r = await ctx.master('POST', `/api/delegations/${id}/status`, { status: 'done', result: '끝' });
    assert.equal(r.status, 200);
    return r.json;
  };

  test('만들기 — queued · 선점 initial · 감사 ok', async () => {
    const th = await newThread(ctx, '위임 원천', 'alpha', ['alpha']);
    const r = await create([P('brainstorm', './src//store'), R('deploy', 'host-b')], { thread_id: th, source_seq: 3 });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const d = r.json.delegation;
    assert.equal(d.status, 'queued');
    assert.equal(d.created_by, 'master');
    assert.equal(d.thread_id, th);
    assert.equal(d.source_seq, 3);
    assert.equal(d.version_slot, 'b');
    assert.deepEqual(
      d.claims.map((c: any) => [c.kind, c.repo, c.scope, c.origin, c.released_at]),
      [
        ['path', 'brainstorm', 'src/store', 'initial', null],
        ['resource', 'deploy', 'host-b', 'initial', null],
      ],
    );
    const a = ctx.app.db.prepare("SELECT result FROM audit_log WHERE action = 'delegation.create' AND target_id = ?").get(d.id) as any;
    assert.equal(a.result, 'ok');
    await done(d.id);
  });

  test('폴더 선점 ↔ 파일 접두 선점은 겹친다(양방향)', async () => {
    const a = await create([P('brainstorm', 'src/')]);
    assert.equal(a.status, 201);
    const b = await create([P('brainstorm', 'src/store')]);
    assert.equal(b.status, 409);
    assert.equal(b.json.error, 'claim_conflict');
    assert.deepEqual(b.json.conflicts, [
      { delegation_id: a.json.delegation.id, assignee: a.json.delegation.assignee, title: a.json.delegation.title, kind: 'path', repo: 'brainstorm', scope: 'src/', wanted: 'src/store' },
    ]);
    await done(a.json.delegation.id);
    const c = await create([P('brainstorm', 'src/store')]);
    assert.equal(c.status, 201);
    const d = await create([P('brainstorm', '/src')]); // 'src' 는 'src/store' 의 접두
    assert.equal(d.status, 409);
    await done(c.json.delegation.id);
  });

  test("'*' 는 그 저장소 전체와 겹친다 — 다른 저장소와는 안 겹친다", async () => {
    const a = await create([P('vault', 'Notes/')]);
    assert.equal(a.status, 201);
    assert.equal((await create([P('vault', '*')])).status, 409);
    const other = await create([P('brainstorm', '*')]);
    assert.equal(other.status, 201, '다른 저장소');
    assert.equal((await create([P('brainstorm', 'README.md')])).status, 409);
    await done(a.json.delegation.id);
    await done(other.json.delegation.id);
  });

  test('resource 는 (repo, scope) 정확히 같을 때만 겹친다', async () => {
    const a = await create([R('deploy', 'host-b')]);
    assert.equal(a.status, 201);
    const same = await create([R('deploy', 'host-b')]);
    assert.equal(same.status, 409);
    assert.equal(same.json.conflicts[0].kind, 'resource');
    const b = await create([R('deploy', 'host-c'), R('schema', 'brainstorm'), R('tag', 'brainstorm')]);
    assert.equal(b.status, 201);
    // path 와 resource 는 서로 안 겹친다
    const c = await create([P('deploy', 'host-b')]);
    assert.equal(c.status, 201);
    for (const x of [a, b, c]) await done(x.json.delegation.id);
  });

  test('선점 추가 — 겹치면 blocked · 전부 아니면 전무 · 쥔 선점은 그대로', async () => {
    const holder = await create([P('brainstorm', 'public/')]);
    const w = await create([P('brainstorm', 'src/db.ts')], {}, 'alpha');
    assert.equal(w.status, 201);
    const id = w.json.delegation.id;
    assert.equal(w.json.delegation.created_by, 'alpha');
    assert.equal((await ctx.agent('alpha', 'POST', `/api/delegations/${id}/status`, { status: 'running' })).status, 200);
    // 한 줄은 비어 있고 한 줄은 잡혀 있다 → 아무것도 안 들어간다
    const r = await ctx.agent('beta', 'POST', `/api/delegations/${id}/claims`, { claims: [P('brainstorm', 'test/'), P('brainstorm', 'public/app.js')] });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'claim_conflict');
    assert.equal(r.json.conflicts.length, 1);
    assert.equal(r.json.conflicts[0].delegation_id, holder.json.delegation.id);
    const g = (await ctx.agent('beta', 'GET', `/api/delegations/${id}`)).json.delegation;
    assert.equal(g.status, 'blocked');
    assert.deepEqual(
      g.claims.map((c: any) => c.scope),
      ['src/db.ts'],
    );
    const denied = ctx.app.db.prepare("SELECT result, reason FROM audit_log WHERE action = 'delegation.claim' AND target_id = ?").get(id) as any;
    assert.deepEqual({ ...denied }, { result: 'denied', reason: 'claim_conflict' });
    // test/ 는 아직 비어 있다(거절된 요청이 아무것도 안 넣었다)
    const probe = await create([P('brainstorm', 'test/')]);
    assert.equal(probe.status, 201);
    await done(probe.json.delegation.id);
    // 비어 있는 것만 청하면 된다 · 자기 선점과 겹치는 것은 충돌이 아니다
    const ok = await ctx.agent('alpha', 'POST', `/api/delegations/${id}/claims`, { claims: [P('brainstorm', 'test/'), P('brainstorm', 'src/db')] });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual(
      ok.json.delegation.claims.map((c: any) => [c.scope, c.origin]),
      [
        ['src/db.ts', 'initial'],
        ['test/', 'added'],
        ['src/db', 'added'],
      ],
    );
    await done(holder.json.delegation.id);
    await done(id);
  });

  test('done 은 선점을 놓고 그 범위가 남에게 열린다 · 끝난 위임은 다시 못 연다', async () => {
    const a = await create([P('ct111', 'etc/brainstorm/')]);
    const id = a.json.delegation.id;
    assert.equal((await create([P('ct111', 'etc/')])).status, 409);
    const fin = await done(id);
    assert.equal(fin.changed, true);
    assert.equal(fin.delegation.status, 'done');
    assert.equal(fin.delegation.result, '끝');
    assert.ok(fin.delegation.finished_at);
    assert.ok(fin.delegation.claims.every((c: any) => c.released_at));
    const b = await create([P('ct111', 'etc/')]);
    assert.equal(b.status, 201, '놓인 범위는 겹치지 않는다');
    assert.equal((await ctx.master('POST', `/api/delegations/${id}/status`, { status: 'running' })).status, 409);
    assert.equal((await ctx.master('POST', `/api/delegations/${id}/claims`, { claims: [P('x', 'y')] })).status, 409);
    assert.equal((await ctx.master('POST', `/api/delegations/${id}/heartbeat`)).status, 409);
    // queued/running/blocked 는 선점을 쥔다
    const bid = b.json.delegation.id;
    for (const s of ['running', 'blocked', 'queued']) {
      const r = await ctx.master('POST', `/api/delegations/${bid}/status`, { status: s });
      assert.equal(r.status, 200);
      assert.ok(r.json.delegation.claims.every((c: any) => c.released_at === null));
    }
    assert.equal((await ctx.master('POST', `/api/delegations/${bid}/status`, { status: 'nope' })).status, 400);
    assert.equal((await ctx.master('POST', `/api/delegations/${bid}/status`, { status: 'cancelled' })).status, 200);
    assert.equal((await create([P('ct111', 'etc/brainstorm/x')])).status, 201);
  });

  test('heartbeat · 강제 놓기(마스터·만든 이만) · 목록 active', async () => {
    const a = await create([R('deploy', 'host-d')], {}, 'alpha');
    const id = a.json.delegation.id;
    const hb = await ctx.agent('beta', 'POST', `/api/delegations/${id}/heartbeat`);
    assert.equal(hb.status, 200);
    assert.ok(hb.json.last_seen_at);
    const act = (await ctx.agent('beta', 'GET', '/api/delegations?active=1')).json.delegations as any[];
    const mine = act.find((d) => d.id === id);
    assert.ok(mine);
    assert.equal(mine.claims.length, 1);
    assert.ok(act.every((d) => d.status !== 'done' && d.status !== 'cancelled'));
    const all = (await ctx.master('GET', '/api/delegations')).json.delegations as any[];
    assert.ok(all.some((d) => d.status === 'done'));
    // 만든 이 아닌 에이전트는 못 놓는다
    const no = await ctx.agent('beta', 'POST', `/api/delegations/${id}/release`);
    assert.equal(no.status, 403);
    const yes = await ctx.agent('alpha', 'POST', `/api/delegations/${id}/release`);
    assert.equal(yes.status, 200);
    assert.equal(yes.json.outcome, 'released');
    assert.equal(yes.json.released, 1);
    assert.equal(yes.json.delegation.status, 'cancelled');
    const again = await ctx.master('POST', `/api/delegations/${id}/release`);
    assert.equal(again.json.outcome, 'already_closed');
    const forced = ctx.app.db.prepare("SELECT result, reason FROM audit_log WHERE action = 'delegation.release' AND target_id = ? ORDER BY id").all(id) as any[];
    assert.deepEqual(
      forced.map((x) => [x.result, x.reason]),
      [
        ['denied', 'not_owner'],
        ['ok', 'forced'],
        ['noop', 'already_closed'],
      ],
    );
    assert.equal((await create([R('deploy', 'host-d')])).status, 201);
    const m = await create([R('deploy', 'host-e')], {}, 'beta');
    assert.equal((await ctx.master('POST', `/api/delegations/${m.json.delegation.id}/release`)).status, 200, '마스터는 남의 것도 놓는다');
  });

  test("범위 다듬기 — '..'·빈 값·'/' 는 400 · 사칭 403 · 인증 없음 401", async () => {
    for (const bad of [P('brainstorm', '../etc'), P('brainstorm', 'src/../x'), P('brainstorm', ''), P('brainstorm', '/'), P('brainstorm', './'), R('deploy', ' '), P('', 'src/')]) {
      const r = await create([bad]);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal((await create([])).json.error, 'claims_required');
    assert.equal((await create([{ kind: 'lock', repo: 'x', scope: 'y' }])).status, 400);
    assert.equal((await create([R('a', 'b')], { version_slot: 'd' })).status, 400);
    const imp = await create([R('a', 'b')], { created_by: 'master' }, 'alpha');
    assert.equal(imp.status, 403);
    assert.equal(imp.json.error, 'impersonation');
    for (const [m, p] of [
      ['GET', '/api/delegations?active=1'],
      ['POST', '/api/delegations'],
      ['GET', '/api/delegations/dlg_x'],
      ['POST', '/api/delegations/dlg_x/claims'],
      ['POST', '/api/delegations/dlg_x/status'],
      ['POST', '/api/delegations/dlg_x/heartbeat'],
      ['POST', '/api/delegations/dlg_x/release'],
    ]) {
      const r = await fetch(ctx.base + p, { method: m });
      assert.equal(r.status, 401, `${m} ${p}`);
    }
    assert.equal((await ctx.master('GET', '/api/delegations/dlg_nope')).status, 404);
    // 다듬기 규칙 자체
    assert.deepEqual(normalizeClaim(P(' brainstorm ', './/src/./store/')), { kind: 'path', repo: 'brainstorm', scope: 'src/store/' });
    assert.equal(normalizeClaim(P('r', '*')).scope, '*');
    assert.ok(claimsOverlap(normalizeClaim(P('r', 'src/store')), normalizeClaim(P('r', 'src/store.ts'))));
    assert.ok(!claimsOverlap(normalizeClaim(P('r', 'src/a/')), normalizeClaim(P('r', 'src/b/'))));
    assert.ok(!claimsOverlap(normalizeClaim(R('r', 'x')), normalizeClaim(R('r', 'xy'))));
  });

  test('WebSocket 알림 {t:"delegation"} — 스레드 멤버가 아니어도 받는다', async () => {
    const { ws, notices } = await openWs(ctx, { Authorization: `Bearer ${ctx.tokens.beta.token}` });
    try {
      const a = await create([R('notify', 'one')]);
      const id = a.json.delegation.id;
      await waitFor(async () => notices.find((x) => x.t === 'delegation' && x.id === id && x.status === 'queued'));
      await done(id);
      await waitFor(async () => notices.find((x) => x.t === 'delegation' && x.id === id && x.status === 'done'));
    } finally {
      ws.close();
    }
  });

  test('IMMEDIATE 트랜잭션 — 다른 연결이 쓰기 잠금을 쥐면 기다렸다가 그 결과를 보고 판정한다', async () => {
    // 두 번째 연결(다른 프로세스 흉내)이 먼저 선점을 넣고 커밋 → 우리 쪽 검사는 그 행을 본다
    const other = new Database(ctx.cfg.dbPath);
    other.pragma('busy_timeout = 5000');
    const t = Date.now();
    other.transaction(() => {
      other
        .prepare("INSERT INTO delegations(id, assignee, title, spec, status, created_by, created_at, updated_at) VALUES ('dlg_other','baeksu-x','옆 세션','-','running','master',?,?)")
        .run(t, t);
      other.prepare("INSERT INTO claims(delegation_id, kind, repo, scope, origin, claimed_at) VALUES ('dlg_other','path','race','lib/','initial',?)").run(t);
    }).immediate();
    other.close();
    const r = await create([P('race', 'lib/x.ts')]);
    assert.equal(r.status, 409);
    assert.equal(r.json.conflicts[0].delegation_id, 'dlg_other');
  });

  // ── 대기(마이그레이션 13 · 마스터 #345) ──

  test('queue:true — 겹치면 409 대신 queued · 선점 전부 대기(안 겹친 줄도) · conflicts 동봉 · 감사 ok queued', async () => {
    const holder = await create([P('qrepo', 'src/')]);
    const q = await create([P('qrepo', 'src/a.ts'), P('qrepo', 'docs/'), R('deploy', 'Q1')], { queue: true }, 'alpha');
    assert.equal(q.status, 201, JSON.stringify(q.json));
    const d = q.json.delegation;
    assert.equal(q.json.queued, true);
    assert.equal(d.status, 'queued');
    assert.equal(d.waiting, true);
    assert.deepEqual(
      d.claims.map((c: any) => [c.scope, c.granted]),
      [
        ['src/a.ts', false],
        ['docs/', false],
        ['Q1', false],
      ],
    );
    assert.deepEqual(
      q.json.conflicts.map((c: any) => [c.delegation_id, c.scope, c.wanted]),
      [[holder.json.delegation.id, 'src/', 'src/a.ts']],
    );
    const a = ctx.app.db.prepare("SELECT result, reason FROM audit_log WHERE action = 'delegation.create' AND target_id = ?").get(d.id) as any;
    assert.deepEqual({ ...a }, { result: 'ok', reason: 'queued' });
    // 안 겹치면 queue:true 여도 보통처럼 잡힌다
    const free = await create([P('qrepo', 'free/')], { queue: true });
    assert.equal(free.status, 201);
    assert.equal(free.json.queued, undefined);
    assert.equal(free.json.delegation.waiting, false);
    assert.ok(free.json.delegation.claims.every((c: any) => c.granted));
    // 옵션 없음은 예전처럼 409 · 문자열 queue 는 400
    assert.equal((await create([P('qrepo', 'src/b.ts')])).status, 409);
    assert.equal((await create([P('qrepo', 'src/b.ts')], { queue: 'yes' })).status, 400);
    for (const x of [holder, q, free]) await done(x.json.delegation.id);
  });

  test('대기 줄은 남을 막지 않는다 · 대기 위임은 admit 전엔 running·blocked·선점 추가 409 not_admitted', async () => {
    const holder = await create([P('wrepo', 'lib/')]);
    const q = await create([P('wrepo', 'lib/x.ts'), P('wrepo', 'web/')], { queue: true });
    const qid = q.json.delegation.id;
    // web/ 는 대기 중일 뿐 — 남이 잡을 수 있다
    const other = await create([P('wrepo', 'web/index.html')]);
    assert.equal(other.status, 201, '대기 줄은 겹침에 안 센다');
    for (const s of ['running', 'blocked']) {
      const r = await ctx.master('POST', `/api/delegations/${qid}/status`, { status: s });
      assert.equal(r.status, 409, s);
      assert.equal(r.json.error, 'not_admitted');
    }
    const add = await ctx.master('POST', `/api/delegations/${qid}/claims`, { claims: [P('wrepo', 'zzz/')] });
    assert.equal(add.status, 409);
    assert.equal(add.json.error, 'not_admitted');
    assert.equal((await ctx.master('POST', `/api/delegations/${qid}/heartbeat`)).status, 200);
    // 끝내기는 된다 — 대기 줄도 놓인다
    const fin = await done(qid);
    assert.equal(fin.delegation.waiting, false);
    assert.ok(fin.delegation.claims.every((c: any) => c.released_at));
    for (const x of [holder, other]) await done(x.json.delegation.id);
  });

  test('admit — 아직 겹치면 409(대기 그대로) · 비면 전부 잡고 running · 권한은 마스터·만든 이 · not_waiting · 끝난 것', async () => {
    const holder = await create([P('arepo', 'core/')]);
    const q = await create([P('arepo', 'core/x.ts'), R('deploy', 'A1')], { queue: true }, 'alpha');
    const qid = q.json.delegation.id;
    const early = await ctx.agent('alpha', 'POST', `/api/delegations/${qid}/admit`);
    assert.equal(early.status, 409);
    assert.equal(early.json.error, 'claim_conflict');
    assert.equal(early.json.conflicts[0].delegation_id, holder.json.delegation.id);
    const still = (await ctx.master('GET', `/api/delegations/${qid}`)).json.delegation;
    assert.equal(still.status, 'queued');
    assert.ok(still.claims.every((c: any) => !c.granted));
    await done(holder.json.delegation.id);
    // 만든 이 아닌 에이전트는 진입시키지 못한다
    const no = await ctx.agent('beta', 'POST', `/api/delegations/${qid}/admit`);
    assert.equal(no.status, 403);
    assert.equal(no.json.error, 'not_owner');
    const { ws, notices } = await openWs(ctx, { Authorization: `Bearer ${ctx.tokens.beta.token}` });
    try {
      const ok = await ctx.agent('alpha', 'POST', `/api/delegations/${qid}/admit`);
      assert.equal(ok.status, 200, JSON.stringify(ok.json));
      assert.equal(ok.json.delegation.status, 'running');
      assert.equal(ok.json.delegation.waiting, false);
      assert.ok(ok.json.delegation.claims.every((c: any) => c.granted && c.released_at === null));
      await waitFor(async () => notices.find((x) => x.t === 'delegation' && x.id === qid && x.status === 'running'));
    } finally {
      ws.close();
    }
    // 이제 잡혔다 — 남을 막는다
    assert.equal((await create([P('arepo', 'core/')])).status, 409);
    assert.equal((await ctx.master('POST', `/api/delegations/${qid}/admit`)).json.error, 'not_waiting');
    const au = ctx.app.db.prepare("SELECT result, reason FROM audit_log WHERE action = 'delegation.admit' AND target_id = ? ORDER BY id").all(qid) as any[];
    assert.deepEqual(
      au.map((x) => [x.result, x.reason]),
      [
        ['denied', 'claim_conflict'],
        ['denied', 'not_owner'],
        ['ok', null],
      ],
    );
    await done(qid);
    assert.equal((await ctx.master('POST', `/api/delegations/${qid}/admit`)).json.error, 'delegation_closed');
    assert.equal((await fetch(ctx.base + `/api/delegations/${qid}/admit`, { method: 'POST' })).status, 401);
  });

  test('목록 recent — active 에 최근 끝난 것을 더한다 · 범위 밖 400', async () => {
    const a = await create([R('recent', 'one')]);
    await done(a.json.delegation.id);
    const only = (await ctx.master('GET', '/api/delegations?active=1')).json.delegations as any[];
    assert.ok(!only.some((d) => d.id === a.json.delegation.id));
    const withRecent = (await ctx.master('GET', '/api/delegations?active=1&recent=600')).json.delegations as any[];
    assert.ok(withRecent.some((d) => d.id === a.json.delegation.id));
    assert.ok(withRecent.every((d) => !['done', 'cancelled'].includes(d.status) || d.finished_at >= Date.now() - 600_000));
    assert.equal((await ctx.master('GET', '/api/delegations?active=1&recent=-1')).status, 400);
    assert.equal((await ctx.master('GET', '/api/delegations?active=1&recent=999999999')).status, 400);
  });
});

test('마이그레이션 12 — 스키마 11 DB 의 옛 행은 그대로, 새 표 둘은 빈 채로', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mig12-'));
  const db = new Database(path.join(dir, 'x.db'));
  db.pragma('foreign_keys = ON');
  migrate(db, 11);
  assert.equal(db.pragma('user_version', { simple: true }), 11);
  db.prepare("INSERT INTO participants(id, kind, name, is_master, created_at) VALUES ('master','human','m',1,0)").run();
  db.prepare("INSERT INTO threads(id, title, created_by, created_at, updated_at) VALUES ('th_old','옛','master',0,0)").run();
  db.prepare("INSERT INTO messages(id, thread_id, author_id, client_key, body, source_kind, created_at) VALUES ('m1','th_old','master','k','옛 글','instruction',0)").run();
  migrate(db, 12);
  assert.ok(SCHEMA_VERSION >= 12);
  assert.equal(db.pragma('user_version', { simple: true }), 12);
  assert.equal((db.prepare('SELECT title FROM threads WHERE id = ?').get('th_old') as any).title, '옛');
  assert.equal((db.prepare('SELECT body FROM messages WHERE id = ?').get('m1') as any).body, '옛 글');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM delegations').get() as any).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM claims').get() as any).n, 0);
  // CHECK 제약
  assert.throws(() =>
    db.prepare("INSERT INTO delegations(id, assignee, title, spec, status, created_by, created_at, updated_at) VALUES ('d','a','t','s','weird','master',0,0)").run(),
  );
  db.close();
});

test('마이그레이션 13 — 스키마 12 의 옛 선점은 granted=1(잡힌 채) · 새 줄 기본도 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mig13-'));
  const db = new Database(path.join(dir, 'x.db'));
  db.pragma('foreign_keys = ON');
  migrate(db, 12);
  db.prepare("INSERT INTO participants(id, kind, name, is_master, created_at) VALUES ('master','human','m',1,0)").run();
  db.prepare("INSERT INTO delegations(id, assignee, title, spec, status, created_by, created_at, updated_at) VALUES ('d_old','b','옛 위임','-','running','master',0,0)").run();
  db.prepare("INSERT INTO claims(delegation_id, kind, repo, scope, origin, claimed_at) VALUES ('d_old','path','r','src/','initial',0)").run();
  migrate(db);
  assert.ok(SCHEMA_VERSION >= 13);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.equal((db.prepare("SELECT granted FROM claims WHERE delegation_id = 'd_old'").get() as any).granted, 1);
  assert.equal((db.prepare("SELECT title FROM delegations WHERE id = 'd_old'").get() as any).title, '옛 위임');
  assert.throws(() => db.prepare("INSERT INTO claims(delegation_id, kind, repo, scope, origin, claimed_at, granted) VALUES ('d_old','path','r','x','initial',0,2)").run());
  db.close();
});

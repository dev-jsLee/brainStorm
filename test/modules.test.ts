// 선택 모듈 틀(마스터 #1193 · docs/MODULES.md 1단계): 켠 것만 붙고, 모듈 마이그레이션은 한 번만, 모르는 이름은 시작을 멈춘다
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { KNOWN_MODULES, parseModules, type BrainstormModule } from '../src/modules.js';
import { newThread, post, setup } from './helpers.js';

const probe: BrainstormModule = {
  id: 'merge',
  migrations: [{ n: 1, sql: 'CREATE TABLE mod_probe (x INTEGER)' }],
  routes(f, ctx) {
    f.get('/api/mod-probe', async () => ({ rows: (ctx.db.prepare('SELECT COUNT(*) AS n FROM mod_probe').get() as { n: number }).n }));
  },
};

async function boot(dataDir: string, modules: string[]) {
  const cfg = loadConfig({ dataDir, listen: [{ host: '127.0.0.1', port: 0 }], logLevel: 'silent', modules });
  const app = await buildApp(cfg, { logger: false, registry: [probe] });
  const [base] = await app.listen();
  return { app, base };
}

describe('선택 모듈 틀', () => {
  test('BRAINSTORM_MODULES 읽기 — 빔 · 목록 · all · 오타', () => {
    assert.deepEqual(parseModules(undefined), []);
    assert.deepEqual(parseModules(''), []);
    assert.deepEqual(parseModules(' face , delegations,face'), ['face', 'delegations']);
    assert.deepEqual(parseModules('all'), [...KNOWN_MODULES]);
    assert.throws(() => parseModules('face,facee'), /모르는 모듈 facee/);
    // core 로 편입된 옛 이름은 받아 주고 뺀다(마스터 #1873)
    assert.deepEqual(parseModules('face,questions'), ['face']);
    assert.ok(!(KNOWN_MODULES as readonly string[]).includes('questions'));
  });

  test('꺼진 모듈은 경로도 표도 없다 · 켜면 붙고 마이그레이션은 한 번만', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mod-'));
    let { app, base } = await boot(dataDir, []);
    assert.equal((await fetch(base + '/api/mod-probe')).status, 404);
    // 장부 표는 core 질문함(옛 모듈 이름 'questions')이 늘 만든다(마스터 #1873) — 꺼진 모듈의 줄은 없다
    assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM module_migrations WHERE module = 'merge'").get() as { n: number }).n, 0);
    assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM module_migrations WHERE module = 'questions'").get() as { n: number }).n, 1);
    await app.close();
    for (let i = 0; i < 2; i++) {
      ({ app, base } = await boot(dataDir, ['merge']));
      const r = await fetch(base + '/api/mod-probe');
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { rows: 0 });
      assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM module_migrations WHERE module = 'merge'").get() as { n: number }).n, 1);
      await app.close();
    }
  });

  test('/api/me 가 켠 모듈을 알려준다 · 기본은 core 만', async () => {
    const a = await setup();
    assert.deepEqual((await a.master('GET', '/api/me')).json.modules, []);
    await a.close();
    const b = await setup({ modules: ['face', 'requests'] });
    assert.deepEqual((await b.master('GET', '/api/me')).json.modules, ['face', 'requests']);
    await b.close();
  });
});

describe('위임 대장 모듈(delegations) 끄고 켜기', () => {
  test('꺼지면 경로 404 · 켜면 그대로', async () => {
    const off = await setup();
    assert.equal((await off.master('GET', '/api/delegations')).status, 404);
    assert.equal(off.app.store.delegations, null);
    await off.close();
    const on = await setup({ modules: ['delegations'] });
    assert.equal((await on.master('GET', '/api/delegations')).status, 200);
    await on.close();
  });
});

describe('요청 모듈(requests) 끄고 켜기', () => {
  test('꺼지면 경로 404 · «요청→»은 그냥 글 · 규약도 안 실린다', async () => {
    const off = await setup();
    assert.equal(off.app.store.requests, null);
    assert.equal((await off.master('GET', '/api/request-pairs')).status, 404);
    const th = await newThread(off, '요청 꺼짐', 'alpha', ['alpha', 'beta']);
    await post(off, th, '시작', { recipients: ['alpha'] });
    const c = (await off.agent('alpha', 'POST', '/api/adapter/claim', { worker: 'a' })).json.claim;
    assert.equal(c.request_rule, false);
    await off.agent('alpha', 'POST', `/api/adapter/deliveries/${c.delivery.id}/ack`, { lease_token: c.delivery.lease_token });
    await off.agent('alpha', 'POST', `/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token });
    const done = await off.agent('alpha', 'POST', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: '답\n요청→ beta' });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(done.json.message.source_kind, 'proposal');
    assert.ok(done.json.message.body.includes('요청→ beta'), '끝줄을 떼지 않는다');
    assert.equal((await off.agent('beta', 'POST', '/api/adapter/claim', { worker: 'b' })).json.claim, null, 'beta 를 안 깨운다');
    await off.close();
    const on = await setup({ modules: ['requests'] });
    assert.equal((await on.master('GET', '/api/request-pairs')).status, 200);
    await on.close();
  });
});

describe('합치기 모듈(merge) 끄고 켜기', () => {
  test('꺼지면 경로 404 · 하위 스레드 상세에 합침 칸이 없다 · 켜면 합쳐진다', async () => {
    const mk = async (c: Awaited<ReturnType<typeof setup>>) => {
      const parent = await newThread(c, '상위', null, ['alpha']);
      await post(c, parent, '상위 글');
      const seq = (await c.master('GET', `/api/threads/${parent}/messages`)).json.messages.at(-1).seq;
      const kid = await c.master('POST', `/api/threads/${parent}/fork`, { from_seq: seq, title: '하위', client_key: `k-${parent}` });
      assert.equal(kid.status, 201, JSON.stringify(kid.json));
      const id = kid.json.thread.id;
      await post(c, id, '하위 글');
      return id as string;
    };
    const off = await setup();
    const a = await mk(off);
    assert.equal((await off.master('POST', `/api/threads/${a}/merge`)).status, 404);
    assert.equal((await off.master('GET', `/api/threads/${a}`)).json.unmerged, undefined);
    await off.close();
    const on = await setup({ modules: ['merge'] });
    const b = await mk(on);
    assert.equal((await on.master('GET', `/api/threads/${b}`)).json.unmerged, 1);
    assert.equal((await on.master('POST', `/api/threads/${b}/merge`)).status, 201);
    await on.close();
  });
});

describe('대면 모듈(face) 끄고 켜기', () => {
  test('꺼지면 대면 경로는 404 · 켜면 그대로', async () => {
    const off = await setup();
    const id = await newThread(off, '대면 꺼짐', null, ['alpha', 'beta']);
    assert.equal((await off.master('POST', `/api/threads/${id}/mode`, { mode: 'face' })).status, 404);
    assert.equal((await off.master('GET', `/api/threads/${id}/face`)).status, 404);
    assert.equal(off.app.store.face, null);
    await off.close();
    const on = await setup({ modules: ['face'], faceDrafter: 'alpha', faceReviewer: 'beta' });
    assert.notEqual(on.app.store.face, null);
    const id2 = await newThread(on, '대면 켜짐', null, ['alpha', 'beta']);
    assert.equal((await on.master('POST', `/api/threads/${id2}/mode`, { mode: 'face' })).status, 200);
    assert.equal((await on.master('GET', `/api/threads/${id2}/face`)).status, 200);
    await on.close();
  });

  test('대면 모드였던 스레드는 모듈을 끄면 보통 채팅으로 돌고 · 대면 기록은 남는다', async () => {
    const face = { faceDrafter: 'alpha', faceReviewer: 'beta' };
    const on = await setup({ modules: ['face'], ...face });
    const th = await newThread(on, '끌 대면', null, ['alpha', 'beta']);
    assert.equal((await on.master('POST', `/api/threads/${th}/mode`, { mode: 'face' })).status, 200);
    await post(on, th, '대면 글');
    assert.equal((await on.master('GET', `/api/threads/${th}/face`)).json.round.state, 'running');
    await on.close();

    const off = await setup({ modules: [], ...face }, on.dataDir);
    const before = (off.app.db.prepare('SELECT COUNT(*) AS n FROM face_rounds').get() as { n: number }).n;
    assert.equal(before, 1, '라운드 행은 그대로');
    await post(off, th, '채팅 글', { recipients: ['beta'] });
    const msgs = (await off.master('GET', `/api/threads/${th}/messages`)).json.messages;
    assert.deepEqual(msgs.at(-1).recipients, ['beta'], '받는 이를 서버가 대면으로 바꾸지 않는다');
    const pending = off.app.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE thread_id = ? AND recipient_id = 'beta' AND message_seq = ?").get(th, msgs.at(-1).seq) as { n: number };
    assert.equal(pending.n, 1, '보통 채팅처럼 받는 이에게 배달');
    assert.equal((off.app.db.prepare('SELECT COUNT(*) AS n FROM face_rounds').get() as { n: number }).n, 1, '라운드도 안 생긴다');
    await off.close();
  });
});

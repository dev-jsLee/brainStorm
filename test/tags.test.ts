// 태그 보기 1단계(2026-11-03 마스터 #1471~#1481 · 마이그레이션 19) — 파서와 스키마.
//   자리로 가른다(머리/끝줄 = 주 태그 ≤2 · 본문 = 인라인) · 등록 안 된 이름은 글자 · 코드 블록·URL·글 번호(#1234)는 안 셈 · 셋 이상은 거절 · 18 → 19 는 옛 행 그대로
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { migrate, SCHEMA_VERSION } from '../src/db.js';
import { parseTags } from '../src/tags.js';
import { newThread, post, setup, spawnAdapter, waitFor, type Ctx } from './helpers.js';

const known = new Set(['brainStorm', '전원', 'C서버', 'ops_1']);

describe('태그 파서', () => {
  test('사용자 글: 첫 줄 «#A #B» 가 주 태그 · 본문 #C 는 인라인 · 순서 유지', () => {
    const r = parseTags('#brainStorm #전원\n오늘은 #C서버 를 켤까.', known, 'head');
    assert.deepEqual(r, { primary: ['brainStorm', '전원'], inline: ['C서버'], unknown: [], line: 'head' });
  });
  test('에이전트 답: 끝줄이 태그 줄 · 첫 줄은 본문', () => {
    const r = parseTags('#전원 은 본문에서 언급.\n정리했음.\n\n#brainStorm', known, 'tail');
    assert.deepEqual(r.primary, ['brainStorm']);
    assert.deepEqual(r.inline, ['전원']);
    assert.equal(r.line, 'tail');
  });
  test('태그 줄이 아닌 첫 줄(«#A 켜줘»)은 본문 — 인라인으로만', () => {
    const r = parseTags('#전원 켜줘', known, 'head');
    assert.deepEqual(r.primary, []);
    assert.deepEqual(r.inline, ['전원']);
    assert.equal(r.line, null);
  });
  test('등록 안 된 이름은 unknown · 글자로 남는다 — 주 태그 자리든 본문이든', () => {
    const r = parseTags('#없는태그 #전원\n#또없음 과 #ops_1', known, 'head');
    assert.deepEqual(r.primary, ['전원']);
    assert.deepEqual(r.inline, ['ops_1']);
    assert.deepEqual(r.unknown, ['없는태그', '또없음']);
  });
  test('안 세는 것: 코드 블록·인라인 코드·URL 조각·글 번호 #1234·낱말 속 #', () => {
    const body = '#전원\n```\n#brainStorm 은 코드\n```\n`#C서버` 도 코드. https://x.y/#brainStorm 조각. 글 #1234 참고. a#brainStorm 붙음.';
    const r = parseTags(body, known, 'head');
    assert.deepEqual(r.primary, ['전원']);
    assert.deepEqual(r.inline, []);
    assert.deepEqual(r.unknown, []);
  });
  test('주 태그는 개수 제한 없음 · 순서 그대로(메인·서브·참조 — 마스터 #1674)', () => {
    assert.deepEqual(parseTags('#brainStorm #전원 #C서버\n본문', known, 'head').primary, ['brainStorm', '전원', 'C서버']);
  });
  test('같은 태그 반복은 한 번 · 주 태그와 겹친 인라인은 뺀다', () => {
    const r = parseTags('#전원 #전원\n#전원 을 또 말함 #brainStorm #brainStorm', known, 'head');
    assert.deepEqual(r.primary, ['전원']);
    assert.deepEqual(r.inline, ['brainStorm']);
  });
});

describe('마이그레이션 19 — tags · message_tags', () => {
  test('18 → 19: 표 둘이 생기고 옛 표·행은 그대로 · 이름 유일 · role CHECK', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-tags-'));
    const db = new Database(path.join(dir, 'x.db'));
    migrate(db, 18);
    const before = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name);
    migrate(db, 19);
    assert.ok(SCHEMA_VERSION >= 19);
    const after = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name);
    assert.deepEqual(after.filter((n: string) => !before.includes(n)).sort(), ['message_tags', 'tags']);
    db.prepare("INSERT INTO participants(id, kind, name, is_master, created_at) VALUES ('m','human','마스터',1,0)").run();
    const ins = db.prepare("INSERT INTO tags(id, name, created_by, created_at, updated_at) VALUES (?,?,'m',0,0)");
    ins.run('tg_1', '전원');
    assert.throws(() => ins.run('tg_2', '전원'), /UNIQUE/);
    assert.throws(() => db.prepare("INSERT INTO message_tags(message_seq, tag_id, role) VALUES (1,'tg_1','extra')").run(), /CHECK|constraint/i);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('태그 등록부 API (마스터 #1475·#1481)', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(() => ctx.close());
  test('마스터가 만든다 · 에이전트는 403 · 같은 이름 409 · 숫자만·이상한 이름 400', async () => {
    const r = await ctx.master('POST', '/api/tags', { name: '#전원' });
    assert.equal(r.status, 201);
    assert.equal(r.json.tag.name, '전원');
    assert.equal(r.json.tag.owner_id, null);
    assert.equal(r.json.tag.recipient_id, null); // 대표 에이전트가 아직 없다
    assert.equal((await ctx.agent('alpha', 'POST', '/api/tags', { name: 'x' })).status, 403);
    assert.equal((await ctx.master('POST', '/api/tags', { name: '전원' })).status, 409);
    assert.equal((await ctx.master('POST', '/api/tags', { name: '1234' })).status, 400);
    assert.equal((await ctx.master('POST', '/api/tags', { name: 'a b' })).status, 400);
    assert.equal((await ctx.master('POST', '/api/tags', { name: 'ok', owner_id: 'nobody' })).status, 400);
  });
  test('대표 에이전트: 설정하면 담당자 없는 태그의 수신자가 바뀜 · 담당자를 둔 태그는 덮어씀 · 비우면 대표로 돌아감', async () => {
    const tg = (await ctx.master('GET', '/api/tags')).json.tags.find((t: any) => t.name === '전원');
    assert.equal((await ctx.agent('alpha', 'PUT', '/api/settings/default-agent', { default_agent: 'alpha' })).status, 403);
    assert.equal((await ctx.master('PUT', '/api/settings/default-agent', { default_agent: 'nobody' })).status, 400);
    const s = await ctx.master('PUT', '/api/settings/default-agent', { default_agent: 'alpha' });
    assert.equal(s.json.default_agent, 'alpha');
    let list = (await ctx.master('GET', '/api/tags')).json;
    assert.equal(list.default_agent, 'alpha');
    assert.equal(list.tags.find((t: any) => t.id === tg.id).recipient_id, 'alpha');
    const u = await ctx.master('PATCH', `/api/tags/${tg.id}`, { owner_id: 'beta' });
    assert.equal(u.json.tag.owner_id, 'beta');
    assert.equal(u.json.tag.recipient_id, 'beta');
    await ctx.master('PUT', '/api/settings/default-agent', { default_agent: 'beta' });
    const u2 = await ctx.master('PATCH', `/api/tags/${tg.id}`, { owner_id: null });
    assert.equal(u2.json.tag.owner_id, null);
    assert.equal(u2.json.tag.recipient_id, 'beta');
    assert.equal((await ctx.agent('alpha', 'PATCH', `/api/tags/${tg.id}`, { owner_id: 'alpha' })).status, 403);
  });
  test('이름 바꾸기 · 보관하면 기본 목록에서 빠지고 archived=1 로만 · 되살리기 · 보관 시각은 유지', async () => {
    const tg = (await ctx.master('GET', '/api/tags')).json.tags.find((t: any) => t.name === '전원');
    const r = await ctx.master('PATCH', `/api/tags/${tg.id}`, { name: '전력' });
    assert.equal(r.json.tag.name, '전력');
    const a = await ctx.master('PATCH', `/api/tags/${tg.id}`, { archived: true });
    assert.ok(a.json.tag.archived_at);
    assert.ok(!(await ctx.master('GET', '/api/tags')).json.tags.some((t: any) => t.id === tg.id));
    assert.ok((await ctx.agent('alpha', 'GET', '/api/tags?archived=1')).json.tags.some((t: any) => t.id === tg.id));
    assert.equal((await ctx.master('PATCH', `/api/tags/${tg.id}`, { archived: true })).json.tag.archived_at, a.json.tag.archived_at);
    const b = await ctx.master('PATCH', `/api/tags/${tg.id}`, { archived: false });
    assert.equal(b.json.tag.archived_at, null);
    assert.equal((await ctx.master('PATCH', `/api/tags/${tg.id}`, {})).status, 400);
    assert.equal((await ctx.master('PATCH', `/api/tags/tg_none`, { name: 'x' })).status, 404);
  });
  test('감사: tag.create ok/denied · tag.update · settings.default_agent', async () => {
    const audit = (await ctx.master('GET', '/api/audit?limit=200')).json;
    const rows: any[] = audit.rows ?? audit.entries ?? audit.audit ?? [];
    const acts = new Set(rows.map((r) => r.action));
    for (const a of ['tag.create', 'tag.update', 'settings.default_agent']) assert.ok(acts.has(a), a);
  });
});

describe('글에 붙는 태그 · 상속 · 보기 (사양 2.1·2.2)', () => {
  let ctx: Ctx;
  let th: string;
  let A: string;
  let B: string;
  let C: string;
  before(async () => {
    ctx = await setup();
    th = await newThread(ctx, '태그 방', 'alpha', ['alpha', 'beta']);
    A = (await ctx.master('POST', '/api/tags', { name: '전원' })).json.tag.id;
    B = (await ctx.master('POST', '/api/tags', { name: 'brainStorm' })).json.tag.id;
    C = (await ctx.master('POST', '/api/tags', { name: 'C서버' })).json.tag.id;
  });
  after(() => ctx.close());
  const msgsOf = async (tag: string, who: 'master' | 'alpha' = 'master') =>
    (who === 'master' ? await ctx.master('GET', `/api/tags/${tag}/messages`) : await ctx.agent('alpha', 'GET', `/api/tags/${tag}/messages`)).json;

  test('보기의 태그(tags:[…]) + 첫 줄 태그 줄이 주 태그 · 본문 #C 는 인라인 · 목록에 tags 가 실린다', async () => {
    const r = await post(ctx, th, '#brainStorm\n오늘 #C서버 켤까', { tags: ['전원'], recipients: [] });
    assert.deepEqual(r.message.tags.primary.map((t: any) => t.id), [A, B]);
    assert.deepEqual(r.message.tags.inline.map((t: any) => t.id), [C]);
    const list = (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages;
    assert.deepEqual(list.find((m: any) => m.seq === r.message.seq).tags.primary.map((t: any) => t.name), ['전원', 'brainStorm']);
  });
  test('주 태그 셋도 받는다(순서: tags 먼저 · 첫 줄 다음) · 등록 안 된 태그를 tags 로 내밀면 400 · 보관 태그는 400 tag_archived · 글은 안 남는다', async () => {
    const n0 = (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages.length;
    const raw = (body: string, extra: Record<string, unknown>) => ctx.master('POST', `/api/threads/${th}/messages`, { client_key: `k${Math.random()}`, body, ...extra });
    const tm = await raw('#C서버\n본문', { tags: [A, B], recipients: [] });
    assert.equal(tm.status, 201);
    assert.equal(tm.json.message.tags.primary.length, 3);
    assert.deepEqual(tm.json.message.tags.primary.slice(0, 2).map((t: any) => t.id), [A, B]);
    assert.equal((await raw('본문', { tags: ['없는태그'], recipients: [] })).status, 400);
    const D = (await ctx.master('POST', '/api/tags', { name: '보관될것' })).json.tag.id;
    await ctx.master('PATCH', `/api/tags/${D}`, { archived: true });
    const ar = await raw('본문', { tags: [D], recipients: [] });
    assert.equal(ar.status, 400);
    assert.equal(ar.json.error, 'tag_archived');
    // 본문 속 보관 태그는 글자로 — 글은 올라가고 태그는 안 붙는다
    const ok = await post(ctx, th, '#보관될것\n글자로만', { recipients: [] });
    assert.deepEqual(ok.message.tags, { primary: [], inline: [] });
    assert.equal((await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages.length, n0 + 2);
  });
  test('답장은 원문의 주 태그를 전부 따라간다(#1795) — #A 방에서 #A #B 글에 답해도 #A #B · 원문 순서 앞 · 더 붙인 태그는 뒤 · 답장 아니면 그대로', async () => {
    const src = await post(ctx, th, '#전원 #brainStorm\n원문', { recipients: [] });
    assert.deepEqual(src.message.tags.primary.map((t: any) => t.id), [A, B]);
    const inA = await post(ctx, th, '답', { tags: [A], reply_to_seq: src.message.seq, recipients: [] });
    assert.deepEqual(inA.message.tags.primary.map((t: any) => t.id), [A, B]);
    const inB = await post(ctx, th, '답', { tags: [B], reply_to_seq: src.message.seq, recipients: [] });
    assert.deepEqual(inB.message.tags.primary.map((t: any) => t.id), [A, B]);
    const more = await post(ctx, th, '#C서버\n답', { tags: [A], reply_to_seq: src.message.seq, recipients: [] });
    assert.deepEqual(more.message.tags.primary.map((t: any) => t.id), [A, B, C]);
    const plain = await post(ctx, th, '답 아님', { tags: [A], recipients: [] });
    assert.deepEqual(plain.message.tags.primary.map((t: any) => t.id), [A]);
    const ids = async (tag: string) => (await msgsOf(tag)).messages.map((m: any) => m.seq);
    assert.ok((await ids(B)).includes(inA.message.seq));
  });
  test('에이전트 답: 끝줄 태그 줄이 없으면 받은 글의 주 태그를 물려받고 · 있으면 그것을 쓴다', async () => {
    const fa = spawnAdapter(ctx, 'alpha', ['--max-idle-ms', '2500']);
    try {
      const q1 = await post(ctx, th, '#전원\n켜줘', { recipients: ['alpha'] });
      const a1 = await waitFor(async () => (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages.find((m: any) => m.author_id === 'alpha' && m.reply_to_seq === q1.message.seq));
      assert.deepEqual(a1.tags.primary.map((t: any) => t.id), [A], '상속');
      const q2 = await post(ctx, th, '#전원\n이건 C 얘기\n\n#C서버', { recipients: ['alpha'] });
      const a2 = await waitFor(async () => (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages.find((m: any) => m.author_id === 'alpha' && m.reply_to_seq === q2.message.seq));
      assert.deepEqual(a2.tags.primary.map((t: any) => t.id), [C], '끝줄 태그 줄');
      assert.deepEqual(a2.tags.inline.map((t: any) => t.id), [A]);
    } finally {
      fa.kill();
      await fa.exited;
    }
  });
  test('보기: 태그가 든 글만 seq 순 · 인라인도 보임 · 멤버 아닌 스레드의 글은 에이전트에게 안 보임 · 커서 · 없는 태그 404', async () => {
    const other = await newThread(ctx, '알파 없는 방', 'beta', ['beta']);
    const hidden = await post(ctx, other, '#전원\n알파는 못 본다', { recipients: [] });
    const vm = await msgsOf(A);
    assert.equal(vm.tag.id, A);
    const seqs = vm.messages.map((m: any) => m.seq);
    assert.deepEqual([...seqs].sort((x, y) => x - y), seqs);
    assert.ok(seqs.includes(hidden.message.seq));
    assert.ok(vm.messages.every((m: any) => [...m.tags.primary, ...m.tags.inline].some((t: any) => t.id === A)));
    const va = await msgsOf(A, 'alpha');
    assert.ok(!va.messages.some((m: any) => m.seq === hidden.message.seq));
    assert.ok(va.messages.length >= 3);
    const page = (await ctx.master('GET', `/api/tags/${A}/messages?limit=1`)).json;
    assert.equal(page.messages.length, 1);
    assert.equal(page.has_more, true);
    assert.equal(page.next_cursor, page.messages[0].seq);
    assert.equal((await ctx.master('GET', '/api/tags/tg_none/messages')).status, 404);
    const vc = await msgsOf(C);
    assert.ok(vc.messages.some((m: any) => m.tags.inline.some((t: any) => t.id === C)));
  });
});

describe('글 번호로 찾기 GET /api/messages/:seq (마스터 #1537)', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(() => ctx.close());
  test('그 글의 대화를 돌려준다 · 없는 번호·이상한 값은 404/400 · 멤버 아닌 에이전트는 404', async () => {
    const th = await newThread(ctx, '찾기', null, ['alpha']);
    const m = await post(ctx, th, '찾을 글', { recipients: [] });
    const seq = m.message.seq;
    const r = await ctx.master('GET', `/api/messages/${seq}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { seq, thread_id: th });
    assert.equal((await ctx.agent('alpha', 'GET', `/api/messages/${seq}`)).json.thread_id, th);
    assert.equal((await ctx.agent('beta', 'GET', `/api/messages/${seq}`)).status, 404);
    assert.equal((await ctx.master('GET', '/api/messages/999999')).status, 404);
    assert.equal((await ctx.master('GET', '/api/messages/abc')).status, 400);
  });
});

describe('태그 목록 거리 순 — 마지막 부름 (사양 6절 D10 · 마스터 #1510·#1512)', () => {
  let ctx: Ctx;
  let th: string;
  before(async () => {
    ctx = await setup();
    th = await newThread(ctx, '궤도 방', 'alpha', ['alpha']);
    for (const name of ['가', '나', '다']) await ctx.master('POST', '/api/tags', { name });
  });
  after(() => ctx.close());
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const order = async () => (await ctx.master('GET', '/api/tags')).json.tags.map((t: any) => [t.name, t.last_called_at === null]);

  test('안 부른 태그는 이름 순 · 부르면 맨 앞 · 인라인 언급은 부름이 아님 · 다시 부르면 돌아옴', async () => {
    assert.deepEqual(await order(), [['가', true], ['나', true], ['다', true]]);
    await post(ctx, th, '#나\n첫 부름', { recipients: [] });
    await tick();
    await post(ctx, th, '#가\n둘째 부름 · 본문에 #다 를 스침', { recipients: [] });
    assert.deepEqual(await order(), [['가', false], ['나', false], ['다', true]]);
    await tick();
    await post(ctx, th, '#나\n다시 부름', { recipients: [] });
    assert.deepEqual(await order(), [['나', false], ['가', false], ['다', true]]);
    const one = (await ctx.master('GET', '/api/tags')).json.tags[0];
    assert.equal(typeof one.last_called_at, 'number');
  });
});

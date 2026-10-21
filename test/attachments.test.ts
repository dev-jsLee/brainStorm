// 첨부 2판(2026-10-13 마스터 «이미지·문서 첨부»): 먼저 올리고(업로드) 메시지에 묶는다 · 형식 판별 · 에이전트 맥락 · 그림 미리보기.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { migrate } from '../src/db.js';
import { sniffAttachment } from '../src/store.js';
import { key, newThread, post, setup, sleep, type Ctx } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a0f10000000049454e44ae426082', 'hex');

describe('첨부: 형식 판별', () => {
  test('그림·PDF·텍스트·그 밖', () => {
    assert.deepEqual(sniffAttachment(PNG), { kind: 'image', mime: 'image/png' });
    assert.deepEqual(sniffAttachment(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])), { kind: 'image', mime: 'image/jpeg' });
    assert.deepEqual(sniffAttachment(Buffer.from('GIF89a....')), { kind: 'image', mime: 'image/gif' });
    assert.deepEqual(sniffAttachment(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), { kind: 'image', mime: 'image/webp' });
    assert.deepEqual(sniffAttachment(Buffer.from('%PDF-1.7\n...')), { kind: 'pdf', mime: 'application/pdf' });
    assert.deepEqual(sniffAttachment(Buffer.from('# 제목\n본문 한 줄\n')), { kind: 'text', mime: 'text/plain; charset=utf-8' });
    // SVG 는 글자다 — 그림으로 내보내지 않는다(스크립트를 품을 수 있다)
    assert.equal(sniffAttachment(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>')).kind, 'text');
    assert.deepEqual(sniffAttachment(Buffer.from([0, 1, 2, 3, 0xfe])), { kind: 'file', mime: 'application/octet-stream' });
    assert.equal(sniffAttachment(Buffer.from([0xc3, 0x28, 0x41])).kind, 'file'); // 깨진 UTF-8
  });
});

describe('첨부: 업로드 → 메시지에 묶기', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup({ attachmentMaxBytes: 4096, uploadTtlMs: 400 });
  });
  after(() => ctx.close());

  const upload = (name: string, data: Buffer, who?: string) =>
    fetch(`${ctx.base}/api/uploads?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: who
        ? { Authorization: `Bearer ${ctx.tokens[who].token}`, 'Content-Type': 'application/octet-stream' }
        : { Cookie: ctx.cookie, Origin: ctx.base, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(data),
    }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));

  test('올리기 → 묶기 → 메시지·목록에 첨부 · 업로드 대기 행은 사라진다', async () => {
    const th = await newThread(ctx, '첨부', null);
    const u1 = await upload('그림.png', PNG);
    assert.equal(u1.status, 201);
    assert.equal(u1.json.upload.kind, 'image');
    assert.equal(u1.json.upload.mime, 'image/png');
    const u2 = await upload('메모.md', Buffer.from('# 메모\n사과\n'));
    assert.equal(u2.json.upload.kind, 'text');
    const r = await post(ctx, th, '두 개 붙임', { attachments: [u1.json.upload.id, u2.json.upload.id] });
    assert.deepEqual(
      r.message.attachments.map((a: any) => [a.name, a.kind, a.mime]),
      [
        ['그림.png', 'image', 'image/png'],
        ['메모.md', 'text', 'text/plain; charset=utf-8'],
      ],
    );
    assert.equal((ctx.app.db.prepare('SELECT COUNT(*) n FROM uploads').get() as any).n, 0);
    const list = await ctx.master('GET', `/api/threads/${th}/messages`);
    assert.equal(list.json.messages.at(-1).attachments.length, 2);
    // 같은 client_key 로 다시 보내도(응답 유실 뒤 재시도) 두 번 저장되지 않는다 — 업로드는 이미 쓰였어도 중복으로 받는다
    const again = await ctx.master('POST', `/api/threads/${th}/messages`, {
      client_key: r.message.client_key,
      body: '두 개 붙임',
      attachments: [u1.json.upload.id, u2.json.upload.id],
    });
    assert.equal(again.status, 200);
    assert.equal(again.json.duplicate, true);
  });

  test('본문 없이 첨부만 보낼 수 있다 · 둘 다 없으면 거절', async () => {
    const th = await newThread(ctx, '첨부만', null);
    const u = await upload('a.txt', Buffer.from('hello'));
    const r = await post(ctx, th, '', { attachments: [u.json.upload.id] });
    assert.equal(r.message.body, '');
    const no = await ctx.master('POST', `/api/threads/${th}/messages`, { client_key: key(), body: '  ' });
    assert.equal(no.status, 400);
  });

  test('거절: 6개 이상 · 남의 업로드 · 이미 쓴 업로드 · 없는 id', async () => {
    const th = await newThread(ctx, '거절', null);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await upload(`f${i}.txt`, Buffer.from(`f${i}`))).json.upload.id);
    const six = await ctx.master('POST', `/api/threads/${th}/messages`, { client_key: key(), body: 'x', attachments: ids });
    assert.equal(six.status, 400);
    assert.equal(six.json.error, 'too_many_attachments');
    const theirs = (await upload('agent.txt', Buffer.from('a'), 'alpha')).json.upload.id;
    const r1 = await ctx.master('POST', `/api/threads/${th}/messages`, { client_key: key(), body: 'x', attachments: [theirs] });
    assert.equal(r1.status, 400);
    assert.equal(r1.json.error, 'bad_attachment');
    await post(ctx, th, 'ok', { attachments: [ids[0]] });
    const r2 = await ctx.master('POST', `/api/threads/${th}/messages`, { client_key: key(), body: 'x', attachments: [ids[0]] });
    assert.equal(r2.json.error, 'bad_attachment');
    const r3 = await ctx.master('POST', `/api/threads/${th}/messages`, { client_key: key(), body: 'x', attachments: ['upl_nope'] });
    assert.equal(r3.json.error, 'bad_attachment');
    // 거절된 메시지는 남지 않는다(업로드도 그대로 — 다시 쓸 수 있다)
    await post(ctx, th, 'ok2', { attachments: [ids[1]] });
  });

  test('크기 제한 413 · 빈 파일 400', async () => {
    assert.equal((await upload('big.bin', Buffer.alloc(4097))).status, 413);
    assert.equal((await upload('empty.bin', Buffer.alloc(0))).status, 400);
  });

  test('업로드 취소: 주인만 · 파일도 지운다', async () => {
    const u = await upload('x.txt', Buffer.from('x'));
    const id = u.json.upload.id;
    const file = path.join(ctx.cfg.attachmentsDir, id);
    assert.ok(fs.existsSync(file));
    assert.equal((await ctx.agent('alpha', 'DELETE', `/api/uploads/${id}`)).status, 404);
    assert.equal((await ctx.master('DELETE', `/api/uploads/${id}`)).status, 200);
    assert.ok(!fs.existsSync(file));
  });

  test('묶이지 않은 업로드는 시간이 지나면 걷힌다', async () => {
    const th = await newThread(ctx, '만료', null);
    const u = await upload('old.txt', Buffer.from('old'));
    const id = u.json.upload.id;
    await sleep(600);
    await upload('new.txt', Buffer.from('new')); // 걷기는 새 업로드 때도 돈다
    assert.ok(!fs.existsSync(path.join(ctx.cfg.attachmentsDir, id)));
    const r = await ctx.master('POST', `/api/threads/${th}/messages`, { client_key: key(), body: 'x', attachments: [id] });
    assert.equal(r.json.error, 'bad_attachment');
  });

  test('에이전트: claim 맥락에 첨부 목록 · 내려받기 · 멤버가 아니면 404', async () => {
    const th = await newThread(ctx, '에이전트 첨부', 'alpha');
    const u = await upload('도면.png', PNG);
    await post(ctx, th, '이 그림 봐', { attachments: [u.json.upload.id] });
    const c = await ctx.agent('alpha', 'POST', '/api/adapter/claim', { worker: 't' });
    const att = c.json.claim.trigger.attachments;
    assert.deepEqual(att.map((a: any) => [a.name, a.kind, a.mime, a.size]), [['도면.png', 'image', 'image/png', PNG.length]]);
    assert.equal(c.json.claim.context.find((m: any) => m.seq === c.json.claim.trigger.seq).attachments.length, 1);
    const dl = await fetch(`${ctx.base}/api/attachments/${att[0].id}`, { headers: { Authorization: `Bearer ${ctx.tokens.alpha.token}` } });
    assert.equal(dl.status, 200);
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), PNG);
    const no = await fetch(`${ctx.base}/api/attachments/${att[0].id}`, { headers: { Authorization: `Bearer ${ctx.tokens.beta.token}` } });
    assert.equal(no.status, 404);
  });

  test('미리보기: 그림만 inline(제 형식 · sandbox) · 나머지는 늘 내려받기', async () => {
    const th = await newThread(ctx, '미리보기', null);
    const img = (await upload('a.png', PNG)).json.upload.id;
    const svg = (await upload('b.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).json.upload.id;
    await post(ctx, th, 'x', { attachments: [img, svg] });
    const a = await fetch(`${ctx.base}/api/attachments/${img}?inline=1`, { headers: { Cookie: ctx.cookie } });
    assert.equal(a.headers.get('content-type'), 'image/png');
    assert.match(a.headers.get('content-disposition') ?? '', /^inline/);
    assert.match(a.headers.get('content-security-policy') ?? '', /sandbox/);
    const b = await fetch(`${ctx.base}/api/attachments/${svg}?inline=1`, { headers: { Cookie: ctx.cookie } });
    assert.equal(b.headers.get('content-type'), 'application/octet-stream');
    assert.match(b.headers.get('content-disposition') ?? '', /^attachment/);
  });

  test('옛 경로(메시지 뒤에 붙이기)도 형식을 판별한다', async () => {
    const th = await newThread(ctx, '옛 경로', null);
    const m = await post(ctx, th, 'x');
    const r = await fetch(`${ctx.base}/api/threads/${th}/messages/${m.message.seq}/attachments?name=p.png`, {
      method: 'POST',
      headers: { Cookie: ctx.cookie, Origin: ctx.base, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(PNG),
    });
    assert.equal(r.status, 201);
    assert.equal(((await r.json()) as any).attachment.kind, 'image');
  });
});

test('마이그레이션 8: 옛 첨부는 kind=file · mime=octet-stream 그대로 · uploads 표가 생긴다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mig8-'));
  const db = new Database(path.join(dir, 'x.db'));
  db.pragma('foreign_keys = ON');
  migrate(db, 7);
  db.prepare("INSERT INTO participants(id, kind, name, is_master, created_at) VALUES ('master','human','m',1,0)").run();
  db.prepare("INSERT INTO threads(id, title, created_by, created_at, updated_at) VALUES ('th_old','옛','master',0,0)").run();
  db.prepare(
    "INSERT INTO messages(id, thread_id, author_id, client_key, body, source_kind, input_mode, recipients, created_at) VALUES ('m1','th_old','master','k','옛 글','instruction','text','[]',0)",
  ).run();
  const seq = (db.prepare('SELECT seq FROM messages').get() as any).seq;
  db.prepare("INSERT INTO attachments(id, message_seq, kind, name, path, size, sha256, created_at) VALUES ('att_old',?,'file','a.png','attachments/att_old',3,'x',0)").run(seq);
  migrate(db);
  assert.deepEqual({ ...(db.prepare('SELECT kind, mime FROM attachments').get() as any) }, { kind: 'file', mime: 'application/octet-stream' });
  assert.equal((db.prepare('SELECT COUNT(*) n FROM uploads').get() as any).n, 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

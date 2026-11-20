// bs-ask(deploy/claude-cli/bs-ask.mjs) — 에이전트가 턴 안에서 부르는 질문함 명령. 실제 서버에 프로세스로 붙여 본다.
//   post(BRAINSTORM_THREAD_ID) → list → close(글로 답함 · 근거 글) → list --closed · 다른 에이전트 close 거절 · 모듈 꺼짐 = 종료 코드 3
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { newThread, post, setup, type Ctx } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BS_ASK = path.resolve(here, '..', '..', 'deploy', 'claude-cli', 'bs-ask.mjs');

function run(ctx: Ctx, who: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const tokFile = path.join(ctx.dataDir, `${who}.token`);
  fs.writeFileSync(tokFile, ctx.tokens[who].token, { mode: 0o600 });
  return new Promise((resolve) => {
    execFile(process.execPath, [BS_ASK, ...args], { env: { PATH: process.env.PATH ?? '', BRAINSTORM_URL: ctx.base, BRAINSTORM_TOKEN_FILE: tokFile, ...env } }, (e, out, err) =>
      resolve({ code: e ? ((e as NodeJS.ErrnoException & { code?: number }).code as unknown as number) ?? 1 : 0, out: String(out), err: String(err) }),
    );
  });
}

const Q = JSON.stringify({ items: [{ header: '갈림', question: '어느 쪽?', options: [{ label: 'A안' }, { label: 'B안' }], recommended: 1 }] });

describe('bs-ask 명령', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup({ modules: ['questions'] });
  });
  after(async () => ctx.close());

  test('파일이 있고 실행 줄이 node 다(설치: install -m 755 → ~/.local/bin/bs-ask)', () => {
    assert.ok(fs.existsSync(BS_ASK));
    assert.match(fs.readFileSync(BS_ASK, 'utf8'), /^#!\/usr\/bin\/env node\n/);
  });

  test('post → list → close(글로 답함) → list --closed · 남의 질문 close 는 거절', async () => {
    const th = await newThread(ctx, 'bs-ask', null, ['alpha', 'beta']);
    const p = await run(ctx, 'alpha', ['post', Q], { BRAINSTORM_THREAD_ID: th });
    assert.equal(p.code, 0, p.err);
    const id = /올림: (\S+)/.exec(p.out)?.[1];
    assert.ok(id, p.out);

    const l = await run(ctx, 'alpha', ['list']);
    assert.equal(l.code, 0, l.err);
    assert.match(l.out, new RegExp(`${id} · #\\d+ · open`));
    assert.match(l.out, /1\) B안 \(추천\) \/ 2\) A안/);

    const other = await run(ctx, 'beta', ['close', id!, '--answer', 'B안', '--by-msg', '1']);
    assert.notEqual(other.code, 0);
    assert.match(other.err, /HTTP 403/);

    const m = await post(ctx, th, '그냥 B 로 가');
    const seq = (m as { seq?: number; message?: { seq: number } }).seq ?? (m as { message: { seq: number } }).message.seq;
    const c = await run(ctx, 'alpha', ['close', id!, '--answer', 'B안', '--by-msg', `#${seq}`]);
    assert.equal(c.code, 0, c.err);
    assert.match(c.out, /내림: .* 문항 1 · 질문 상태 answered_in_chat/);

    const closed = await run(ctx, 'alpha', ['list', '--closed']);
    assert.match(closed.out, /«B안»\(글에서 읽음 #\d+\)/);
  });

  test('스레드·토큰이 없으면 바로 멈춤', async () => {
    const r = await run(ctx, 'alpha', ['post', Q]);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /스레드가 없음/);
  });
});

describe('bs-ask — 선택 모듈을 안 켠 서버(질문함은 core · 마스터 #1873)', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup({ modules: [] });
  });
  after(async () => ctx.close());

  test('그래도 올라간다(종료 코드 0)', async () => {
    const th = await newThread(ctx, '모듈 없음', null, ['alpha']);
    const r = await run(ctx, 'alpha', ['post', Q], { BRAINSTORM_THREAD_ID: th });
    assert.equal(r.code, 0, r.err);
  });
});

// 글꼴 길(디자인 #782): public/fonts 아래 있는 woff2 만 열고 나머지는 404 · 오래 캐시 · fonts.css 는 정적 목록
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { setup, type Ctx } from './helpers.js';

describe('글꼴', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(async () => ctx.close());

  test('있는 woff2 는 200 · font/woff2 · immutable', async () => {
    const f = fs.readdirSync(new URL('../../public/fonts/latin/', import.meta.url)).find((n) => n.endsWith('.woff2'))!;
    const r = await fetch(`${ctx.base}/fonts/latin/${f}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'font/woff2');
    assert.match(r.headers.get('cache-control') ?? '', /immutable/);
    assert.ok((await r.arrayBuffer()).byteLength > 1000);
  });

  test('한글 조각(이름에 .숫자)도 200 — fonts.css 가 가리키는 파일은 모두 열린다', async () => {
    const css = fs.readFileSync(new URL('../../public/fonts.css', import.meta.url), 'utf8');
    const urls = [...new Set([...css.matchAll(/url\((\/fonts\/[^)]+)\)/g)].map((m) => m[1]))];
    assert.ok(urls.length > 100);
    for (const u of urls) assert.equal((await fetch(ctx.base + u)).status, 200, u);
  });

  test('목록 밖·경로 넘기·다른 확장자는 404', async () => {
    for (const p of ['/fonts/latin/nope.woff2', '/fonts/latin/..%2F..%2Fpackage.json', '/fonts/..%2Fsrc/app.ts', '/fonts/latin/OFL.txt', '/fonts/OFL-lora.txt']) {
      const r = await fetch(ctx.base + p);
      assert.equal(r.status, 404, p);
    }
  });

  test('fonts.css 는 정적 파일로 · 외부 주소 없음', async () => {
    const r = await fetch(`${ctx.base}/fonts.css`);
    assert.equal(r.status, 200);
    const t = await r.text();
    assert.match(t, /@font-face/);
    assert.doesNotMatch(t, /https?:\/\//);
  });
});

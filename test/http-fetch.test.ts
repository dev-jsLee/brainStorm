// LLM 요청용 httpFetch — 내장 fetch 의 300초 무응답 제한 없이 표준 Response 를 돌려준다(2026-10-13 메티 `terminated` 실패).
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { httpFetch } from '../adapter/openai/http.js';

describe('httpFetch', () => {
  let server: http.Server;
  let base = '';
  let lastBody = '';
  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        lastBody = raw;
        if (req.url === '/slow-head') return void setTimeout(() => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":1}'), 600);
        if (req.url === '/stream') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: a\n\n');
          setTimeout(() => res.end('data: b\n\n'), 400);
          return;
        }
        if (req.url === '/hang') return void res.writeHead(200, { 'Content-Type': 'text/event-stream' }).write('data: a\n\n');
        if (req.url === '/never') return; // 헤더도 안 보낸다
        if (req.url === '/err') return void res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"nope"}');
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Echo': String(req.headers.authorization ?? '') }).end(JSON.stringify({ method: req.method }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));

  test('POST 본문·헤더가 가고 표준 Response(상태·헤더·json)가 온다', async () => {
    const r = await httpFetch(`${base}/x`, { method: 'POST', headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json' }, body: '{"q":1}' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-echo'), 'Bearer k');
    assert.deepEqual(await r.json(), { method: 'POST' });
    assert.equal(lastBody, '{"q":1}');
  });

  test('헤더가 늦어도 기다린다 · 오류 상태도 본문을 읽는다', async () => {
    assert.deepEqual(await (await httpFetch(`${base}/slow-head`)).json(), { ok: 1 });
    const e = await httpFetch(`${base}/err`);
    assert.equal(e.ok, false);
    assert.equal(e.status, 401);
    assert.match(await e.text(), /nope/);
  });

  test('스트림 조각을 차례로 읽는다', async () => {
    const r = await httpFetch(`${base}/stream`);
    assert.equal(r.headers.get('content-type'), 'text/event-stream');
    assert.equal(await r.text(), 'data: a\n\ndata: b\n\n');
  });

  test('abort: 헤더 전이면 요청이 AbortError 로 · 본문 중이면 읽기가 던진다', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(httpFetch(`${base}/never`, { signal: ac.signal }), (e: any) => e.name === 'AbortError');
    const ac2 = new AbortController();
    const r = await httpFetch(`${base}/hang`, { signal: ac2.signal });
    const reader = r.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: a\n\n');
    setTimeout(() => ac2.abort(), 100);
    await assert.rejects(reader.read());
    const ac3 = new AbortController();
    ac3.abort();
    await assert.rejects(httpFetch(`${base}/x`, { signal: ac3.signal }), (e: any) => e.name === 'AbortError');
  });
});

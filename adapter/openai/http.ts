// LLM 요청용 fetch — Node 내장 fetch(undici)는 헤더·본문 사이 무응답이 300초(headersTimeout·bodyTimeout 기본값)를 넘으면
// `terminated` 로 끊는다. OpenClaw 게이트웨이처럼 에이전트 턴이 끝날 때까지 한 바이트도 안 보내는 서버에서는
// 5분 넘게 생각하는 턴이 전부 실패한다(2026-10-13 메티 실패 2건 · 301 s·315 s). 여기서는 node:http 로 직접 보내고
// 시간 상한은 부르는 쪽 AbortSignal(OPENAI_TIMEOUT_MS)만 정한다. 돌려주는 것은 표준 Response 다.
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

export function httpFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const signal = init.signal ?? undefined;
    const abortError = () => (signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    if (signal?.aborted) return reject(abortError());
    const u = new URL(String(input));
    const mod = u.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const req = mod.request(u, { method: init.method ?? 'GET', headers }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
      const status = res.statusCode ?? 502;
      const empty = status === 204 || status === 304 || init.method === 'HEAD';
      if (empty) res.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers: h }));
    });
    req.setTimeout(0); // 소켓 무응답 제한 없음 — 상한은 signal
    const onAbort = () => req.destroy(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    req.on('error', reject); // 응답 전 오류만 여기로 — 응답 뒤 오류는 본문 스트림이 던진다
    const b = init.body;
    if (b == null) req.end();
    else if (typeof b === 'string' || b instanceof Uint8Array) req.end(b);
    else reject(new TypeError('httpFetch: body 는 문자열이나 바이트만'));
  });
}

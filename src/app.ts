// HTTP(REST가 원본) + WebSocket(«새 seq 있음» 알림만).
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from './config.js';
import { openDb, type DB } from './db.js';
import { ANON_ACTOR, ApiError, Store, type NoticeEvent, type Principal } from './store.js';

const COOKIE = 'bs_session';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/src/app.js → <root>/public
const PUBLIC_DIR = path.resolve(here, '..', '..', 'public');

const STATIC: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/runs.js': 'runs.js',
  '/admin.js': 'admin.js',
  '/claims.js': 'claims.js',
  '/face.js': 'face.js',
  '/style.css': 'style.css',
  '/manifest.webmanifest': 'manifest.webmanifest',
  '/sw.js': 'sw.js',
  '/icon.svg': 'icon.svg',
};
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
};

export interface App {
  fastify: FastifyInstance;
  store: Store;
  db: DB;
  cfg: Config;
  /** 설정된 모든 주소에 바인드 */
  listen(): Promise<string[]>;
  close(): Promise<void>;
}

export async function buildApp(cfg: Config, opts: { logger?: boolean } = {}): Promise<App> {
  const db = openDb(cfg.dbPath);
  const store = new Store(db, cfg);

  // 한 Fastify 핸들러를 여러 http.Server 에 건다 (127.0.0.1 + LAN 주소 등)
  let handler: http.RequestListener | null = null;
  const fastify = Fastify({
    logger: opts.logger === false ? false : { level: cfg.logLevel },
    bodyLimit: cfg.httpBodyLimit,
    trustProxy: false,
    serverFactory: (h) => {
      handler = h;
      return http.createServer(h);
    },
  });
  await fastify.register(cookie);

  // 첨부 업로드는 바이트 그대로
  fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: cfg.attachmentMaxBytes }, (_req, body, done) =>
    done(null, body),
  );

  const wsOrigins = cfg.origins.map((o) => o.replace(/^http/, 'ws'));
  fastify.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (reply.getHeader('X-Inline-CSP')) {
      // 첨부 그림 미리보기 — 페이지 정책 대신 아무것도 못 하는 sandbox
      reply.removeHeader('X-Inline-CSP');
      reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
      return payload;
    }
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' ${wsOrigins.join(' ')}; ` +
        `object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
    return payload;
  });

  fastify.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code, message: err.message, ...err.extra });
    if (err.statusCode === 413 || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: 'too_large' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    fastify.log.error({ err: { message: err.message, stack: err.stack } }, 'internal error');
    return reply.code(500).send({ error: 'internal' });
  });

  function isSecure(req: FastifyRequest) {
    if (cfg.secureCookie === 'always') return true;
    if (cfg.secureCookie === 'never') return false;
    return req.protocol === 'https';
  }

  function authenticate(req: FastifyRequest): Principal | null {
    const h = req.headers.authorization;
    if (h) {
      const m = /^Bearer\s+(\S+)$/i.exec(h);
      // 거절(폐기·만료·모르는 토큰)은 authenticateToken 이 감사에 남긴다
      return store.authenticateToken(m ? m[1] : '', 'rest');
    }
    const c = req.cookies[COOKIE];
    return c ? store.resolveWebSession(c) : null;
  }

  /** 쿠키 인증의 상태 변경 요청은 Origin 이 허용 목록이어야 한다 (CSRF 이중 방어) */
  function checkOrigin(req: FastifyRequest) {
    const o = req.headers.origin;
    if (!o || !cfg.origins.includes(o)) throw new ApiError(403, 'bad_origin');
  }

  const auth = async (req: FastifyRequest) => {
    const p = authenticate(req);
    if (!p) throw new ApiError(401, 'unauthenticated');
    if (p.via === 'cookie' && req.method !== 'GET' && req.method !== 'HEAD') checkOrigin(req);
    req.principal = p;
  };

  // ── 정적 파일 (고정 목록만) ──
  const staticCache = new Map<string, Buffer>();
  for (const [route, file] of Object.entries(STATIC)) {
    fastify.get(route, async (_req, reply) => {
      let buf = staticCache.get(file);
      if (!buf) {
        buf = fs.readFileSync(path.join(PUBLIC_DIR, file));
        staticCache.set(file, buf);
      }
      reply.header('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
      reply.header('Cache-Control', file === 'sw.js' || file === 'index.html' ? 'no-cache' : 'max-age=300');
      return reply.send(buf);
    });
  }

  fastify.get('/healthz', async () => {
    db.prepare('SELECT 1').get();
    return { ok: true, schema: db.pragma('user_version', { simple: true }), server_seq: store.serverSeq() };
  });

  // ── 인증 ──
  const failures = new Map<string, { n: number; until: number }>();
  fastify.post('/api/auth/login', async (req, reply) => {
    checkOrigin(req);
    const ip = req.ip;
    const f = failures.get(ip);
    // 로그인 거절은 감사에 남긴다(작업자 anonymous · 묶음). 패스프레이즈는 어디에도 안 남는다
    const loginDenied = (reason: string) =>
      store.audit({ actor: ANON_ACTOR, action: 'auth.login', target_type: 'participant', target_id: store.getMaster()?.id ?? null, result: 'denied', reason, after: { ip }, group: true });
    if (f && f.n >= 10 && f.until > Date.now()) {
      loginDenied('too_many_attempts');
      throw new ApiError(429, 'too_many_attempts');
    }
    const body = (req.body ?? {}) as { passphrase?: unknown };
    const res = typeof body.passphrase === 'string' ? store.login(body.passphrase) : null;
    if (!res) {
      const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + 10 * 60_000 };
      cur.n++;
      failures.set(ip, cur);
      loginDenied('bad_passphrase');
      throw new ApiError(401, 'bad_passphrase');
    }
    failures.delete(ip);
    store.audit({ actor: { id: res.participant.id, kind: 'master' }, action: 'auth.login', target_type: 'participant', target_id: res.participant.id, result: 'ok', after: { ip } });
    reply.setCookie(COOKIE, res.sessionToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: isSecure(req),
      path: '/',
      expires: new Date(res.expiresAt),
    });
    return { participant: res.participant };
  });

  fastify.post('/api/auth/logout', async (req, reply) => {
    const c = req.cookies[COOKIE];
    if (c) {
      checkOrigin(req);
      store.logout(c);
    }
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  fastify.get('/api/me', { preHandler: auth }, async (req) => ({ participant: req.principal!.participant, via: req.principal!.via, on_call_only: cfg.onCallOnly }));
  fastify.get('/api/participants', { preHandler: auth }, async () => ({ participants: store.listParticipants(true) }));
  // 에이전트 연결 상태(마스터만) — 이름·마지막 접속·토큰 개수만. 토큰 값·해시는 내지 않는다
  fastify.get('/api/agents', { preHandler: auth }, async (req) => ({ agents: store.listAgents(req.principal!) }));
  // ── 에이전트 연결(기획서 2.1 → «에이전트 연결 상태», 마스터 결정 1·2) · 감사 기록(정책 9) ──
  // 토큰 발급은 화면에 없다(CT 안 CLI → 600 파일). 화면은 조회·폐기만
  fastify.get('/api/connections', { preHandler: auth }, async (req) => store.listConnections(req.principal!));
  fastify.post<{ Params: { id: string } }>('/api/credentials/:id/revoke', { preHandler: auth }, async (req) =>
    store.revokeCredential(req.principal!, req.params.id),
  );
  fastify.get<{ Querystring: Record<string, string> }>('/api/audit', { preHandler: auth }, async (req) => store.listAudit(req.principal!, req.query));

  // ── 스레드 · 메시지 ──
  type P = { Params: { id: string; seq?: string } };
  fastify.get('/api/threads', { preHandler: auth }, async (req) => ({ threads: store.listThreads(req.principal!) }));
  fastify.post('/api/threads', { preHandler: auth }, async (req, reply) => {
    const r = store.createThread(req.principal!, (req.body ?? {}) as any);
    return reply.code(r.duplicate ? 200 : 201).send(r);
  });
  fastify.get<P>('/api/threads/:id', { preHandler: auth }, async (req) => store.getThread(req.principal!, req.params.id));
  fastify.post<P>('/api/threads/:id/members', { preHandler: auth }, async (req) =>
    store.setMember(req.principal!, req.params.id, (req.body ?? {}) as any),
  );
  fastify.post<P>('/api/threads/:id/fork', { preHandler: auth }, async (req, reply) => {
    const r = store.forkThread(req.principal!, req.params.id, (req.body ?? {}) as any);
    return reply.code(r.duplicate ? 200 : 201).send(r);
  });
  fastify.post<P>('/api/threads/:id/merge', { preHandler: auth }, async (req, reply) => reply.code(201).send(store.mergeThread(req.principal!, req.params.id)));
  fastify.get<P & { Querystring: { after?: string; limit?: string } }>('/api/threads/:id/messages', { preHandler: auth }, async (req) =>
    store.listMessages(req.principal!, req.params.id, Number(req.query.after ?? 0) || 0, Number(req.query.limit ?? 200) || 200),
  );
  fastify.get<P>('/api/threads/:id/context', { preHandler: auth }, async (req) => ({
    messages: store.getContext(req.principal!, req.params.id),
  }));
  fastify.post<P>('/api/threads/:id/messages', { preHandler: auth }, async (req, reply) => {
    const r = store.postMessage(req.principal!, req.params.id, (req.body ?? {}) as any);
    return reply.code(r.duplicate ? 200 : 201).send(r);
  });
  // 끌어오기(마스터만) — 에이전트 끝줄 «← …»로 청한 맥락을 그 에이전트에게. 새 메시지 없이 배달 하나(원문 사본)
  const seqOf = (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new ApiError(400, 'bad_request', 'seq');
    return n;
  };
  fastify.get<{ Params: { id: string; seq: string } }>('/api/threads/:id/messages/:seq/pull', { preHandler: auth }, async (req) =>
    store.pullPreview(req.principal!, req.params.id, seqOf(req.params.seq)),
  );
  fastify.post<{ Params: { id: string; seq: string } }>('/api/threads/:id/messages/:seq/pull', { preHandler: auth }, async (req) =>
    store.pullContext(req.principal!, req.params.id, seqOf(req.params.seq)),
  );
  // 수동 전달(마스터만) — 에이전트 글을 다른 에이전트 한 명에게. 새 메시지 없이 배달 하나
  fastify.post<{ Params: { id: string; seq: string }; Body: { recipient?: unknown; note?: unknown } }>('/api/threads/:id/messages/:seq/forward', { preHandler: auth }, async (req) => {
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq < 1) throw new ApiError(400, 'bad_request', 'seq');
    return store.forwardMessage(req.principal!, req.params.id, seq, (req.body ?? {}) as any);
  });
  // 요청 창구(마스터 #352): 보류된 요청 목록·확인 · 허용 짝 조회(바꾸기는 CLI)
  fastify.get<P>('/api/threads/:id/request-holds', { preHandler: auth }, async (req) => ({ holds: store.listRequestHolds(req.principal!, req.params.id) }));
  fastify.post<{ Params: { id: string } }>('/api/request-holds/:id/ack', { preHandler: auth }, async (req) => store.ackRequestHold(req.principal!, req.params.id));
  fastify.get('/api/request-pairs', { preHandler: auth }, async () => ({ pairs: store.listRequestPairs(), chain_max: cfg.requestChainMax }));
  // 대면 모드(마스터 #581): 켜고 끄기·결정·판정·멈추기·다시 돌리기는 마스터만 · 보기는 멤버
  fastify.post<P & { Body: { mode?: unknown } }>('/api/threads/:id/mode', { preHandler: auth }, async (req) =>
    store.setThreadMode(req.principal!, req.params.id, (req.body ?? {}).mode),
  );
  fastify.get<P & { Querystring: { round?: string } }>('/api/threads/:id/face', { preHandler: auth }, async (req) =>
    store.getFace(req.principal!, req.params.id, req.query.round || undefined),
  );
  fastify.post<{ Params: { id: string; iid: string } }>('/api/face/:id/issues/:iid/decide', { preHandler: auth }, async (req) =>
    store.decideIssue(req.principal!, req.params.id, req.params.iid, (req.body ?? {}) as any),
  );
  fastify.post<{ Params: { id: string } }>('/api/face/:id/verdict', { preHandler: auth }, async (req) => store.faceVerdict(req.principal!, req.params.id, (req.body ?? {}) as any));
  fastify.post<{ Params: { id: string } }>('/api/face/:id/stop', { preHandler: auth }, async (req) => store.faceStop(req.principal!, req.params.id));
  fastify.post<{ Params: { id: string } }>('/api/face/:id/retry', { preHandler: auth }, async (req) => store.faceRetry(req.principal!, req.params.id));
  fastify.get<P>('/api/threads/:id/runs', { preHandler: auth }, async (req) => ({ runs: store.listRuns(req.principal!, req.params.id) }));
  fastify.get<P>('/api/threads/:id/deliveries', { preHandler: auth }, async (req) => ({
    deliveries: store.listDeliveries(req.principal!, req.params.id),
  }));
  fastify.post<P>('/api/threads/:id/stop', { preHandler: auth }, async (req) =>
    store.stopThread(req.principal!, req.params.id, ((req.body ?? {}) as any).mode),
  );
  fastify.post<P>('/api/threads/:id/resume', { preHandler: auth }, async (req) => store.resumeThread(req.principal!, req.params.id));
  // 스레드 정리(마스터만): 보관·숨김·휴지통과 되돌리기 — 아래 분기까지 묶어 걸린다
  fastify.post<P & { Body: { action?: unknown } }>('/api/threads/:id/state', { preHandler: auth }, async (req) =>
    store.setThreadState(req.principal!, req.params.id, (req.body ?? {}).action),
  );
  // 이름 바꾸기(마스터만)
  fastify.post<P & { Body: { title?: unknown } }>('/api/threads/:id/rename', { preHandler: auth }, async (req) =>
    store.renameThread(req.principal!, req.params.id, (req.body ?? {}).title),
  );
  // 영구 삭제(마스터만): 휴지통 + 아래 분기도 휴지통 + confirm = 제목
  fastify.post<P & { Body: { confirm?: unknown } }>('/api/threads/:id/purge', { preHandler: auth }, async (req) =>
    store.purgeThread(req.principal!, req.params.id, (req.body ?? {}).confirm),
  );
  fastify.post<P>('/api/threads/:id/sessions/rotate', { preHandler: auth }, async (req) => ({
    session: store.rotateSession(req.principal!, req.params.id, (req.body ?? {}) as any),
  }));
  // ── 실행 목록·상세·취소 (정책 1: 요청 → 어댑터 확인 / 무응답 제한 → unknown) ──
  fastify.get<{ Querystring: { state?: string; agent?: string; thread?: string; since?: string; limit?: string } }>(
    '/api/runs',
    { preHandler: auth },
    async (req) => store.listRunsAll(req.principal!, req.query),
  );
  fastify.get<{ Params: { id: string } }>('/api/runs/:id', { preHandler: auth }, async (req) => store.getRunDetail(req.principal!, req.params.id));
  fastify.post<{ Params: { id: string } }>('/api/runs/:id/refresh', { preHandler: auth }, async (req) =>
    store.refreshRun(req.principal!, req.params.id),
  );
  fastify.post<{ Params: { id: string } }>('/api/runs/:id/cancel', { preHandler: auth }, async (req) =>
    store.cancelRun(req.principal!, req.params.id),
  );
  fastify.post<{ Params: { id: string } }>('/api/deliveries/:id/cancel', { preHandler: auth }, async (req) =>
    store.cancelDelivery(req.principal!, req.params.id),
  );

  // ── 위임 대장(마이그레이션 12): 백구 → 백수 일감과 만질 범위 선점. 권한은 Store.delegationGate 한곳 · 겹침은 409 claim_conflict ──
  type D = { Params: { id: string } };
  fastify.get<{ Querystring: { active?: string; recent?: string } }>('/api/delegations', { preHandler: auth }, async (req) => store.listDelegations(req.principal!, req.query));
  fastify.post('/api/delegations', { preHandler: auth }, async (req, reply) =>
    reply.code(201).send(store.createDelegation(req.principal!, (req.body ?? {}) as any)),
  );
  fastify.get<D>('/api/delegations/:id', { preHandler: auth }, async (req) => store.getDelegation(req.principal!, req.params.id));
  fastify.post<D & { Body: { claims?: unknown } }>('/api/delegations/:id/claims', { preHandler: auth }, async (req) =>
    store.addClaims(req.principal!, req.params.id, (req.body ?? {}).claims),
  );
  fastify.post<D & { Body: { status?: unknown; result?: unknown } }>('/api/delegations/:id/status', { preHandler: auth }, async (req) =>
    store.setDelegationStatus(req.principal!, req.params.id, (req.body ?? {}).status, (req.body ?? {}).result),
  );
  fastify.post<D>('/api/delegations/:id/heartbeat', { preHandler: auth }, async (req) => store.delegationHeartbeat(req.principal!, req.params.id));
  fastify.post<D>('/api/delegations/:id/release', { preHandler: auth }, async (req) => store.releaseStale(req.principal!, req.params.id));
  // 대기 위임 진입(마이그레이션 13) — 마스터·만든 이가 «먼저 해도 된다»고 판정할 때만. 아직 겹치면 409 claim_conflict
  fastify.post<D>('/api/delegations/:id/admit', { preHandler: auth }, async (req) => store.admitDelegation(req.principal!, req.params.id));

  // ── 첨부 ──
  fastify.post<P & { Querystring: { name?: string } }>(
    '/api/threads/:id/messages/:seq/attachments',
    { preHandler: auth, bodyLimit: cfg.attachmentMaxBytes },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) throw new ApiError(415, 'octet_stream_required');
      const a = store.addAttachment(req.principal!, req.params.id, Number(req.params.seq), String(req.query.name ?? 'file'), req.body);
      return reply.code(201).send({ attachment: a });
    },
  );
  // 먼저 올리고(업로드) 메시지를 쓸 때 attachments: [id…] 로 묶는다
  fastify.post<{ Querystring: { name?: string } }>('/api/uploads', { preHandler: auth, bodyLimit: cfg.attachmentMaxBytes }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) throw new ApiError(415, 'octet_stream_required');
    return reply.code(201).send({ upload: store.addUpload(req.principal!, String(req.query.name ?? 'file'), req.body) });
  });
  fastify.delete<{ Params: { id: string } }>('/api/uploads/:id', { preHandler: auth }, async (req) => store.deleteUpload(req.principal!, req.params.id));
  fastify.get<{ Params: { id: string }; Querystring: { inline?: string } }>('/api/attachments/:id', { preHandler: auth }, async (req, reply) => {
    const a = store.getAttachment(req.principal!, req.params.id);
    if (req.query.inline === '1' && a.kind === 'image') {
      // 미리보기: 서버가 내용으로 확인한 래스터 그림만(PNG·JPEG·GIF·WebP) 제 형식으로. 문서로 열려도 아무것도 못 하게 sandbox
      reply.header('Content-Type', a.mime);
      reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.name)}`);
      reply.header('Cache-Control', 'private, max-age=86400');
      reply.header('X-Inline-CSP', '1');
      return reply.send(fs.createReadStream(a.fullPath));
    }
    // 그 밖은 브라우저가 실행하지 못하게: 항상 내려받기 + 일반 바이트
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`);
    return reply.send(fs.createReadStream(a.fullPath));
  });

  // ── 어댑터 ──
  fastify.post('/api/adapter/claim', { preHandler: auth }, async (req) => ({
    claim: store.claim(req.principal!, (req.body ?? {}) as any),
  }));
  fastify.post<{ Params: { id: string } }>('/api/adapter/deliveries/:id/ack', { preHandler: auth }, async (req) =>
    store.ackDelivery(req.principal!, req.params.id, (req.body ?? {}) as any),
  );
  fastify.post<{ Params: { id: string } }>('/api/adapter/runs/:id/start', { preHandler: auth }, async (req) =>
    store.startRun(req.principal!, req.params.id, (req.body ?? {}) as any),
  );
  fastify.post<{ Params: { id: string } }>('/api/adapter/runs/:id/heartbeat', { preHandler: auth }, async (req) =>
    store.heartbeat(req.principal!, req.params.id, (req.body ?? {}) as any),
  );
  fastify.post<{ Params: { id: string } }>('/api/adapter/runs/:id/complete', { preHandler: auth }, async (req) =>
    store.completeRun(req.principal!, req.params.id, (req.body ?? {}) as any),
  );
  fastify.post<{ Params: { id: string } }>('/api/adapter/runs/:id/fail', { preHandler: auth }, async (req) =>
    store.failRun(req.principal!, req.params.id, (req.body ?? {}) as any),
  );
  // 어댑터의 중단 확인 — heartbeat 가 cancel 을 준 뒤 실행을 멈췄으면 부른다
  fastify.post<{ Params: { id: string } }>('/api/adapter/runs/:id/cancelled', { preHandler: auth }, async (req) =>
    store.ackCancel(req.principal!, req.params.id, (req.body ?? {}) as any),
  );

  // ── WebSocket: 알림만 ──
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  interface Conn {
    ws: WebSocket;
    principal: Principal;
    cookieToken?: string;
  }
  const conns = new Set<Conn>();

  store.events.on('notice', (e: NoticeEvent) => {
    const data = JSON.stringify(e.notice);
    for (const c of conns) {
      const pid = c.principal.participant.id;
      if (e.only && e.only !== pid) continue;
      // read_all(사서 토큰)은 멤버가 아니어도 알림을 받는다 — baalda 실시간 사본(마스터 #289·#291)
      if (e.threadId !== null && !store.canRead(pid, e.threadId) && !(store.readAll(c.principal) && !e.only)) continue;
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
    }
  });

  function handleUpgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/ws') return reject(404, 'Not Found');
      const origin = req.headers.origin;
      let principal: Principal | null = null;
      let cookieToken: string | undefined;
      const authz = req.headers.authorization;
      if (authz) {
        const m = /^Bearer\s+(\S+)$/i.exec(authz);
        principal = store.authenticateToken(m ? m[1] : '', 'ws');
        // 토큰 연결도 Origin 을 보냈다면 허용 목록이어야 한다
        if (origin && !cfg.origins.includes(origin)) return reject(403, 'Forbidden');
      } else {
        // 브라우저(쿠키) 연결은 Origin 필수
        if (!origin || !cfg.origins.includes(origin)) return reject(403, 'Forbidden');
        const cookies = fastify.parseCookie(req.headers.cookie ?? '');
        cookieToken = cookies[COOKIE];
        principal = cookieToken ? store.resolveWebSession(cookieToken) : null;
      }
      if (!principal) return reject(401, 'Unauthorized');
      const p = principal;
      wss.handleUpgrade(req, socket, head, (ws) => {
        const conn: Conn = { ws, principal: p, cookieToken };
        conns.add(conn);
        ws.on('close', () => conns.delete(conn));
        ws.on('error', () => conns.delete(conn));
        ws.on('message', (raw) => {
          // 클라이언트 → 서버는 ping 만 받는다
          if (raw.toString() === '{"t":"ping"}') ws.send('{"t":"pong"}');
        });
        ws.send(JSON.stringify({ t: 'hello', participant: p.participant.id, server_seq: store.serverSeq() }));
      });
    } catch {
      reject(400, 'Bad Request');
    }
  }

  // 폐기·만료된 자격 증명을 쥔 연결은 끊는다
  const revalidate = setInterval(() => {
    for (const c of conns) {
      const ok = c.principal.via === 'token' ? store.credentialStillValid(c.principal.credentialId!) : store.webSessionStillValid(c.cookieToken!);
      if (!ok) c.ws.close(4401, 'credential revoked');
    }
  }, cfg.wsRevalidateMs);
  const sweeper = setInterval(() => {
    try {
      store.sweep();
    } catch (err) {
      fastify.log.error({ err: (err as Error).message }, 'sweep failed');
    }
  }, cfg.sweepIntervalMs);
  revalidate.unref();
  sweeper.unref();

  await fastify.ready();
  const servers: http.Server[] = [fastify.server];
  fastify.server.on('upgrade', handleUpgrade);

  return {
    fastify,
    store,
    db,
    cfg,
    async listen() {
      const addrs: string[] = [];
      for (let i = 0; i < cfg.listen.length; i++) {
        const { host, port } = cfg.listen[i];
        let srv: http.Server;
        if (i === 0) srv = fastify.server;
        else {
          srv = http.createServer(handler!);
          srv.on('upgrade', handleUpgrade);
          servers.push(srv);
        }
        await new Promise<void>((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(port, host, () => {
            srv.off('error', reject);
            resolve();
          });
        });
        const a = srv.address() as import('node:net').AddressInfo;
        addrs.push(`http://${a.address}:${a.port}`);
      }
      return addrs;
    },
    async close() {
      clearInterval(revalidate);
      clearInterval(sweeper);
      for (const c of conns) c.ws.terminate();
      // fastify.listen() 을 안 거쳤으므로 서버는 우리가 닫는다
      for (const s of servers) {
        if (!s.listening) continue;
        const done = new Promise((r) => s.close(() => r(null)));
        s.closeAllConnections();
        await done;
      }
      await fastify.close();
      db.close();
    },
  };
}

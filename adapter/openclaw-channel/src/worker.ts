// brainStorm 쪽 작업자 — 전달을 받아(claim) 한 턴을 돌리고 답을 올린다. 동시에 concurrency 개(기본 1).
//   같은 스레드는 서버가 직렬로 준다(claim 이 그 스레드에 queued/running 실행이 있으면 다음 전달을 안 낸다) —
//   그래서 칸을 늘리면 «다른 스레드는 병렬, 같은 스레드는 순서대로»가 된다(마스터 #460).
// 실제 에이전트 실행은 주입받는다(runTurn): OpenClaw 에서는 runEmbeddedAgent, 시험에서는 가짜.
//
// 규칙
//   - claim 직후 ACK: ACK 된 전달은 다시 나가지 않는다. 그 뒤 죽으면 run lease 가 지나 서버가 `unknown` 으로 둔다.
//   - run_token 이 없거나(중복) 상태가 queued 가 아니면 절대 돌리지 않는다 — 재실행 금지.
//   - heartbeat 가 cancel 을 주면 턴을 abort 하고, 멈췄으면 서버에 «중단 확인»(POST …/cancelled)을 보낸다.
//     확인이 없으면 서버는 무응답 제한(기본 30초) 뒤 run 을 unknown 으로 둔다. 확인 전에 턴이 이미 답을 냈으면
//     그 답을 올린다(«완료 우선 확정» — 서버가 succeeded 로 받는다). 확인 뒤의 늦은 답은 서버가 거절한다.
//   - 토큰·본문은 로그에 남기지 않는다(식별자만).
import type { AttachmentInfo, ClaimCarry, ClaimFace, ClaimForward, ClaimHoldNotice, ClaimPulled, ClaimSession, Message, Participant, Run } from '../../../src/protocol.js';
import { buildPrompt, describeActualModel, redact, selectNewContext, sessionKeyFor, stripAnswerStamp } from './mapping.js';

export interface TurnRequest {
  sessionKey: string;
  ocAgentId: string;
  runId: string;
  prompt: string;
  signal: AbortSignal;
  /** 원인 메시지 작성자 — 에이전트 실행 맥락에 넘긴다 */
  sender: { id: string; name: string; isMaster: boolean };
  threadTitle: string;
  /** 이번 턴에 넘기는 메시지들의 첨부(프롬프트에는 목록만 있다). 실행기가 파일이 필요하면 fetchAttachment 로 받는다 */
  attachments?: TurnAttachment[];
  fetchAttachment?: (id: string, signal?: AbortSignal) => Promise<Buffer>;
  /** 경과 한 줄 — 다음 heartbeat 에 실려 화면에 «최근: …»으로 보인다(실행기가 아는 만큼만) */
  onProgress?: (note: string) => void;
  /** 이번 턴에 넘기는 글의 본문(제목 포함) — 실행기가 태그 등을 읽을 때 쓴다(프롬프트 틀 글은 빠진다) */
  texts?: string[];
}

export type TurnAttachment = AttachmentInfo & { seq: number };

export interface TurnResult {
  text: string;
  aborted?: boolean;
  /** OpenClaw 실행 메타에서 읽은 실제 값 */
  meta?: { provider?: string; model?: string; agentHarnessId?: string; sessionId?: string };
  durationMs?: number;
  usage?: unknown;
  /** 런타임이 알려 준 그 밖의 사실(실행기·대체 여부·인증 방식) — run.usage.openclaw 에 그대로 싣는다 */
  extra?: Record<string, unknown>;
}

export type RunTurn = (req: TurnRequest) => Promise<TurnResult>;

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface WorkerOptions {
  url: string;
  token: string;
  worker: string;
  ocAgentId: string;
  configVersion: string;
  runTurn: RunTurn;
  /** 런타임 이름 — start·fail·usage 칸에 쓴다(기본 'openclaw'). 다른 런타임(예: claude-cli)도 이 작업자를 쓴다 */
  runtime?: string;
  /** 실행 메타 → 실제 런타임·모델 문자열(기본 describeActualModel — OpenClaw 메타 해석) */
  describeModel?: (meta: TurnResult['meta']) => { runtime: string | null; model: string | null };
  log: Logger;
  pollMs?: number;
  /** 동시에 도는 턴 수(칸). 기본 1 — 칸마다 따로 claim 한다 */
  concurrency?: number;
  heartbeatMs?: number;
  /** 시험용: 턴이 끝난 뒤(LLM 호출 뒤) 답을 올리기 전에 부른다 */
  beforeComplete?: (runId: string) => Promise<void> | void;
  fetchImpl?: typeof fetch;
}

interface Claim {
  delivery: { id: string; lease_token: string };
  run: Run & { run_token: string | null };
  duplicate: boolean;
  thread: { id: string; title: string };
  session: ClaimSession;
  trigger: Message;
  context: Message[];
  /** 수동 전달 실행이면 있다(옛 서버는 안 보낸다) */
  forward?: ClaimForward | null;
  /** 끌어온 맥락(배달 속성 · 이 턴에만) — 옛 서버는 안 보낸다 */
  pulled?: ClaimPulled | null;
  /** 새 세대의 첫 실행에만 — 이전 세대에서 이어받은 맥락(옛 서버는 안 보낸다) */
  carry?: ClaimCarry | null;
  /** 네 요청이 보류됐다는 알림(그 스레드에서 처음 불리는 실행 한 번만) — 옛 서버는 안 보낸다 */
  hold_notices?: ClaimHoldNotice[] | null;
  face?: ClaimFace | null;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`HTTP ${status}${code ? ` ${code}` : ''}`);
  }
}

export class BrainstormClient {
  private readonly f: typeof fetch;
  constructor(
    private readonly url: string,
    private readonly token: string,
    fetchImpl?: typeof fetch,
  ) {
    this.f = fetchImpl ?? fetch;
  }

  async call<T = any>(method: string, p: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.f(this.url.replace(/\/$/, '') + p, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) throw new HttpError(res.status, json?.error);
    return json as T;
  }

  /** 첨부 원본 바이트 */
  async download(attachmentId: string, signal?: AbortSignal): Promise<Buffer> {
    const res = await this.f(`${this.url.replace(/\/$/, '')}/api/attachments/${encodeURIComponent(attachmentId)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal,
    });
    if (!res.ok) throw new HttpError(res.status, undefined);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * 중단 확인. 'acked' = 서버가 cancelled 로 확정 · 'unsupported' = 옛 서버(라우트 없음 — 옛 서버는 취소를 이미 확정했다) ·
   * 'rejected' = 서버가 이미 다른 최종 상태로 확정(무응답 unknown 등) — 서버는 이벤트로만 남긴다
   */
  async ackCancel(runId: string, runToken: string): Promise<'acked' | 'unsupported' | 'rejected'> {
    try {
      await this.call('POST', `/api/adapter/runs/${runId}/cancelled`, { run_token: runToken });
      return 'acked';
    } catch (e) {
      // 옛 서버: 라우트가 없어 Fastify 기본 404(error 'Not Found'). 우리 404 는 'no_run'
      if (e instanceof HttpError && e.status === 404 && e.code !== 'no_run') return 'unsupported';
      if (e instanceof HttpError) return 'rejected';
      throw e;
    }
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

export type HandleOutcome = 'idle' | 'skipped' | 'succeeded' | 'failed' | 'cancelled' | 'lost';

export class BrainstormWorker {
  readonly client: BrainstormClient;
  private participants = new Map<string, Participant>();
  private me: Participant | null = null;
  private busy = 0;

  constructor(private readonly o: WorkerOptions) {
    this.client = new BrainstormClient(o.url, o.token, o.fetchImpl);
  }

  private get rt(): string {
    return this.o.runtime ?? 'openclaw';
  }

  /** 턴을 멈춘 뒤 서버에 중단 확인을 보낸다 */
  private async confirmCancel(runId: string, runToken: string) {
    const r = await this.client.ackCancel(runId, runToken).catch((e) => `error ${redact((e as Error).message)}`);
    this.o.log.info(`brainstorm: 중단 확인 run=${runId} → ${r}`);
  }

  /** 신원 확인 — 토큰이 가리키는 brainStorm 참여자 */
  async whoami(): Promise<Participant> {
    const r = await this.client.call<{ participant: Participant }>('GET', '/api/me');
    this.me = r.participant;
    return r.participant;
  }

  private async refreshParticipants() {
    const r = await this.client.call<{ participants: Participant[] }>('GET', '/api/participants');
    this.participants = new Map(r.participants.map((p) => [p.id, p]));
  }

  /** 멈출 때까지: 칸마다 전달이 있으면 하나씩, 없으면 pollMs 쉬었다 다시. 인증이 거절되면 모든 칸이 멈춘다 */
  async loop(signal: AbortSignal): Promise<void> {
    const n = Math.max(1, Math.floor(this.o.concurrency ?? 1));
    const halt = new AbortController();
    const all = AbortSignal.any([signal, halt.signal]);
    await Promise.all(Array.from({ length: n }, (_, i) => this.lane(all, signal, halt, i)));
  }

  private async lane(signal: AbortSignal, outer: AbortSignal, halt: AbortController, i: number): Promise<void> {
    const poll = this.o.pollMs ?? 3000;
    let backoff = poll;
    if (i > 0) await sleep(Math.round((poll * i) / Math.max(1, this.o.concurrency ?? 1)), signal); // 칸끼리 claim 시각을 어긋나게
    while (!signal.aborted) {
      try {
        if (!this.me) await this.whoami();
        const r = await this.handleOne(outer);
        backoff = poll;
        if (r === 'idle') await sleep(poll, signal);
      } catch (e) {
        if (e instanceof HttpError && (e.status === 401 || e.status === 403) && !this.busy) {
          this.o.log.error(`brainstorm: 인증 거절(${e.status}) — 토큰을 확인하라. 멈춘다`);
          halt.abort();
          return;
        }
        this.o.log.warn(`brainstorm: ${redact((e as Error).message)} — ${Math.round(backoff / 1000)}초 뒤 다시`);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** 전달 하나를 처리한다. 결과 종류를 돌려준다(시험이 본다) */
  async handleOne(stop?: AbortSignal): Promise<HandleOutcome> {
    const c = await this.client.call<{ claim: Claim | null }>('POST', '/api/adapter/claim', { worker: this.o.worker });
    const claim = c.claim;
    if (!claim) return 'idle';
    const runId = claim.run.id;
    this.o.log.info(`brainstorm: claim delivery=${claim.delivery.id} run=${runId} state=${claim.run.state} dup=${claim.duplicate}`);

    // ACK 먼저: 이 뒤로는 이 전달이 다시 나가지 않는다 (죽으면 run 이 unknown 으로 남는다)
    try {
      await this.client.call('POST', `/api/adapter/deliveries/${claim.delivery.id}/ack`, { lease_token: claim.delivery.lease_token });
    } catch (e) {
      this.o.log.warn(`brainstorm: ack 실패 ${redact((e as Error).message)}`);
    }
    // 중복 전달·이미 끝난 실행·unknown 은 돌리지 않는다
    if (!claim.run.run_token || claim.run.state !== 'queued') {
      this.o.log.info(`brainstorm: skip run=${runId} state=${claim.run.state} (다시 돌리지 않는다)`);
      return 'skipped';
    }
    const runToken = claim.run.run_token;
    const me = this.me ?? (await this.whoami());
    const sessionKey = sessionKeyFor(this.o.ocAgentId, me.id, claim.thread.id, claim.session.generation);

    try {
      await this.client.call('POST', `/api/adapter/runs/${runId}/start`, {
        run_token: runToken,
        runtime: this.rt, // 실제 하네스·모델은 실행 뒤 메타로 complete 에 싣는다
        config_version: this.o.configVersion,
      });
    } catch (e) {
      this.o.log.warn(`brainstorm: start 거절 run=${runId} ${redact((e as Error).message)}`);
      return 'lost';
    }

    this.busy++;
    const ac = new AbortController();
    const onStop = () => ac.abort(new Error('adapter stopping'));
    stop?.addEventListener('abort', onStop, { once: true });
    let cancelled = false;
    let lost = false;
    // 읽음: 시작 즉시 기계적 반응을 한 번 보낸다 — 턴이 길어도 화면은 «반응 없음»이 아니다. 그 뒤 경과는 실행기가 바꾼다
    let progress = '읽었음 — 작업 시작';
    let sent = '';
    const beat = () => {
      const note = progress !== sent ? progress : undefined;
      return this.client
        .call<{ cancel?: boolean }>('POST', `/api/adapter/runs/${runId}/heartbeat`, { run_token: runToken, ...(note ? { progress: note } : {}) })
        .then((r) => {
          if (note) sent = note; // 실패한 경과는 다음 박동에 다시 보낸다
          return r;
        });
    };
    const hbEvery = this.o.heartbeatMs ?? 5_000;
    const onBeat = (p: Promise<{ cancel?: boolean }>) =>
      p
        .then((r) => {
          if (r?.cancel && !cancelled) {
            cancelled = true;
            this.o.log.info(`brainstorm: 취소 요청 run=${runId} — 턴을 멈춘다`);
            ac.abort(new Error('cancelled by brainStorm'));
          }
        })
        .catch((e) => {
          if (e instanceof HttpError && e.status === 409) {
            // 서버가 이 실행을 더는 우리 것으로 안 본다(취소·세대 교체·unknown) — 멈춘다
            lost = true;
            ac.abort(new Error('run no longer owned'));
          }
        });
    void onBeat(beat());
    const hb = setInterval(() => void onBeat(beat()), hbEvery);

    try {
      if (!this.participants.has(claim.trigger.author_id)) await this.refreshParticipants().catch(() => {});
      const upto = (claim.forward?.context_upto_seq ?? claim.pulled?.context_upto_seq) ?? claim.trigger.seq;
      const newMessages = selectNewContext(claim.context, claim.session, claim.trigger.seq, upto);
      if (!newMessages.some((m) => m.seq === claim.trigger.seq)) {
        newMessages.push(claim.trigger);
        newMessages.sort((a, b) => a.seq - b.seq);
      }
      const prompt = buildPrompt({
        threadTitle: claim.thread.title,
        generation: claim.session.generation,
        newMessages,
        triggerSeq: claim.trigger.seq,
        participants: this.participants,
        selfId: me.id,
        forwarded: !!claim.forward,
        pulled: claim.pulled ?? null,
        carry: claim.carry ?? null,
        holdNotices: claim.hold_notices ?? null,
        face: claim.face ?? null,
      });
      const author = this.participants.get(claim.trigger.author_id);
      const started = Date.now();
      let result: TurnResult;
      try {
        result = await this.o.runTurn({
          sessionKey,
          ocAgentId: this.o.ocAgentId,
          runId,
          prompt,
          signal: ac.signal,
          sender: { id: claim.trigger.author_id, name: author?.name ?? claim.trigger.author_id, isMaster: !!author?.is_master },
          threadTitle: claim.thread.title,
          texts: [claim.thread.title, ...newMessages.map((m) => m.body ?? '')],
          attachments: newMessages.flatMap((m) => (m.attachments ?? []).map((a) => ({ ...a, seq: m.seq }))),
          fetchAttachment: (id, signal) => this.client.download(id, signal),
          onProgress: (note) => {
            const n = note.replace(/\s+/g, ' ').trim().slice(0, 300);
            if (n) progress = n;
          },
        });
      } catch (e) {
        if (cancelled || lost) {
          this.o.log.info(`brainstorm: 턴 멈춤 run=${runId} (${cancelled ? '취소' : '소유 잃음'}) — 답을 올리지 않는다`);
          if (cancelled) await this.confirmCancel(runId, runToken);
          return cancelled ? 'cancelled' : 'lost';
        }
        if (stop?.aborted) return 'lost'; // 게이트웨이가 내려간다 — 서버가 lease 만료로 unknown 처리
        const msg = redact((e as Error).message ?? String(e)).slice(0, 500);
        this.o.log.warn(`brainstorm: 턴 실패 run=${runId} ${msg}`);
        await this.client.call('POST', `/api/adapter/runs/${runId}/fail`, { run_token: runToken, error: `${this.rt}: ${msg}` }).catch(() => {});
        return 'failed';
      }
      if (lost) return 'lost';
      // 취소가 왔지만 턴이 멈추기 전에 답을 다 냈으면 그 답을 올린다(완료 우선 확정 — 서버가 받는다)
      const finishedFirst = cancelled && !result.aborted && !!stripAnswerStamp(result.text ?? '');
      if (!finishedFirst && (cancelled || result.aborted || ac.signal.aborted)) {
        if (!cancelled && stop?.aborted) return 'lost';
        if (!cancelled) {
          await this.client.call('POST', `/api/adapter/runs/${runId}/fail`, { run_token: runToken, error: `${this.rt}: aborted` }).catch(() => {});
          return 'failed';
        }
        this.o.log.info(`brainstorm: 턴 멈춤 run=${runId} (취소) — 답을 올리지 않는다`);
        await this.confirmCancel(runId, runToken);
        return 'cancelled';
      }
      if (finishedFirst) this.o.log.info(`brainstorm: 취소 요청 전에 턴이 이미 끝남 run=${runId} — 답을 올린다(완료 우선)`);
      await this.o.beforeComplete?.(runId);
      const body = stripAnswerStamp(result.text ?? '');
      if (!body) {
        await this.client.call('POST', `/api/adapter/runs/${runId}/fail`, { run_token: runToken, error: `${this.rt}: empty reply` }).catch(() => {});
        return 'failed';
      }
      const actual = (this.o.describeModel ?? describeActualModel)(result.meta);
      try {
        await this.client.call('POST', `/api/adapter/runs/${runId}/complete`, {
          run_token: runToken,
          body,
          source_kind: 'proposal', // 에이전트 답은 지시가 아니다
          context_upto_seq: (claim.forward?.context_upto_seq ?? claim.pulled?.context_upto_seq), // 전달 실행: 여기까지 보냈다
          runtime: actual.runtime ?? undefined,
          model: actual.model ?? undefined,
          usage: {
            [this.rt]: {
              session_key: sessionKey,
              session_id: result.meta?.sessionId ?? null,
              provider: result.meta?.provider ?? null,
              model: result.meta?.model ?? null,
              harness: result.meta?.agentHarnessId ?? null,
              duration_ms: result.durationMs ?? Date.now() - started,
              ...(result.extra ?? {}),
            },
            tokens: result.usage ?? null,
          },
        });
      } catch (e) {
        this.o.log.warn(`brainstorm: complete 거절 run=${runId} ${redact((e as Error).message)}`);
        return 'lost';
      }
      this.o.log.info(`brainstorm: 답 올림 run=${runId} key=${sessionKey} model=${actual.model ?? '?'}`);
      return 'succeeded';
    } finally {
      clearInterval(hb);
      stop?.removeEventListener('abort', onStop);
      this.busy--;
    }
  }
}

// brainStorm 작업자 — OpenAI 호환 `/v1/chat/completions` 에 붙는다. 한 번에 한 턴.
//
// 규칙 (openclaw-channel 작업자와 같다)
//   - claim 직후 ACK: ACK 된 전달은 다시 나가지 않는다. 그 뒤 죽으면 run lease 가 지나 서버가 `unknown` 으로 둔다.
//   - run_token 이 없거나(중복) 상태가 queued 가 아니면 절대 돌리지 않는다 — 재실행 금지.
//   - heartbeat 가 cancel 을 주면 LLM 요청을 abort 하고 서버에 «중단 확인»(POST …/cancelled)을 보낸다. 답은 올리지 않는다.
//     abort 전에 응답이 이미 다 왔으면 그 답을 올린다(«완료 우선 확정» — 서버가 succeeded 로 받는다).
//     확인을 못 보내면 서버가 무응답 제한(기본 30초) 뒤 unknown 으로 둔다 — 자동 재실행은 없다.
//   - 토큰·키·본문은 로그에 남기지 않는다(식별자만). 오류 문자열은 가린 뒤 fail 에 싣는다.
//   - 스트리밍으로 받되, brainStorm 에 중간 갱신 API 가 없으므로 끝난 뒤 한 번에 complete 한다.
import { createHash } from 'node:crypto';
import type { ClaimCarry, ClaimForward, ClaimHoldNotice, ClaimPulled, ClaimSession, Message, Participant, Run } from '../../src/protocol.js';
import { renderFace, renderHoldNotices, type ClaimFace } from '../../src/protocol.js';
import { stripAnswerStamp } from '../openclaw-channel/src/mapping.js';
import { httpFetch } from './http.js';
import { BrainstormClient, HttpError } from '../openclaw-channel/src/worker.js';
import {
  buildChatMessages,
  redactSecrets,
  selectGenerationContext,
  SseLines,
  stripThink,
  systemFor,
  type AttachmentContent,
  type ChatMessage,
} from './mapping.js';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface OpenAIWorkerOptions {
  url: string;
  token: string;
  worker: string;
  /** 예: http://127.0.0.1:8000/v1 (끝의 /chat/completions 는 붙이지 않는다) */
  openaiBaseUrl: string;
  openaiApiKey?: string;
  model: string;
  systemPrompt: string;
  maxTokens: number;
  contextTokens: number;
  temperature?: number;
  timeoutMs: number;
  stream: boolean;
  /** 그림 첨부를 image_url 로 넘긴다(모델이 받을 때만) — 기본 끔 */
  vision?: boolean;
  /** 텍스트 첨부를 본문에 넣는 최대 글자 수(0 = 넣지 않음 · 기본 20000) */
  attachTextMax?: number;
  log: Logger;
  pollMs?: number;
  heartbeatMs?: number;
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
  /** 새 세대의 첫 실행에만 — 이어받은 맥락 */
  carry?: ClaimCarry | null;
  /** 네 요청이 보류됐다는 알림(그 스레드에서 처음 불리는 실행 한 번만) — 옛 서버는 안 보낸다 */
  hold_notices?: ClaimHoldNotice[] | null;
  face?: ClaimFace | null;
}

export interface ChatResult {
  text: string;
  model: string | null;
  finishReason: string | null;
  usage: unknown;
  timings: unknown;
  reasoningChars: number;
  firstTokenMs: number | null;
}

export class LlmError extends Error {}

export type HandleOutcome = 'idle' | 'skipped' | 'succeeded' | 'failed' | 'cancelled' | 'lost';

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

/** 설정 지문 — run 에 남는 config_version. 비밀은 넣지 않는다 */
export function configVersion(o: Pick<OpenAIWorkerOptions, 'model' | 'maxTokens' | 'contextTokens' | 'systemPrompt' | 'temperature'>): string {
  const h = createHash('sha256').update(o.systemPrompt).digest('hex').slice(0, 8);
  return `openai:${o.model}:mt${o.maxTokens}:ctx${o.contextTokens}:t${o.temperature ?? '-'}:sp${h}`.slice(0, 200);
}

export class OpenAIWorker {
  readonly client: BrainstormClient;
  private participants = new Map<string, Participant>();
  private me: Participant | null = null;
  private busy = false;
  private readonly f: (url: string, init: RequestInit) => Promise<Response>;

  constructor(private readonly o: OpenAIWorkerOptions) {
    this.client = new BrainstormClient(o.url, o.token, o.fetchImpl);
    this.f = o.fetchImpl ?? httpFetch; // 내장 fetch 의 300초 무응답 제한을 피한다(http.ts)
  }

  /** 첨부 내용 캐시(id → 내용) — 같은 세대를 매 턴 다시 넘기므로 매번 받지 않는다 */
  private attCache = new Map<string, AttachmentContent>();

  /** 맥락 메시지의 첨부 중 넘길 것을 받는다: 텍스트(본문에) · 그림(vision 일 때 · 최근 MAX_IMAGES 장). 실패한 것은 이름만 간다 */
  async loadAttachments(msgs: Message[], signal?: AbortSignal): Promise<Map<string, AttachmentContent>> {
    const MAX_IMAGES = 4;
    const textMax = this.o.attachTextMax ?? 20_000;
    const out = new Map<string, AttachmentContent>();
    let images = 0;
    for (const m of [...msgs].sort((a, b) => b.seq - a.seq)) {
      for (const a of m.attachments ?? []) {
        const wantText = a.kind === 'text' && textMax > 0;
        const wantImage = a.kind === 'image' && !!this.o.vision && images < MAX_IMAGES;
        if (!wantText && !wantImage) continue;
        if (wantImage) images++;
        let c = this.attCache.get(a.id);
        if (!c) {
          try {
            const data = await this.client.download(a.id, signal);
            if (wantText) {
              const all = data.toString('utf8');
              c = { text: all.slice(0, textMax), truncated: all.length > textMax };
            } else c = { dataUrl: `data:${a.mime ?? 'application/octet-stream'};base64,${data.toString('base64')}` };
          } catch (e) {
            this.o.log.warn(`첨부 받기 실패 ${a.id} ${this.redact((e as Error).message)}`);
            continue;
          }
          this.attCache.set(a.id, c);
          while (this.attCache.size > 32) this.attCache.delete(this.attCache.keys().next().value!);
        }
        out.set(a.id, c);
      }
    }
    return out;
  }

  private redact(s: string): string {
    return redactSecrets(s, [this.o.token, this.o.openaiApiKey]);
  }

  async whoami(): Promise<Participant> {
    const r = await this.client.call<{ participant: Participant }>('GET', '/api/me');
    this.me = r.participant;
    return r.participant;
  }

  private async refreshParticipants() {
    const r = await this.client.call<{ participants: Participant[] }>('GET', '/api/participants');
    this.participants = new Map(r.participants.map((p) => [p.id, p]));
  }

  /** 멈출 때까지 돈다. 인증이 거절되면 'auth' 를 돌려준다(프로세스는 재시작해도 소용없다) */
  async loop(signal: AbortSignal): Promise<'stopped' | 'auth'> {
    const poll = this.o.pollMs ?? 1500;
    let backoff = poll;
    while (!signal.aborted) {
      try {
        if (!this.me) await this.whoami();
        const r = await this.handleOne(signal);
        backoff = poll;
        if (r === 'idle') await sleep(poll, signal);
      } catch (e) {
        if (e instanceof HttpError && (e.status === 401 || e.status === 403) && !this.busy) {
          this.o.log.error(`인증 거절(${e.status}) — 토큰을 확인하라. 멈춘다`);
          return 'auth';
        }
        this.o.log.warn(`${this.redact((e as Error).message)} — ${Math.round(backoff / 1000)}초 뒤 다시`);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
    return 'stopped';
  }

  /** chat completions 한 번. 스트리밍이면 조각을 모아 끝난 뒤 돌려준다 */
  async chat(messages: ChatMessage[], signal: AbortSignal, onProgress?: (note: string) => void): Promise<ChatResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.o.model,
      messages,
      max_tokens: this.o.maxTokens,
      stream: this.o.stream,
    };
    if (this.o.temperature !== undefined) body.temperature = this.o.temperature;
    if (this.o.stream) body.stream_options = { include_usage: true };
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: this.o.stream ? 'text/event-stream' : 'application/json' };
    if (this.o.openaiApiKey) headers.Authorization = `Bearer ${this.o.openaiApiKey}`;
    const res = await this.f(this.o.openaiBaseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 600);
      throw new LlmError(`HTTP ${res.status} ${text}`.trim());
    }
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('text/event-stream') || !res.body) {
      // 비스트리밍(또는 서버가 stream 을 무시하고 JSON 으로 준 경우)
      const j: any = await res.json().catch(() => {
        throw new LlmError('응답이 JSON 이 아니다');
      });
      if (j?.error) throw new LlmError(`error ${JSON.stringify(j.error).slice(0, 600)}`);
      const ch = j?.choices?.[0];
      const reasoning = ch?.message?.reasoning_content ?? ch?.message?.reasoning;
      return {
        text: typeof ch?.message?.content === 'string' ? ch.message.content : '',
        model: typeof j?.model === 'string' ? j.model : null,
        finishReason: ch?.finish_reason ?? null,
        usage: j?.usage ?? null,
        timings: j?.timings ?? null,
        reasoningChars: typeof reasoning === 'string' ? reasoning.length : 0,
        firstTokenMs: null,
      };
    }
    const out: ChatResult = { text: '', model: null, finishReason: null, usage: null, timings: null, reasoningChars: 0, firstTokenMs: null };
    const sse = new SseLines();
    const dec = new TextDecoder();
    let done = false;
    const take = (data: string) => {
      if (data === '[DONE]') {
        done = true;
        return;
      }
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        return; // 주석·빈 줄·모르는 조각은 건너뛴다
      }
      if (j?.error) throw new LlmError(`stream error ${JSON.stringify(j.error).slice(0, 600)}`);
      if (typeof j?.model === 'string') out.model = j.model;
      if (j?.usage) out.usage = j.usage;
      if (j?.timings) out.timings = j.timings;
      const ch = j?.choices?.[0];
      const d = ch?.delta;
      if (typeof d?.content === 'string' && d.content) {
        if (out.firstTokenMs === null) out.firstTokenMs = Date.now() - started;
        out.text += d.content;
        onProgress?.('답 쓰는 중');
      }
      const r = d?.reasoning_content ?? d?.reasoning;
      if (typeof r === 'string') {
        out.reasoningChars += r.length;
        if (!out.text) onProgress?.('생각하는 중(추론)');
      }
      if (ch?.finish_reason) out.finishReason = ch.finish_reason;
    };
    const reader = res.body.getReader();
    try {
      while (!done) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        for (const line of sse.push(dec.decode(value, { stream: true }))) take(line);
      }
      for (const line of sse.push(dec.decode())) take(line);
      for (const line of sse.flush()) take(line);
    } finally {
      reader.cancel().catch(() => {});
    }
    if (!done && !out.finishReason) throw new LlmError('스트림이 끝 표시 없이 끊겼다');
    return out;
  }

  async handleOne(stop?: AbortSignal): Promise<HandleOutcome> {
    const c = await this.client.call<{ claim: Claim | null }>('POST', '/api/adapter/claim', { worker: this.o.worker });
    const claim = c.claim;
    if (!claim) return 'idle';
    const runId = claim.run.id;
    this.o.log.info(`claim delivery=${claim.delivery.id} run=${runId} thread=${claim.thread.id} gen=${claim.session.generation} state=${claim.run.state} dup=${claim.duplicate}`);

    try {
      await this.client.call('POST', `/api/adapter/deliveries/${claim.delivery.id}/ack`, { lease_token: claim.delivery.lease_token });
    } catch (e) {
      this.o.log.warn(`ack 실패 ${this.redact((e as Error).message)}`);
    }
    if (!claim.run.run_token || claim.run.state !== 'queued') {
      this.o.log.info(`skip run=${runId} state=${claim.run.state} (다시 돌리지 않는다)`);
      return 'skipped';
    }
    const runToken = claim.run.run_token;
    const me = this.me ?? (await this.whoami());

    try {
      // 실제 모델은 응답의 model 칸으로 complete 에 싣는다 — 시작 때는 비워 둔다
      await this.client.call('POST', `/api/adapter/runs/${runId}/start`, {
        run_token: runToken,
        runtime: 'openai-compat',
        config_version: configVersion(this.o),
      });
    } catch (e) {
      this.o.log.warn(`start 거절 run=${runId} ${this.redact((e as Error).message)}`);
      return 'lost';
    }

    this.busy = true;
    const ac = new AbortController();
    let cancelled = false;
    let lost = false;
    let stopping = false;
    let timedOut = false;
    const onStop = () => {
      stopping = true;
      ac.abort(new Error('adapter stopping'));
    };
    stop?.addEventListener('abort', onStop, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort(new Error('timeout'));
    }, this.o.timeoutMs);
    // 읽음: 시작 즉시 기계적 반응을 한 번 · 그 뒤 경과(모델 대기 → 생각 → 답 쓰는 중)는 바뀔 때만 싣는다
    let progress = '읽었음 — 모델에 요청 보냄';
    let sent = '';
    const beat = () => {
      const note = progress !== sent ? progress : undefined;
      this.client
        .call<{ cancel?: boolean }>('POST', `/api/adapter/runs/${runId}/heartbeat`, { run_token: runToken, ...(note ? { progress: note } : {}) })
        .then((r) => {
          if (note) sent = note;
          if (r?.cancel && !cancelled) {
            cancelled = true;
            this.o.log.info(`취소 요청 run=${runId} — LLM 요청을 끊는다`);
            ac.abort(new Error('cancelled by brainStorm'));
          }
        })
        .catch((e) => {
          if (e instanceof HttpError && e.status === 409) {
            lost = true; // 서버가 이 실행을 더는 우리 것으로 안 본다(취소·세대 교체·unknown)
            ac.abort(new Error('run no longer owned'));
          }
        });
    };
    beat();
    const hb = setInterval(beat, this.o.heartbeatMs ?? 5_000);

    const fail = async (error: string) => {
      await this.client.call('POST', `/api/adapter/runs/${runId}/fail`, { run_token: runToken, error: this.redact(error).slice(0, 1000) }).catch(() => {});
    };

    try {
      const unknownAuthors = [claim.trigger, ...claim.context].some((m) => !this.participants.has(m.author_id));
      if (unknownAuthors) await this.refreshParticipants().catch(() => {});
      const ctxMsgs = selectGenerationContext(claim.context, claim.session, claim.trigger, (claim.forward?.context_upto_seq ?? claim.pulled?.context_upto_seq));
      const attachments = await this.loadAttachments(ctxMsgs, ac.signal);
      const built = buildChatMessages({
        attachments,
        system: [systemFor(this.o.systemPrompt, claim.thread.title), renderHoldNotices(claim.hold_notices), claim.face ? renderFace(claim.face) : ''].filter(Boolean).join('\n'),
        messages: ctxMsgs,
        triggerSeq: claim.trigger.seq,
        selfId: me.id,
        participants: this.participants,
        contextTokens: this.o.contextTokens,
        maxTokens: this.o.maxTokens,
        forwarded: !!claim.forward,
        pulled: claim.pulled ?? null,
        carry: claim.carry ?? null,
      });
      const started = Date.now();
      let r: ChatResult;
      try {
        r = await this.chat(built.messages, ac.signal, (n) => (progress = n));
      } catch (e) {
        if (cancelled || lost) {
          this.o.log.info(`턴 멈춤 run=${runId} (${cancelled ? '취소' : '소유 잃음'}) — 답을 올리지 않는다`);
          if (cancelled) {
            const a = await this.client.ackCancel(runId, runToken).catch((err) => `error ${this.redact((err as Error).message)}`);
            this.o.log.info(`중단 확인 run=${runId} → ${a}`);
          }
          return cancelled ? 'cancelled' : 'lost';
        }
        const why = timedOut ? `timeout ${this.o.timeoutMs}ms` : stopping ? 'adapter stopping' : ((e as Error).message ?? String(e));
        const msg = this.redact(why).slice(0, 800);
        this.o.log.warn(`LLM 실패 run=${runId} ${msg}`);
        await fail(`openai: ${msg}`);
        return 'failed';
      }
      if (lost) return 'lost';
      // 취소가 왔지만 응답이 이미 다 와 있었다 — 답을 올린다(완료 우선 확정, 서버가 받는다)
      if (cancelled) this.o.log.info(`취소 요청 전에 응답이 이미 끝남 run=${runId} — 답을 올린다(완료 우선)`);

      let body = stripAnswerStamp(stripThink(r.text ?? ''));
      if (!body) {
        await fail(`openai: empty reply (finish_reason=${r.finishReason ?? '?'})`);
        return 'failed';
      }
      if (r.finishReason === 'length') body += '\n\n[응답이 max_tokens 에 닿아 잘렸음]';
      const usage = compactUsage({
        openai: {
          model_requested: this.o.model,
          model: r.model,
          stream: this.o.stream,
          finish_reason: r.finishReason,
          duration_ms: Date.now() - started,
          first_token_ms: r.firstTokenMs,
          reasoning_chars: r.reasoningChars || undefined,
        },
        context: {
          generation: claim.session.generation,
          candidates: built.total,
          sent: built.used,
          dropped: built.dropped,
          trigger_truncated: built.truncatedTrigger || undefined,
          pulled_truncated: built.truncatedPulled || undefined, // 가져온 묶음 가운데가 잘림(메티 #175 — 지표·화면에 보이게)
          est_tokens: built.estTokens,
          budget_tokens: built.budgetTokens,
        },
        tokens: r.usage ?? null,
        timings: r.timings ?? null,
      });
      try {
        await this.client.call('POST', `/api/adapter/runs/${runId}/complete`, {
          run_token: runToken,
          body,
          source_kind: 'proposal', // 에이전트 답은 지시가 아니다
          // 전달·끌어오기 실행: 여기까지 보냈다. 예산으로 옛 대화가 밀려났으면 되돌리지 않는다 — 서버가 원인까지만 본 것으로 친다(메티 #175)
          context_upto_seq: built.pushedOut ? undefined : (claim.forward?.context_upto_seq ?? claim.pulled?.context_upto_seq),
          runtime: 'openai-compat',
          model: r.model ?? undefined, // 서버가 알려 준 값만. 없으면 비운다(설정값으로 채우지 않는다)
          usage,
        });
      } catch (e) {
        this.o.log.warn(`complete 거절 run=${runId} ${this.redact((e as Error).message)}`);
        return 'lost';
      }
      this.o.log.info(`답 올림 run=${runId} model=${r.model ?? '?'} sent=${built.used}/${built.total} finish=${r.finishReason ?? '?'}`);
      return 'succeeded';
    } finally {
      clearInterval(hb);
      clearTimeout(timer);
      stop?.removeEventListener('abort', onStop);
      this.busy = false;
    }
  }
}

/** 서버는 usage 를 4000자에서 자른다(잘리면 JSON 이 깨진다) — 넘치면 큰 칸부터 뺀다 */
export function compactUsage(u: Record<string, unknown>): Record<string, unknown> {
  const fits = (x: unknown) => JSON.stringify(x).length <= 3800;
  if (fits(u)) return u;
  const v = { ...u, timings: '(omitted: too large)' };
  if (fits(v)) return v;
  const w = { ...v, tokens: '(omitted: too large)' };
  if (fits(w)) return w;
  return { openai: { note: 'usage omitted: too large' } };
}

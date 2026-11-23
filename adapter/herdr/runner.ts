// brainStorm 한 턴 → 이미 도는 herdr 창(대화형 Claude Code) 하나에 주입. 새 claude 를 띄우지 않는다.
//
// 설계: _plan/herdr-adapter.md
//   상태·세션: `herdr --session S agent get P` → agent_status(idle/working/blocked/done) · agent_session.value(Claude 세션 UUID) · cwd.
//   주입: `agent prompt P '<앞머리 + 프롬프트>'`. 앞머리에 run id 를 넣어 «표지»로 쓴다.
//   답: 터미널을 긁지 않는다. 세션 기록(<configDir>/projects/<cwd 인코딩>/<UUID>.jsonl)에 주입 뒤 새로 붙은 줄을 읽어
//       표지가 든 user 줄 뒤 stop_reason=end_turn 인 마지막 assistant 메시지의 text 를 답으로 낸다.
//   창이 바쁘면(canClaim) claim 하지 않는다 · blocked 는 자동으로 답하지 않고 경과로 알린다 · 취소는 Esc 한 번.
//   /clear 등으로 세션 UUID 가 바뀌면 새 기록을 처음부터 읽어 표지를 찾는다.
import { t } from '../../src/i18n.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { progressOf, sessionFile, stageAttachments } from '../claude-cli/runner.js';
import type { RunTurn, TurnRequest, TurnResult } from '../openclaw-channel/src/worker.js';
import { RulesTracker } from '../openclaw-channel/src/mapping.js';

export interface HerdrRunnerOptions {
  /** herdr 실행 파일 */
  bin: string;
  /** herdr 세션 이름(--session) */
  session: string;
  /** 대상 창: pane id(w1:p1) 또는 agent 이름. 없으면 paneTitle 로 찾는다 */
  pane?: string;
  /** 대상 창 제목(terminal_title_stripped 와 정확히 같은 것) — 매 턴 다시 찾는다 */
  paneTitle?: string;
  /** Claude Code 설정 디렉터리(기본 ~/.claude) — 세션 기록을 찾는다 */
  configDir: string;
  /** 한 턴 최대 — 넘으면 Esc 로 멈추고 실패 */
  timeoutMs: number;
  /** claim 뒤 창이 바쁠 때 비기를 기다리는 최대 */
  busyWaitMs: number;
  /** 주입 뒤 세션 기록에 표지가 나타나기를 기다리는 최대 */
  acceptMs: number;
  /** 상태·기록을 보는 간격(기본 1000) */
  pollMs?: number;
  /** 첨부 내려받는 곳 */
  attachDir?: string;
  /** 긴 프롬프트를 쓰는 곳 */
  spoolDir: string;
  /** 이보다 긴(바이트) 프롬프트는 파일로 넘긴다(기본 64KB · argv 한도) */
  spoolBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface AgentInfo {
  paneId: string;
  status: AgentStatus;
  sessionId: string | null;
  cwd: string | null;
  agent: string | null;
}

export class HerdrError extends Error {
  constructor(
    readonly code: string | undefined,
    msg: string,
  ) {
    super(msg);
  }
}

const READY = new Set(['idle', 'done']);
export const isReady = (s: AgentStatus) => READY.has(s);

/** herdr 하나 부르기 — JSON 결과(.result). 실패면 stderr 의 JSON 오류 코드를 담아 던진다 */
export function herdr(o: Pick<HerdrRunnerOptions, 'bin' | 'session' | 'env'>, args: string[], timeoutMs = 30_000): Promise<any> {
  return new Promise((resolve, reject) => {
    // 창 안에서 띄운 경우 물려받은 소켓 지정이 --session 과 엇갈리지 않게 뺀다
    const { HERDR_SOCKET_PATH: _sock, ...env } = o.env ?? process.env;
    execFile(o.bin, ['--session', o.session, ...args], { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        let code: string | undefined;
        let msg = String(stderr || err.message).trim();
        try {
          const j = JSON.parse(String(stderr));
          code = j?.error?.code ?? j?.code;
          msg = j?.error?.message ?? j?.message ?? msg;
        } catch {}
        return reject(new HerdrError(code, `herdr ${args[0]} ${args[1] ?? ''}: ${code ? code + ' ' : ''}${msg}`.slice(0, 400)));
      }
      try {
        const j = stdout.trim() ? JSON.parse(stdout) : {};
        resolve(j?.result ?? j);
      } catch {
        resolve({});
      }
    });
  });
}

/** `agent get` 결과 → AgentInfo */
export function parseAgent(r: any): AgentInfo {
  const a = r?.agent ?? r;
  if (!a?.pane_id) throw new Error('herdr agent get: 모양이 다르다');
  return {
    paneId: a.pane_id,
    status: (['idle', 'working', 'blocked', 'done'].includes(a.agent_status) ? a.agent_status : 'unknown') as AgentStatus,
    sessionId: typeof a.agent_session?.value === 'string' ? a.agent_session.value : null,
    cwd: typeof a.cwd === 'string' ? a.cwd : null,
    agent: typeof a.agent === 'string' ? a.agent : null,
  };
}

/** 창 제목으로 pane id 를 찾는다 — 없거나 둘 이상이면 던진다 */
export function findByTitle(list: any, title: string): string {
  const agents: any[] = list?.agents ?? [];
  const hit = agents.filter((a) => (a.terminal_title_stripped ?? '').trim() === title.trim());
  if (hit.length !== 1) throw new Error(`herdr: 제목 «${title}» 인 창이 ${hit.length}개`);
  return hit[0].pane_id;
}

/** 세션 기록 파일 — cwd 인코딩 자리, 없으면 projects/* 아래에서 UUID 로 찾는다 */
export function locateTranscript(configDir: string, cwd: string | null, uuid: string): string | null {
  if (cwd) {
    const f = sessionFile(configDir, cwd, uuid);
    if (fs.existsSync(f)) return f;
  }
  const root = path.join(configDir, 'projects');
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${uuid}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}

/** 파일 꼬리 읽기 — 지난번 뒤로 새로 붙은 완결된 줄만 */
export class Tail {
  private pending = '';
  constructor(
    readonly file: string,
    private offset: number,
  ) {}
  static atEnd(file: string): Tail {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {}
    return new Tail(file, size);
  }
  read(): string[] {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return [];
    }
    if (size < this.offset) this.offset = 0; // 잘렸다 — 처음부터
    if (size === this.offset) return [];
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const s = this.pending + buf.toString('utf8');
      const lines = s.split('\n');
      this.pending = lines.pop() ?? '';
      return lines.filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  }
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
          .map((c: any) => c.text)
          .join('\n')
      : '';

/** 기록 줄들을 읽어 표지 뒤의 답을 모은다 */
export class TranscriptReader {
  markerSeen = false;
  /** 표지 뒤 마지막 end_turn 메시지 */
  final: { id: string; texts: string[]; model?: string; usage?: any } | null = null;
  /** 표지 뒤 마지막 assistant 메시지(중단됐을 때의 대체) */
  last: { id: string; texts: string[] } | null = null;
  constructor(readonly marker: string) {}

  /** 줄 하나 → 경과로 보일 사건(assistant)이면 그 사건을 돌려준다 */
  feed(line: string): any | null {
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      return null;
    }
    if (j?.isSidechain) return null;
    if (!this.markerSeen) {
      if (j?.type === 'user' && textOf(j.message?.content).includes(this.marker)) this.markerSeen = true;
      return null;
    }
    if (j?.type !== 'assistant' || !j.message) return null;
    const id = String(j.message.id ?? j.uuid ?? '');
    const texts = (j.message.content ?? []).filter((c: any) => c?.type === 'text' && typeof c.text === 'string' && c.text.trim()).map((c: any) => c.text);
    if (!this.last || this.last.id !== id) this.last = { id, texts: [] };
    this.last.texts.push(...texts);
    if (j.message.stop_reason === 'end_turn') {
      if (!this.final || this.final.id !== id) this.final = { id, texts: [] };
      this.final.texts.push(...texts);
      this.final.model = j.message.model;
      this.final.usage = j.message.usage;
    } else if (this.final && this.final.id !== id) {
      this.final = null; // end_turn 뒤에 또 이어졌다(훅 등) — 다음 end_turn 을 기다린다
    }
    return j;
  }

  answer(): string {
    return (this.final?.texts ?? []).join('\n\n').trim();
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const tm = setTimeout(done, ms);
    function done() {
      clearTimeout(tm);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/** 앞머리 — 창에서 어느 스레드·누구의 글인지 보이고, run id 가 표지가 된다 */
export function headOf(req: Pick<TurnRequest, 'runId' | 'threadTitle' | 'sender' | 'lang'>): string {
  return `${t(req.lang, 'prompt.herdr_head', { run: req.runId, title: req.threadTitle.replace(/\s+/g, ' ').slice(0, 80), who: req.sender.name })}\n${t(req.lang, 'prompt.herdr_note')}`;
}

export interface HerdrRunner {
  runTurn: RunTurn;
  /** 창이 지금 글을 받을 수 있나(idle/done) — 작업자의 canClaim */
  canClaim: () => Promise<boolean>;
  /** 대상 창을 찾고 상태를 읽는다(check 용) */
  inspect: () => Promise<AgentInfo>;
}

export function makeHerdrRunner(o: HerdrRunnerOptions): HerdrRunner {
  const rulesTracker = new RulesTracker();
  const poll = o.pollMs ?? 1000;
  const target = async (): Promise<string> => {
    if (o.pane) return o.pane;
    if (!o.paneTitle) throw new Error('herdr: HERDR_PANE 또는 HERDR_PANE_TITLE 이 필요하다');
    return findByTitle(await herdr(o, ['agent', 'list']), o.paneTitle);
  };
  const get = async (p: string) => parseAgent(await herdr(o, ['agent', 'get', p]));
  const inspect = async () => get(await target());

  const runTurn: RunTurn = async (req) => {
    const p = await target();
    const deadline = Date.now() + o.timeoutMs;
    let a = await get(p);
    // 1. 창이 비기를 기다린다(claim 과 주입 사이 경합)
    if (!isReady(a.status)) {
      req.onProgress?.(t(req.lang, a.status === 'blocked' ? 'progress.herdr_blocked' : 'progress.herdr_busy'));
      const until = Date.now() + o.busyWaitMs;
      while (!isReady(a.status)) {
        if (req.signal.aborted) return { text: '', aborted: true };
        if (Date.now() > until) throw new Error(`창이 사용 중(${a.status}) — ${Math.round(o.busyWaitMs / 1000)}초 기다렸다`);
        await sleep(poll, req.signal);
        a = await get(p);
      }
    }
    if (!a.sessionId) throw new Error('herdr: 창의 Claude 세션 UUID 를 모른다(agent_session 없음)');

    // 2. 주입 전 기록 끝을 적어 둔다
    let uuid = a.sessionId;
    let file = locateTranscript(o.configDir, a.cwd, uuid);
    let tail = file ? Tail.atEnd(file) : null;
    const rd = new TranscriptReader(req.runId);

    // 3. 주입
    let extra = o.attachDir ? await stageAttachments(req, o.attachDir) : '';
    // 고정 규약(마스터 #1919): 이 창의 Claude 세션에 처음·규약이 바뀐 턴·20턴마다 전문, 그 사이는 한 줄 참조
    const rules = req.rules ? `${rulesTracker.pick(uuid, req.rules)}\n\n` : '';
    let text = `${headOf(req)}\n\n${rules}${req.prompt}${extra}`;
    if (Buffer.byteLength(text) > (o.spoolBytes ?? 64 * 1024)) {
      fs.mkdirSync(o.spoolDir, { recursive: true, mode: 0o700 });
      const f = path.join(o.spoolDir, `${req.runId.replace(/[^A-Za-z0-9_-]/g, '_')}.md`);
      fs.writeFileSync(f, text, { mode: 0o600 });
      text = `${headOf(req)}\n\n${t(req.lang, 'prompt.herdr_spooled', { path: f })}`;
    }
    if (req.signal.aborted) return { text: '', aborted: true };
    await herdr(o, ['agent', 'prompt', p, text]);
    req.onProgress?.(t(req.lang, 'progress.herdr_sent'));
    const sentAt = Date.now();

    // 4. 기다린다 — 상태 + 기록 꼬리
    const stopWindow = async () => {
      await herdr(o, ['agent', 'send-keys', p, 'esc']).catch(() => {});
      const until = Date.now() + 10_000;
      while (Date.now() < until) {
        const s = await get(p).catch(() => null);
        if (!s || isReady(s.status)) break;
        await sleep(Math.min(poll, 500));
      }
    };
    let idleStreak = 0;
    let wasBlocked = false;
    for (;;) {
      if (req.signal.aborted) {
        // 어댑터가 내려가는 것이면 창은 그대로 둔다(마스터의 창이다) — 취소·소유 잃음이면 Esc
        if ((req.signal.reason as Error | undefined)?.message !== 'adapter stopping') await stopWindow();
        return { text: '', aborted: true };
      }
      if (Date.now() > deadline) {
        await stopWindow();
        throw new Error(`timeout ${o.timeoutMs}ms`);
      }
      await sleep(poll, req.signal);
      if (req.signal.aborted) continue;
      a = await get(p);
      // 세션이 바뀌었다(/clear 등) — 새 기록을 처음부터
      if (a.sessionId && a.sessionId !== uuid) {
        uuid = a.sessionId;
        file = null;
        tail = null;
      }
      if (!tail) {
        file = locateTranscript(o.configDir, a.cwd, uuid);
        if (file) tail = new Tail(file, 0);
      }
      let fresh = 0;
      for (const line of tail?.read() ?? []) {
        fresh++;
        const ev = rd.feed(line);
        if (ev) {
          const note = progressOf(ev, req.lang);
          if (note) req.onProgress?.(note);
        }
      }
      if (a.status === 'blocked') {
        if (!wasBlocked) req.onProgress?.(t(req.lang, 'progress.herdr_blocked'));
        wasBlocked = true;
        idleStreak = 0;
        continue;
      }
      wasBlocked = false;
      if (!rd.markerSeen) {
        if (Date.now() - sentAt > o.acceptMs) throw new Error(`주입한 글이 세션 기록에 안 보인다(${Math.round(o.acceptMs / 1000)}초 · session ${uuid})`);
        continue;
      }
      if (!isReady(a.status)) {
        idleStreak = 0;
        continue;
      }
      if (rd.final && rd.answer()) break;
      // 표지는 보였는데 end_turn 없이 쉬고 있다 — 창에서 끊었다
      idleStreak = fresh ? 0 : idleStreak + 1;
      if (idleStreak >= 5) {
        const fallback = (rd.last?.texts ?? []).join('\n\n').trim();
        if (fallback) break;
        throw new Error('창에서 턴이 끝났는데 답이 없다(중단됐거나 빈 답)');
      }
    }
    const answer = rd.answer() || (rd.last?.texts ?? []).join('\n\n').trim();
    const u = rd.final?.usage;
    return {
      text: answer,
      meta: { provider: 'anthropic', model: rd.final?.model, agentHarnessId: 'claude-code', sessionId: uuid },
      durationMs: Date.now() - sentAt,
      usage: u ? { input: u.input_tokens, output: u.output_tokens, cache_read: u.cache_read_input_tokens, cache_write: u.cache_creation_input_tokens } : null,
      extra: { herdr_session: o.session, herdr_pane: a.paneId, claude_session: uuid, interrupted: !rd.final },
    };
  };

  const canClaim = async () => {
    const a = await inspect();
    return isReady(a.status);
  };
  return { runTurn, canClaim, inspect };
}

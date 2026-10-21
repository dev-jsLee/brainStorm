// brainStorm 한 턴 → `codex exec` 한 번 (OpenAI Codex CLI). Codex 에이전트를 붙인다.
//
// 기억: 스레드·세대마다 Codex 세션(thread) 하나. Codex 는 세션 id 를 스스로 짓는다 — 첫 턴의 `thread.started` 사건에서
//   받아 장부(sessionFile · 없으면 메모리)에 «세션 키 → thread_id» 로 적고, 다음 턴은 `exec resume <thread_id>` 로 잇는다.
//   프롬프트에는 «아직 못 본 메시지»만 넣는다(claude-cli 와 같은 결). 세대를 바꾸면(세션 교체) 키가 달라 새 세션이다.
// 덧붙임: Codex 에는 시스템 프롬프트 덧붙임 인자가 없다 — 새 세션의 첫 프롬프트 머리에 한 번 싣는다(그 뒤는 세션 기록에 남는다).
//   정체성은 작업 디렉터리(cwd)의 AGENTS.md 가 맡는다.
// 취소: AbortSignal → 프로세스 그룹에 SIGTERM, 5초 뒤 SIGKILL.
// 권한(샌드박스·승인)은 설정(globalArgs)이 정한다 — 이 파일은 정책을 박지 않는다.
// 경과: `--json` 사건(줄 단위)에서 명령 실행·MCP 도구·검색·답 첫 줄·생각을 onProgress 로 넘긴다.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RunTurn, TurnRequest, TurnResult } from '../openclaw-channel/src/worker.js';
import { stageAttachments } from '../claude-cli/runner.js';

export interface CodexRunnerOptions {
  /** codex 실행 파일 */
  bin: string;
  /** 작업 디렉터리 — 여기의 AGENTS.md 가 읽힌다(--cd) */
  cwd: string;
  /** 새 세션의 첫 프롬프트 머리에 실을 말(brainStorm 맥락) */
  preamble: string;
  /** `exec` 앞에 붙는 인자(예: --sandbox read-only --ask-for-approval never) */
  globalArgs: string[];
  model?: string;
  /** 한 턴 최대 시간 — 넘으면 끊고 실패로 돌려준다 */
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** 첨부를 내려받는 디렉터리(없으면 첨부는 목록만) */
  attachDir?: string;
  /** 세션 장부(JSON · 세션 키 해시 → thread_id). 없으면 메모리 — 재시작하면 새 세션으로 시작한다 */
  sessionFile?: string;
}

const BOOK_MAX = 500;

/** 세션 키 → 장부 열쇠(키에는 스레드 id 가 들어 있다 — 그대로 적지 않는다) */
export function bookKey(sessionKey: string): string {
  return createHash('sha256').update('brainstorm-codex:' + sessionKey).digest('hex').slice(0, 32);
}

export function buildArgs(o: Pick<CodexRunnerOptions, 'cwd' | 'globalArgs' | 'model'>, threadId: string | null): string[] {
  const a = ['--cd', o.cwd, ...o.globalArgs, 'exec', '--skip-git-repo-check', '--json'];
  if (o.model) a.push('-m', o.model);
  if (threadId) a.push('resume', threadId);
  a.push('-');
  return a;
}

/** `--json` 출력 전체 → TurnResult. 답이 없거나 턴이 실패했으면 던진다 */
export function parseEvents(stdout: string): TurnResult & { threadId: string | null } {
  let threadId: string | null = null;
  let text: string | null = null;
  let usage: any = null;
  let failed: string | null = null;
  let lastError: string | null = null;
  let completed = false;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') threadId = ev.thread_id;
    else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') text = ev.item.text;
    else if (ev.type === 'item.completed' && ev.item?.type === 'error') lastError = String(ev.item.message ?? '');
    else if (ev.type === 'error') lastError = String(ev.message ?? '');
    else if (ev.type === 'turn.failed') failed = String(ev.error?.message ?? ev.message ?? 'turn.failed');
    else if (ev.type === 'turn.completed') {
      completed = true;
      usage = ev.usage ?? null;
    }
  }
  if (failed) throw new Error(`codex turn.failed: ${failed.slice(0, 300)}`);
  if (!completed || text === null) throw new Error(`codex 답 없음${lastError ? `: ${lastError.slice(0, 300)}` : ''}`);
  return {
    threadId,
    text,
    meta: { provider: 'openai', agentHarnessId: 'codex', sessionId: threadId ?? undefined },
    usage: usage
      ? { input: usage.input_tokens, output: usage.output_tokens, cache_read: usage.cached_input_tokens, reasoning: usage.reasoning_output_tokens }
      : null,
  };
}

/** `--json` 사건 한 줄 → 화면에 보일 경과 한 줄(없으면 null) */
export function progressOf(ev: any): string | null {
  const it = ev?.item;
  if (!it || (ev.type !== 'item.started' && ev.type !== 'item.completed')) return null;
  const one = (s: unknown, n = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  if (ev.type === 'item.started' && it.type === 'command_execution') return `도구 shell — ${one(it.command)}`;
  if (ev.type === 'item.started' && it.type === 'mcp_tool_call') return `도구 ${one(it.server, 40)}.${one(it.tool, 60)}`;
  if (ev.type === 'item.started' && it.type === 'web_search') return `검색 — ${one(it.query)}`;
  if (ev.type === 'item.completed' && it.type === 'file_change') return `파일 변경 ${Array.isArray(it.changes) ? it.changes.length : ''}건`.trim();
  if (ev.type === 'item.completed' && it.type === 'agent_message' && typeof it.text === 'string' && it.text.trim())
    return `«${it.text.trim().split('\n')[0].slice(0, 140)}»`;
  if (it.type === 'reasoning') return '생각하는 중';
  return null;
}

function loadBook(file?: string): Record<string, string> {
  if (!file) return {};
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

export function makeCodexRunner(o: CodexRunnerOptions): RunTurn {
  const book = loadBook(o.sessionFile);
  const save = () => {
    const keys = Object.keys(book);
    for (const k of keys.slice(0, Math.max(0, keys.length - BOOK_MAX))) delete book[k];
    if (!o.sessionFile) return;
    try {
      fs.mkdirSync(path.dirname(o.sessionFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(o.sessionFile, JSON.stringify(book), { mode: 0o600 });
    } catch {}
  };
  return async (req: TurnRequest) => {
    const extra = o.attachDir ? await stageAttachments(req, o.attachDir) : '';
    const key = bookKey(req.sessionKey);
    const threadId = book[key] ?? null;
    const head = !threadId && o.preamble.trim() ? `${o.preamble.trim()}\n\n` : '';
    const r = await runOnce(o, { ...req, prompt: head + req.prompt + extra }, threadId);
    if (r.threadId && r.threadId !== threadId) {
      delete book[key]; // 넣은 순서 = 최근 순서
      book[key] = r.threadId;
      save();
    }
    const { threadId: _t, ...rest } = r;
    return { ...rest, meta: { ...rest.meta, model: o.model }, extra: { resumed: !!threadId } };
  };
}

function runOnce(o: CodexRunnerOptions, req: TurnRequest, threadId: string | null): Promise<TurnResult & { threadId: string | null }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(o.bin, buildArgs(o, threadId), {
      cwd: o.cwd,
      env: o.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // 프로세스 그룹째로 끊는다(도구가 띄운 자식까지)
    });
    let out = '';
    let err = '';
    let aborted = false;
    let timedOut = false;
    let pending = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (!req.onProgress) return;
      pending += d;
      let i: number;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        try {
          const note = progressOf(JSON.parse(line));
          if (note) req.onProgress(note);
        } catch {}
      }
    });
    child.stderr.on('data', (d) => {
      err += d;
      if (err.length > 64_000) err = err.slice(-32_000);
    });
    const kill = () => {
      aborted = true;
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
      }, 5000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);
    if (req.signal.aborted) kill();
    else req.signal.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      clearTimeout(timer);
      req.signal.removeEventListener('abort', kill);
      if (timedOut) return reject(new Error(`timeout ${o.timeoutMs}ms`));
      if (aborted) return resolve({ text: '', aborted: true, threadId });
      try {
        const r = parseEvents(out);
        return resolve({ ...r, durationMs: Date.now() - started });
      } catch (e) {
        const tail = err.trim().split('\n').filter((l) => !/^\s*$/.test(l)).slice(-2).join(' ').slice(0, 300);
        reject(new Error(`codex rc=${code} ${(e as Error).message}${tail ? ` · ${tail}` : ''}`));
      }
    });
    child.stdin.end(req.prompt);
  });
}

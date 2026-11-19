#!/usr/bin/env node
// Claude Code 어댑터 — brainStorm 에이전트 참여자 하나를 `claude -p`(Claude Code CLI)에 붙인다.
//
//   node dist/adapter/claude-cli-adapter.js [run|check]
//
// 하는 일: claim → ACK → start → 스레드·세대마다 Claude Code 세션 하나(--session-id / --resume)로 한 턴 → complete / fail.
// 프로토콜 규칙(ACK·재실행 금지·취소 확인·완료 우선)은 openclaw-channel 작업자 그대로 — 실행기만 claude -p 다.
// 설정은 환경변수(비밀 없음 · 토큰은 600 파일):
//   BRAINSTORM_URL          brainStorm 서버
//   BRAINSTORM_TOKEN_FILE   참여자 토큰 파일
//   BRAINSTORM_WORKER       작업자 이름(기본 호스트명)
//   CLAUDE_BIN              claude 실행 파일(기본 claude)
//   CLAUDE_CWD              작업 디렉터리 — 그 CLAUDE.md 가 읽힌다(기본 현재 디렉터리)
//   CLAUDE_CONFIG_DIR       Claude Code 설정 디렉터리(기본 ~/.claude) — 세션 파일로 resume 을 가른다
//   CLAUDE_MODEL            (선택) 모델 — 기본값. brainStorm 관리 화면에서 정한 에이전트 모델(claim.model)이 있으면 그쪽이 먼저
//   CLAUDE_EXTRA_ARGS       (선택) 권한 등 그 밖의 인자, 공백으로 가름 — 예: --permission-mode bypassPermissions
//   CLAUDE_APPEND_PROMPT_FILE (선택) 시스템 프롬프트에 덧붙일 글 파일. 없으면 기본 문구
//   CLAUDE_TIMEOUT_MS       한 턴 최대(기본 1800000 = 30분)
//   CLAUDE_WRAPUP_MS        시간 초과 뒤 같은 세션으로 도는 마무리 턴 최대(기본 600000 = 10분 · 0 이면 마무리 없이 실패)
//   CLAUDE_ATTACH_DIR       첨부를 내려받는 곳(기본 ~/.cache/brainstorm/attachments · 700)
//   CLAUDE_REFS_DIR         (선택) 원자 노트 폴더 — 글의 태그(#서버)를 파일 이름·별칭과 맞춰 본문을 붙인다(refs.ts). 없으면 끔
//   CLAUDE_REFS_VAULT       (선택) [[링크]] 경로를 찾을 vault 뿌리(기본 CLAUDE_REFS_DIR 의 부모)
//   CLAUDE_COST_FILE        세션별 비용 누계 장부 — 실행분 cost_usd 를 가르는 데 쓴다(기본 ~/.cache/brainstorm/claude-cost.json)
import { t } from '../src/i18n.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeClaudeRunner, sessionUuid } from './claude-cli/runner.js';
import { redact } from './openclaw-channel/src/mapping.js';
import { BrainstormWorker } from './openclaw-channel/src/worker.js';

const ts = () => new Date().toISOString();
const log = {
  info: (m: string) => console.log(ts(), m),
  warn: (m: string) => console.warn(ts(), 'WARN', m),
  error: (m: string) => console.error(ts(), 'ERROR', m),
};

/** 기본 덧붙임 글 — 턴의 언어(claim.lang)로 고른다(사전 prompt.claude_append · 마스터 #823) */
const DEFAULT_APPEND = (lang?: string) => t(lang, 'prompt.claude_append');

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : d;
}

async function main(): Promise<number> {
  const cmd = process.argv[2] ?? 'run';
  const env = process.env;
  const url = env.BRAINSTORM_URL;
  const tokenFile = env.BRAINSTORM_TOKEN_FILE;
  if (!url || !tokenFile) {
    log.error('설정: BRAINSTORM_URL 과 BRAINSTORM_TOKEN_FILE 이 필요하다');
    return 2;
  }
  let token: string;
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch (e) {
    log.error(`토큰 파일을 못 읽는다: ${tokenFile} (${(e as NodeJS.ErrnoException).code})`);
    return 2;
  }
  const cwd = path.resolve(env.CLAUDE_CWD || process.cwd());
  const appendFile = env.CLAUDE_APPEND_PROMPT_FILE;
  const append: string | ((lang?: string) => string) = appendFile && fs.existsSync(appendFile) ? fs.readFileSync(appendFile, 'utf8') : DEFAULT_APPEND;
  const extraArgs = (env.CLAUDE_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean);
  const runner = makeClaudeRunner({
    bin: env.CLAUDE_BIN || 'claude',
    cwd,
    configDir: env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    appendSystemPrompt: append,
    extraArgs,
    model: env.CLAUDE_MODEL || undefined,
    timeoutMs: num(env.CLAUDE_TIMEOUT_MS, 1_800_000),
    wrapUpMs: env.CLAUDE_WRAPUP_MS === '0' ? 0 : num(env.CLAUDE_WRAPUP_MS, 600_000),
    attachDir: path.resolve(env.CLAUDE_ATTACH_DIR || path.join(os.homedir(), '.cache', 'brainstorm', 'attachments')),
    refs: env.CLAUDE_REFS_DIR ? { dir: path.resolve(env.CLAUDE_REFS_DIR), vaultRoot: env.CLAUDE_REFS_VAULT ? path.resolve(env.CLAUDE_REFS_VAULT) : undefined } : undefined,
    costFile: path.resolve(env.CLAUDE_COST_FILE || path.join(os.homedir(), '.cache', 'brainstorm', 'claude-cost.json')),
  });
  const worker = new BrainstormWorker({
    url,
    token,
    worker: env.BRAINSTORM_WORKER || os.hostname(),
    ocAgentId: 'claude',
    runtime: 'claude-cli',
    describeModel: (meta) => ({ runtime: 'claude-cli', model: meta?.model ?? null }),
    configVersion: `claude-cli:${env.CLAUDE_MODEL || 'default'}:${extraArgs.join(' ').slice(0, 80)}:ap${sessionUuid(typeof append === 'function' ? append() : append).slice(0, 8)}`.slice(0, 200),
    runTurn: runner,
    log,
    pollMs: num(env.BRAINSTORM_POLL_MS, 3000),
    concurrency: num(env.BRAINSTORM_CONCURRENCY, 3),
  });

  try {
    const me = await worker.whoami();
    if (me.kind !== 'agent') {
      log.error(`토큰이 에이전트가 아니다(participant=${me.id} kind=${me.kind})`);
      return 2;
    }
    log.info(`연결 ${url} participant=${me.id} cwd=${cwd} args=${extraArgs.join(' ') || '-'}`);
  } catch (e) {
    const msg = redact((e as Error).message);
    log.error(`brainStorm 신원 확인 실패: ${msg}`);
    return /HTTP 40[13]/.test(msg) ? 4 : 1;
  }
  if (cmd === 'check') return 0;

  const ac = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const)
    process.once(sig, () => {
      log.info(`${sig} — 도는 턴이 있으면 끊고 멈춘다`);
      ac.abort();
    });
  await worker.loop(ac.signal);
  return ac.signal.aborted ? 0 : 4;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    log.error(String((e as Error)?.stack ?? e));
    process.exit(1);
  },
);

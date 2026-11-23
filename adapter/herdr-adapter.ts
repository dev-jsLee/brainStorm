#!/usr/bin/env node
// herdr 어댑터 — brainStorm 에이전트 참여자 하나를 이미 도는 herdr 창(대화형 Claude Code) 하나에 잇는다.
//
//   node dist/adapter/herdr-adapter.js [run|check]
//
// claude-cli 어댑터와 달리 claude 를 새로 띄우지 않는다 — 창이 받은 글은 그 창의 대화에 쌓이고, 그 턴의 마지막 답이 스레드에 올라간다.
// 프로토콜 규칙(ACK·재실행 금지·취소 확인·완료 우선)은 openclaw-channel 작업자 그대로 — 실행기만 herdr 다. 설계: _plan/herdr-adapter.md
// 설정은 환경변수(비밀 없음 · 토큰은 600 파일):
//   BRAINSTORM_URL          brainStorm 서버
//   BRAINSTORM_TOKEN_FILE   참여자 토큰 파일
//   BRAINSTORM_WORKER       작업자 이름(기본 호스트명)
//   HERDR_BIN               herdr 실행 파일(기본 herdr)
//   HERDR_SESSION           herdr 세션 이름(필수)
//   HERDR_PANE              대상 창: pane id(w1:p1) 또는 agent 이름 — 또는
//   HERDR_PANE_TITLE        대상 창 제목(정확히 같은 것 하나) — 매 턴 다시 찾는다
//   CLAUDE_CONFIG_DIR       Claude Code 설정 디렉터리(기본 ~/.claude) — 세션 기록을 찾는다
//   HERDR_TIMEOUT_MS        한 턴 최대(기본 1800000 = 30분) — 넘으면 Esc 로 멈추고 실패
//   HERDR_BUSY_WAIT_MS      claim 뒤 창이 바쁘면 기다리는 최대(기본 600000 = 10분)
//   HERDR_ACCEPT_MS         주입한 글이 세션 기록에 나타나기를 기다리는 최대(기본 30000)
//   HERDR_ATTACH_DIR        첨부를 내려받는 곳(기본 ~/.cache/brainstorm/attachments · 700)
//   HERDR_SPOOL_DIR         긴 프롬프트를 쓰는 곳(기본 ~/.cache/brainstorm/herdr-spool · 700)
// 동시성은 1 고정이다(창 하나는 한 번에 한 대화).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeHerdrRunner } from './herdr/runner.js';
import { redact } from './openclaw-channel/src/mapping.js';
import { BrainstormWorker } from './openclaw-channel/src/worker.js';

const ts = () => new Date().toISOString();
const log = {
  info: (m: string) => console.log(ts(), m),
  warn: (m: string) => console.warn(ts(), 'WARN', m),
  error: (m: string) => console.error(ts(), 'ERROR', m),
};

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
  if (!env.HERDR_SESSION || !(env.HERDR_PANE || env.HERDR_PANE_TITLE)) {
    log.error('설정: HERDR_SESSION 과 HERDR_PANE(또는 HERDR_PANE_TITLE)이 필요하다');
    return 2;
  }
  let token: string;
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch (e) {
    log.error(`토큰 파일을 못 읽는다: ${tokenFile} (${(e as NodeJS.ErrnoException).code})`);
    return 2;
  }
  const cache = path.join(os.homedir(), '.cache', 'brainstorm');
  const herdr = makeHerdrRunner({
    bin: env.HERDR_BIN || 'herdr',
    session: env.HERDR_SESSION,
    pane: env.HERDR_PANE || undefined,
    paneTitle: env.HERDR_PANE ? undefined : env.HERDR_PANE_TITLE,
    configDir: env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    timeoutMs: num(env.HERDR_TIMEOUT_MS, 1_800_000),
    busyWaitMs: num(env.HERDR_BUSY_WAIT_MS, 600_000),
    acceptMs: num(env.HERDR_ACCEPT_MS, 30_000),
    attachDir: path.resolve(env.HERDR_ATTACH_DIR || path.join(cache, 'attachments')),
    spoolDir: path.resolve(env.HERDR_SPOOL_DIR || path.join(cache, 'herdr-spool')),
  });
  const where = `${env.HERDR_SESSION}/${env.HERDR_PANE || `«${env.HERDR_PANE_TITLE}»`}`;
  let lastReady: boolean | null = null;
  const worker = new BrainstormWorker({
    rules: 'runner', // 고정 규약은 실행기가 싣는다(마스터 #1919)
    url,
    token,
    worker: env.BRAINSTORM_WORKER || os.hostname(),
    ocAgentId: 'herdr',
    runtime: 'herdr',
    describeModel: (meta) => ({ runtime: 'herdr', model: meta?.model ?? null }),
    configVersion: `herdr:${where}`.slice(0, 200),
    runTurn: herdr.runTurn,
    canClaim: async () => {
      const ready = await herdr.canClaim();
      if (ready !== lastReady) log.info(`herdr: 창 ${where} ${ready ? '받을 수 있음' : '바쁨 — claim 쉼'}`);
      lastReady = ready;
      return ready;
    },
    log,
    pollMs: num(env.BRAINSTORM_POLL_MS, 3000),
    concurrency: 1,
  });

  try {
    const a = await herdr.inspect();
    log.info(`herdr 창 ${where} pane=${a.paneId} agent=${a.agent ?? '-'} status=${a.status} session=${a.sessionId ?? '-'} cwd=${a.cwd ?? '-'}`);
    if (a.agent !== 'claude') log.warn(`herdr: 창의 agent 가 claude 가 아니다(${a.agent ?? '없음'}) — 답을 세션 기록에서 못 읽을 수 있다`);
  } catch (e) {
    log.error(`herdr 창을 못 찾는다(${where}): ${(e as Error).message}`);
    return 2;
  }
  try {
    const me = await worker.whoami();
    if (me.kind !== 'agent') {
      log.error(`토큰이 에이전트가 아니다(participant=${me.id} kind=${me.kind})`);
      return 2;
    }
    log.info(`연결 ${url} participant=${me.id}`);
  } catch (e) {
    const msg = redact((e as Error).message);
    log.error(`brainStorm 신원 확인 실패: ${msg}`);
    return /HTTP 40[13]/.test(msg) ? 4 : 1;
  }
  if (cmd === 'check') return 0;

  const ac = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const)
    process.once(sig, () => {
      log.info(`${sig} — 멈춘다(도는 턴이 있어도 창은 건드리지 않는다 — 그 실행은 서버가 unknown 으로 둔다)`);
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

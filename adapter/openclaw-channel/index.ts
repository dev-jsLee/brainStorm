// OpenClaw 채널 플러그인 `brainstorm` — 게이트웨이 안에서 brainStorm 서버로 «나가는» 연결만 한다.
// 수신 포트·HTTP 라우트 없음. 전달을 claim 해서 OpenClaw 에이전트 턴 하나를 돌리고, 답을 brainStorm 에 올린다.
//
// 설정 (openclaw.json):
//   channels.brainstorm = { enabled, url, tokenFile, agentId?, worker?, pollMs?, turnTimeoutMs? }
//   tokenFile 은 모드 600 파일 경로. 토큰 원문을 설정에 넣지 않는다.
//
// SDK 는 실험 계약이다 — OpenClaw 2026.9.6 에 고정(package.json openclaw.compat).
import fs from 'node:fs';
import { defineChannelPluginEntry, type ChannelPlugin, type OpenClawConfig, type PluginRuntime } from 'openclaw/plugin-sdk/channel-core';
import { BrainstormWorker, type RunTurn, type TurnResult } from './src/worker.js';
import { redact } from './src/mapping.js';

const CHANNEL = 'brainstorm';
const PLUGIN_VERSION = '0.2.0';

interface Section {
  enabled?: boolean;
  url?: string;
  tokenFile?: string;
  agentId?: string;
  worker?: string;
  pollMs?: number;
  turnTimeoutMs?: number;
}

interface Account {
  accountId: string;
  enabled: boolean;
  url: string | null;
  tokenFile: string | null;
  agentId: string;
  worker: string;
  pollMs: number;
  turnTimeoutMs: number | null;
}

function section(cfg: OpenClawConfig): Section {
  return ((cfg as any)?.channels?.[CHANNEL] ?? {}) as Section;
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): Account {
  const s = section(cfg);
  return {
    accountId: accountId ?? 'default',
    enabled: s.enabled !== false,
    url: typeof s.url === 'string' && s.url ? s.url.replace(/\/$/, '') : null,
    tokenFile: typeof s.tokenFile === 'string' && s.tokenFile ? s.tokenFile : null,
    agentId: typeof s.agentId === 'string' && s.agentId ? s.agentId : 'main',
    worker: typeof s.worker === 'string' && s.worker ? s.worker : 'openclaw-ct109',
    pollMs: typeof s.pollMs === 'number' && s.pollMs >= 500 ? s.pollMs : 3000,
    turnTimeoutMs: typeof s.turnTimeoutMs === 'number' && s.turnTimeoutMs > 0 ? s.turnTimeoutMs : null,
  };
}

/** 토큰 파일: 모드가 600(또는 400)이 아니면 거절한다. 값은 로그에 안 남긴다 */
function readToken(file: string): string {
  const st = fs.statSync(file);
  if ((st.mode & 0o077) !== 0) throw new Error(`token file ${file} must not be group/world readable (chmod 600)`);
  const t = fs.readFileSync(file, 'utf8').trim();
  if (!t) throw new Error(`token file ${file} is empty`);
  return t;
}

let runtime: PluginRuntime | null = null;

/** 에이전트 명령이 결과를 콘솔로 찍지 않게 하는 조용한 RuntimeEnv — 본문을 게이트웨이 로그에 남기지 않는다 */
const quietEnv = {
  log: () => {},
  error: () => {},
  exit: (code: number) => {
    throw new Error(`agent command requested exit ${code}`);
  },
};

/**
 * 한 턴 = 게이트웨이의 에이전트 명령 한 번(`openclaw agent` 와 같은 길: 모델·하네스 선택, 세션 행, CLI 세션 잇기, 전사).
 * runEmbeddedAgent 를 직접 부르면 하네스 선택을 건너뛰어 직접 API 로 간다(0단계 구독 로그인과 다르다) — 쓰지 않는다.
 */
function makeRunTurn(acc: Account, log: (m: string) => void): RunTurn {
  return async (req) => {
    if (!runtime) throw new Error('plugin runtime not ready');
    const rt = runtime;
    const started = Date.now();
    let selected: { provider: string; model: string } | undefined;
    log(`brainstorm: turn start key=${req.sessionKey} run=${req.runId}`);
    const res = await rt.agent.runCommandFromIngress(
      {
        message: req.prompt,
        agentId: req.ocAgentId,
        sessionKey: req.sessionKey,
        runId: `bs-${req.runId}`,
        messageChannel: CHANNEL,
        messageProvider: CHANNEL,
        deliver: false,
        allowModelOverride: false,
        disableMessageTool: true,
        // 스레드마다 claude 프로세스가 상주하지 않게: 턴이 끝나면 내리고, 다음 턴은 --resume 으로 잇는다
        cleanupCliLiveSessionOnRunEnd: true,
        abortSignal: req.signal,
        ...(acc.turnTimeoutMs ? { timeout: String(Math.ceil(acc.turnTimeoutMs / 1000)) } : {}),
        onActiveModelSelected: (m: { provider: string; model: string }) => {
          selected = m;
        },
      } as any,
      quietEnv as any,
    );
    const agentMeta = res.meta?.agentMeta;
    const payloads = (res.payloads ?? []) as Array<{ text?: string; isError?: boolean; isReasoning?: boolean; isCommentary?: boolean }>;
    const visible = payloads.filter((p) => !p.isReasoning && !p.isCommentary && typeof p.text === 'string' && p.text);
    const ok = visible.filter((p) => !p.isError).map((p) => p.text as string);
    const errs = visible.filter((p) => p.isError).map((p) => p.text as string);
    const text = ok.length ? ok.join('\n\n') : (res.meta?.finalAssistantVisibleText ?? '');
    if (!text && errs.length) throw new Error(errs.join(' / ').slice(0, 500));
    if (!text && res.meta?.error) throw new Error(`${res.meta.error.kind}: ${res.meta.error.message}`.slice(0, 500));
    // 실제 값: 실행 메타가 우선, 없으면 모델 선택 콜백(대체 포함)에서 읽은 값. 설정값으로 채우지 않는다
    const provider = agentMeta?.provider ?? selected?.provider;
    const model = agentMeta?.model ?? selected?.model;
    const trace = res.meta?.executionTrace;
    // 하네스 id 가 없으면 실행 추적의 runner(cli/embedded)와 이긴 공급자로 적는다 — 예: cli:claude-cli
    const harness = agentMeta?.agentHarnessId ?? (trace?.runner ? `${trace.runner}:${trace.winnerProvider ?? provider ?? '?'}` : undefined);
    const cred = agentMeta?.credentialSource as { kind?: string } | undefined;
    const out: TurnResult = {
      text,
      aborted: res.meta?.aborted === true,
      meta: { provider, model, agentHarnessId: harness, sessionId: agentMeta?.sessionId },
      durationMs: res.meta?.durationMs ?? Date.now() - started,
      usage: agentMeta?.usage ?? null,
      extra: {
        runner: trace?.runner ?? null,
        winner: trace?.winnerProvider ? `${trace.winnerProvider}/${trace.winnerModel ?? '?'}` : null,
        fallback_used: trace?.fallbackUsed ?? false,
        fallback_attempts: agentMeta?.fallbackAttempts?.length ?? 0,
        auth_mode: res.meta?.requestShaping?.authMode ?? null,
        credential_kind: cred?.kind ?? null,
      },
    };
    log(
      `brainstorm: turn end key=${req.sessionKey} session=${agentMeta?.sessionId ?? '?'} aborted=${out.aborted} harness=${harness ?? '?'} fallback=${trace?.fallbackUsed ?? false} auth=${res.meta?.requestShaping?.authMode ?? '?'} model=${provider ?? '?'}/${model ?? '?'} ms=${out.durationMs}`,
    );
    return out;
  };
}

/**
 * 재실행 금지 가드. OpenClaw 는 재시작 때 «running» 으로 남은 세션을 스스로 이어 돈다(restart recovery).
 * brainStorm 쪽 실행은 이미 lease 만료로 unknown 이 되어야 하고 다시 돌면 안 된다 —
 * 이 채널의 세션(`agent:<id>:bs:`)만 골라 중단 표시를 거둔다. 다른 세션은 건드리지 않는다.
 */
async function disarmRestartRecovery(agentId: string, log: (m: string) => void, warn: (m: string) => void) {
  if (!runtime) return;
  const prefix = `agent:${agentId}:bs:`;
  const s = runtime.agent.session;
  for (const { sessionKey, entry } of s.listSessionEntries({ agentId })) {
    if (!sessionKey.startsWith(prefix)) continue;
    const e = entry as any;
    if (e.status !== 'running' && e.abortedLastRun !== true && e.mainRestartRecovery === undefined) continue;
    try {
      await s.patchSessionEntry({
        agentId,
        sessionKey,
        update: () => ({ status: 'failed', abortedLastRun: false, mainRestartRecovery: undefined }) as any,
      });
      log(`brainstorm: 재시작 뒤 이어 돌기 막음 key=${sessionKey} (brainStorm 쪽 run 은 unknown 으로 남는다)`);
    } catch (err) {
      warn(`brainstorm: 이어 돌기 막기 실패 key=${sessionKey} ${redact((err as Error).message)}`);
    }
  }
}

const plugin: ChannelPlugin<Account> = {
  id: CHANNEL,
  meta: {
    id: CHANNEL,
    label: 'brainStorm',
    selectionLabel: 'brainStorm (자체 대화 채널)',
    docsPath: '/channels/brainstorm',
    blurb: 'brainStorm 스레드의 전달을 받아 답한다 (나가는 연결만).',
  },
  capabilities: { chatTypes: ['group'] },
  reload: { configPrefixes: [`channels.${CHANNEL}`] },
  config: {
    listAccountIds: () => ['default'],
    resolveAccount,
    defaultAccountId: () => 'default',
    inspectAccount(cfg) {
      const a = resolveAccount(cfg);
      const configured = !!(a.url && a.tokenFile);
      return { enabled: a.enabled, configured, tokenStatus: a.tokenFile ? 'file' : 'missing' };
    },
    isEnabled: (a) => a.enabled,
    isConfigured: (a) => !!(a.url && a.tokenFile),
    unconfiguredReason: () => 'channels.brainstorm.url 과 tokenFile 이 필요하다',
  },
  gateway: {
    async startAccount(ctx) {
      const acc = ctx.account;
      const log = (m: string) => ctx.log?.info?.(m);
      if (!acc.enabled) return;
      if (!acc.url || !acc.tokenFile) {
        ctx.log?.warn?.('brainstorm: url/tokenFile 없음 — 시작하지 않는다');
        return;
      }
      await disarmRestartRecovery(acc.agentId, log, (m) => ctx.log?.warn?.(m));
      const token = readToken(acc.tokenFile);
      const worker = new BrainstormWorker({
        url: acc.url,
        token,
        worker: acc.worker,
        ocAgentId: acc.agentId,
        configVersion: `openclaw-${runtime?.version ?? '?'}+brainstorm-${PLUGIN_VERSION}`,
        runTurn: makeRunTurn(acc, log),
        pollMs: acc.pollMs,
        log: {
          info: (m) => ctx.log?.info?.(redact(m)),
          warn: (m) => ctx.log?.warn?.(redact(m)),
          error: (m) => ctx.log?.error?.(redact(m)),
        },
      });
      const me = await worker.whoami();
      ctx.log?.info?.(`brainstorm: 연결 ${acc.url} participant=${me.id} agent=${acc.agentId}`);
      ctx.setStatus({ ...ctx.getStatus(), running: true, connected: true, lastStartAt: Date.now() } as any);
      try {
        await worker.loop(ctx.abortSignal);
      } finally {
        ctx.setStatus({ ...ctx.getStatus(), running: false, connected: false, lastStopAt: Date.now() } as any);
      }
    },
  },
};

export default defineChannelPluginEntry({
  id: CHANNEL,
  name: 'brainStorm',
  description: 'brainStorm 자체 대화 채널 어댑터 (나가는 연결, 한 번에 한 턴)',
  plugin,
  setRuntime(rt: PluginRuntime) {
    runtime = rt;
  },
});

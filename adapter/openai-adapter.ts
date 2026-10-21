#!/usr/bin/env node
// OpenAI 호환 어댑터 — brainStorm 에이전트 참여자 하나를 OpenAI 호환 `/v1/chat/completions` 서버에 붙인다.
// (llama.cpp server · vLLM · Ollama 의 /v1 · OpenAI 등. 특정 모델 이름을 코드에 박지 않는다.)
//
//   node dist/adapter/openai-adapter.js [run|check] [인자]     — 인자는 --help
//
// 하는 일: claim → ACK → start → 세대 맥락을 chat messages 로 → chat completions(스트리밍) → complete / fail.
// 맥락·역할·예산 규칙은 adapter/openai/mapping.ts, 프로토콜 규칙은 adapter/openai/worker.ts 머리말.
import os from 'node:os';
import { ConfigError, HELP, loadAdapterConfig } from './openai/config.js';
import { redactSecrets } from './openai/mapping.js';
import { OpenAIWorker } from './openai/worker.js';

const ts = () => new Date().toISOString();
const log = {
  info: (m: string) => console.log(ts(), m),
  warn: (m: string) => console.warn(ts(), 'WARN', m),
  error: (m: string) => console.error(ts(), 'ERROR', m),
};

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  const cmd = args[0] && !args[0].startsWith('--') ? args[0] : 'run';
  let cfg;
  try {
    cfg = loadAdapterConfig(args, process.env, os.hostname());
  } catch (e) {
    if (e instanceof ConfigError) {
      log.error(`설정: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const worker = new OpenAIWorker({ ...cfg, log });
  const hide = (s: string) => redactSecrets(s, [cfg.token, cfg.openaiApiKey]);

  if (cmd === 'check') {
    let rc = 0;
    try {
      const me = await worker.whoami();
      log.info(`brainStorm: participant=${me.id} kind=${me.kind}`);
      if (me.kind !== 'agent') rc = 2;
    } catch (e) {
      log.error(`brainStorm: ${hide((e as Error).message)}`);
      rc = 4;
    }
    try {
      const res = await fetch(cfg.openaiBaseUrl + '/models', {
        headers: cfg.openaiApiKey ? { Authorization: `Bearer ${cfg.openaiApiKey}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      const j: any = await res.json().catch(() => null);
      const ids = Array.isArray(j?.data) ? j.data.map((m: any) => m?.id).filter(Boolean) : [];
      log.info(`LLM: GET /models → ${res.status} models=${ids.slice(0, 10).join(',') || '?'}`);
      if (ids.length && !ids.includes(cfg.model)) log.warn(`LLM: 설정한 모델 «${cfg.model}» 이 목록에 없다 (서버가 이름을 무시하면 괜찮다)`);
      if (!res.ok) rc = rc || 3;
    } catch (e) {
      log.error(`LLM: ${hide((e as Error).message)}`);
      rc = rc || 3;
    }
    return rc;
  }
  if (cmd !== 'run') {
    console.error(HELP);
    return 2;
  }

  const ac = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const)
    process.once(sig, () => {
      log.info(`${sig} — 도는 턴이 있으면 끊고(fail) 멈춘다`);
      ac.abort();
    });
  try {
    const me = await worker.whoami();
    if (me.kind !== 'agent') {
      log.error(`토큰이 에이전트가 아니다(participant=${me.id} kind=${me.kind})`);
      return 2;
    }
    log.info(`연결 ${cfg.url} participant=${me.id} worker=${cfg.worker} model=${cfg.model} stream=${cfg.stream} ctx=${cfg.contextTokens} max=${cfg.maxTokens}`);
  } catch (e) {
    const msg = hide((e as Error).message);
    log.error(`brainStorm 신원 확인 실패: ${msg}`);
    return /HTTP 40[13]/.test(msg) ? 4 : 1;
  }
  const r = await worker.loop(ac.signal);
  return r === 'auth' ? 4 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    log.error(String((e as Error)?.stack ?? e));
    process.exit(1);
  },
);

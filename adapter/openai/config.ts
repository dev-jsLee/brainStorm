// OpenAI 호환 어댑터 설정 — 환경변수와 인자에서 읽는다. 비밀은 원문 대신 파일 경로로 받는다.
import fs from 'node:fs';
import path from 'node:path';
import { HANDOFF_RULE, PULL_RULE } from '../../src/protocol.js';
import { DEFAULT_SYSTEM_PROMPT } from './mapping.js';
import type { OpenAIWorkerOptions } from './worker.js';

export class ConfigError extends Error {}

/**
 * 비밀 파일 읽기. 그룹·기타 권한이 있으면 거절한다(600·400 만) — openclaw-channel 의 tokenFile 규칙과 같다.
 * systemd LoadCredential 로 넘어온 파일($CREDENTIALS_DIRECTORY 아래)도 400 이라 그대로 통과한다.
 */
export function readSecretFile(file: string, what: string, opts: { trustedDir?: string } = {}): string {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new ConfigError(`${what} 파일이 없다: ${file}`);
  }
  if (!st.isFile()) throw new ConfigError(`${what} 경로가 파일이 아니다: ${file}`);
  // systemd 자격 증명 디렉터리는 서비스 계정 전용(ramfs)이다 — 소유권 대신 ACL 을 쓰는 경우가 있어 모드 검사를 건너뛴다
  const trusted = !!opts.trustedDir && path.resolve(path.dirname(file)) === path.resolve(opts.trustedDir);
  if (!trusted && (st.mode & 0o077) !== 0) throw new ConfigError(`${what} 파일 권한이 넓다(${(st.mode & 0o777).toString(8)}) — chmod 600 ${file}`);
  const v = fs.readFileSync(file, 'utf8').trim();
  if (!v) throw new ConfigError(`${what} 파일이 비었다: ${file}`);
  return v;
}

type Env = Record<string, string | undefined>;

function argv(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function num(v: string | undefined, name: string, dflt: number, min = 1): number {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new ConfigError(`${name} 값이 잘못됐다: ${v}`);
  return n;
}

export const HELP = `openai-adapter — brainStorm 에이전트를 OpenAI 호환 /v1/chat/completions 에 붙인다

  node dist/adapter/openai-adapter.js [run] [인자]
  node dist/adapter/openai-adapter.js check      설정·brainStorm 신원·LLM /models 만 확인하고 끝낸다

인자 (같은 이름의 환경변수도 된다. 인자가 이긴다)
  --url URL                 BRAINSTORM_URL            brainStorm 서버 (기본 http://127.0.0.1:8080)
  --token-file F            BRAINSTORM_TOKEN_FILE     참여자 토큰 파일(600). 없으면 $CREDENTIALS_DIRECTORY/brainstorm-token
  --worker W                BRAINSTORM_WORKER         작업자 이름(기록용, 기본 openai-<호스트>)
  --base-url URL            OPENAI_BASE_URL           예: http://127.0.0.1:8000/v1 (필수)
  --api-key-file F          OPENAI_API_KEY_FILE       API 키 파일(600). 없으면 OPENAI_API_KEY, 그것도 없으면
                                                      $CREDENTIALS_DIRECTORY/openai-api-key, 그것도 없으면 키 없이
  --model M                 OPENAI_MODEL              모델 이름 (필수)
  --system-prompt-file F    OPENAI_SYSTEM_PROMPT_FILE 시스템 프롬프트 파일. 없으면 OPENAI_SYSTEM_PROMPT, 없으면 기본 문구
  --handoff-rule            BRAINSTORM_HANDOFF_RULE   넘김·끌어오기 규약 두 줄(«→ 이름» · «← 스레드» 끝줄)을 시스템 프롬프트에 붙인다 (기본 끔 —
                                                      로컬 모델은 끝줄을 남발할 수 있다. 참여자별로 켠다: 메티 켬 · Strata 끔)
  --max-tokens N            OPENAI_MAX_TOKENS         답 최대 토큰 (기본 2048)
  --context-tokens N        OPENAI_CONTEXT_TOKENS     모델 컨텍스트 크기 (기본 32768) — 맥락을 이 안에 맞춘다
  --temperature X           OPENAI_TEMPERATURE        (기본: 보내지 않음 = 서버 기본값)
  --timeout-ms N            OPENAI_TIMEOUT_MS         한 턴 상한 (기본 600000)
  --no-stream               OPENAI_STREAM=0           스트리밍 끄기
  --vision                  OPENAI_VISION=1           그림 첨부를 image_url 로 넘긴다 (기본 끔 — 모델이 그림을 받을 때만 켠다.
                                                      끄면 그림은 이름·크기만 알린다)
  --attach-text-max N       OPENAI_ATTACH_TEXT_MAX    텍스트 첨부를 본문에 넣는 최대 글자 수 (기본 20000 · 0 = 넣지 않음)
  --poll-ms N               BRAINSTORM_POLL_MS        전달 확인 주기 (기본 1500)
  --heartbeat-ms N          BRAINSTORM_HEARTBEAT_MS   실행 중 heartbeat 주기 (기본 5000)

종료 코드: 0 정상 종료(SIGTERM) · 2 설정 오류 · 4 인증 거절(재시작해도 소용없음)`;

export type AdapterConfig = Omit<OpenAIWorkerOptions, 'log' | 'fetchImpl'>;

export function loadAdapterConfig(args: string[], env: Env, hostname = 'host'): AdapterConfig {
  const pick = (flag: string, key: string) => argv(args, flag) ?? env[key];
  const cred = env.CREDENTIALS_DIRECTORY;

  const tokenFile = pick('--token-file', 'BRAINSTORM_TOKEN_FILE') ?? (cred ? path.join(cred, 'brainstorm-token') : undefined);
  if (!tokenFile) throw new ConfigError('참여자 토큰 파일이 없다: --token-file 또는 BRAINSTORM_TOKEN_FILE');
  const token = readSecretFile(tokenFile, '참여자 토큰', { trustedDir: cred });

  let apiKey: string | undefined;
  const keyFile = pick('--api-key-file', 'OPENAI_API_KEY_FILE');
  if (keyFile) apiKey = readSecretFile(keyFile, 'API 키', { trustedDir: cred });
  else if (env.OPENAI_API_KEY) apiKey = env.OPENAI_API_KEY.trim() || undefined;
  else if (cred && fs.existsSync(path.join(cred, 'openai-api-key'))) apiKey = readSecretFile(path.join(cred, 'openai-api-key'), 'API 키', { trustedDir: cred });

  const baseUrl = pick('--base-url', 'OPENAI_BASE_URL');
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new ConfigError('OPENAI_BASE_URL(--base-url) 이 필요하다 — 예: http://127.0.0.1:8000/v1');
  const model = pick('--model', 'OPENAI_MODEL');
  if (!model) throw new ConfigError('OPENAI_MODEL(--model) 이 필요하다');

  let systemPrompt = DEFAULT_SYSTEM_PROMPT;
  const spFile = pick('--system-prompt-file', 'OPENAI_SYSTEM_PROMPT_FILE');
  if (spFile) {
    try {
      systemPrompt = fs.readFileSync(spFile, 'utf8');
    } catch {
      throw new ConfigError(`시스템 프롬프트 파일을 못 읽었다: ${spFile}`);
    }
  } else if (env.OPENAI_SYSTEM_PROMPT !== undefined) systemPrompt = env.OPENAI_SYSTEM_PROMPT.replace(/\\n/g, '\n');

  const hr = env.BRAINSTORM_HANDOFF_RULE;
  if (args.includes('--handoff-rule') || (hr !== undefined && /^(1|true|yes|on)$/i.test(hr))) systemPrompt = `${systemPrompt.trimEnd()}\n${HANDOFF_RULE}\n${PULL_RULE}`;

  const maxTokens = num(pick('--max-tokens', 'OPENAI_MAX_TOKENS'), 'max-tokens', 2048);
  const contextTokens = num(pick('--context-tokens', 'OPENAI_CONTEXT_TOKENS'), 'context-tokens', 32768);
  if (maxTokens >= contextTokens) throw new ConfigError('max-tokens 가 context-tokens 보다 작아야 한다');
  const t = pick('--temperature', 'OPENAI_TEMPERATURE');
  const temperature = t === undefined || t === '' ? undefined : num(t, 'temperature', 0, 0);
  const streamEnv = env.OPENAI_STREAM;
  const stream = !args.includes('--no-stream') && !(streamEnv !== undefined && /^(0|false|no|off)$/i.test(streamEnv));

  const v = env.OPENAI_VISION;
  const vision = args.includes('--vision') || (v !== undefined && /^(1|true|yes|on)$/i.test(v));
  const attachTextMax = num(pick('--attach-text-max', 'OPENAI_ATTACH_TEXT_MAX'), 'attach-text-max', 20_000, 0);

  const url = (pick('--url', 'BRAINSTORM_URL') ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
  return {
    url,
    token,
    worker: (pick('--worker', 'BRAINSTORM_WORKER') ?? `openai-${hostname}`).slice(0, 100),
    openaiBaseUrl: baseUrl.replace(/\/+$/, ''),
    openaiApiKey: apiKey,
    model,
    systemPrompt,
    maxTokens,
    contextTokens,
    temperature,
    timeoutMs: num(pick('--timeout-ms', 'OPENAI_TIMEOUT_MS'), 'timeout-ms', 600_000),
    stream,
    vision,
    attachTextMax,
    pollMs: num(pick('--poll-ms', 'BRAINSTORM_POLL_MS'), 'poll-ms', 1500),
    heartbeatMs: num(pick('--heartbeat-ms', 'BRAINSTORM_HEARTBEAT_MS'), 'heartbeat-ms', 5000),
  };
}

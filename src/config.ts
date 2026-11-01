// 설정은 전부 환경 변수로 받는다. 배포에서는 /etc/brainstorm/brainstorm.env 가 채운다.
import { parseModules } from './modules.js';
import path from 'node:path';

export interface Config {
  dataDir: string;
  dbPath: string;
  attachmentsDir: string;
  backupsDir: string;
  /** "host:port" 목록. 첫 번째가 주 리스너. */
  listen: { host: string; port: number }[];
  /** 쿠키 인증 요청과 WebSocket이 허용하는 Origin 목록 */
  origins: string[];
  /** 'auto' = 요청이 https일 때만 Secure. 'always' | 'never' */
  secureCookie: 'auto' | 'always' | 'never';
  bodyMaxChars: number;
  attachmentMaxBytes: number;
  /** 한 메시지에 묶는 첨부 최대 개수 */
  attachmentMaxPerMessage: number;
  /** 메시지에 묶이지 않은 업로드가 걷히기까지(밀리초) */
  uploadTtlMs: number;
  /** 한 참여자가 묶지 않고 쥐고 있을 수 있는 업로드 수 */
  maxPendingUploads: number;
  httpBodyLimit: number;
  deliveryLeaseMs: number;
  runLeaseMs: number;
  /** 실행 중 취소 요청 뒤 어댑터의 중단 확인·완료를 기다리는 시간. 넘으면 unknown(정책 1 «무응답 제한») */
  cancelAckMs: number;
  retryBaseMs: number;
  /** 감사 기록 묶음 시간: 같은 (작업자, 작업 유형, 결과, 사유)의 거부·조회가 이 안에 또 오면 새 행 대신 횟수만 올린다 */
  auditGroupMs: number;
  maxDeliveryAttempts: number;
  defaultCallBudget: number;
  /** 끌어오기 한 번의 글 수 상한(안전판 — 실제 크기 판정은 받는 쪽 예산 거울) */
  pullMaxMessages: number;
  /** 자동 세션 교체 기준(마스터 #283 A) — 맥락 토큰 · 답 수(0 이면 그 기준 끔) · 새 세대가 원문으로 이어받는 최근 글 수 */
  rotateTokens: number;
  rotateReplies: number;
  carryMessages: number;
  /** 옛 대화를 읽는 길 안내 — 비면 사전 기본 문구. `{note}` 자리에 원문 사본 이름 */
  carryHint: string;
  maxCallBudget: number;
  /** 요청 연쇄 상한(마스터 #352) — 스레드의 마지막 마스터 글 뒤 요청 글이 이 수에 닿으면 다음 요청은 만들지 않고 «마스터 확인 필요»로 남긴다 */
  requestChainMax: number;
  sweepIntervalMs: number;
  wsRevalidateMs: number;
  webSessionDays: number;
  logLevel: string;
  /** «전체» 칩에서 빠지는 참여자 — 이름을 골라 불러야만 깨는 에이전트(사서 · #200). 콤마로 가름 */
  onCallOnly: string[];
  /** 대면 모드(마스터 #581): 초안 쪽 · 검토 쪽 · 기본 턴(2왕복) · 상한 턴 */
  faceDrafter: string;
  faceReviewer: string;
  faceBaseTurns: number;
  faceMaxTurns: number;
  /** 기본 언어(마스터 #823) — 마스터가 화면에서 언어를 고르기 전까지 서버 안내·에이전트 규약이 쓰는 언어. 고르면 DB(meta `lang`)가 앞선다 */
  lang: string;
  /** 켠 선택 모듈(마스터 #1193 · docs/MODULES.md) — BRAINSTORM_MODULES · 비면 core 만 */
  modules: string[];
}

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export function parseListen(s: string): { host: string; port: number }[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.lastIndexOf(':');
      if (i < 0) throw new Error(`bad listen entry: ${x}`);
      return { host: x.slice(0, i), port: Number(x.slice(i + 1)) };
    });
}

/** 루프백 주소인가(127.0.0.0/8 · ::1 · localhost) */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * 외부 공개는 기본으로 꺼져 있다(마스터 #1175). 루프백 밖 주소를 들으려면 BRAINSTORM_ALLOW_EXTERNAL=1 을 같이 둔다.
 * 밖에서 쓰는 배선(VPN·리버스 프록시·인증 앞단)은 docs/EXTERNAL-ACCESS.md — 에이전트가 사용자에게 묻고 붙인다.
 */
export function assertListenAllowed(listen: { host: string }[], env: NodeJS.ProcessEnv = process.env): void {
  const outside = listen.filter((l) => !isLoopback(l.host)).map((l) => l.host);
  if (!outside.length) return;
  if (/^(1|true|yes|on)$/i.test(env.BRAINSTORM_ALLOW_EXTERNAL ?? '')) return;
  throw new Error(
    `BRAINSTORM_LISTEN 에 루프백 밖 주소(${outside.join(', ')})가 있다 — 외부 공개는 기본으로 꺼져 있다. ` +
      '열려면 BRAINSTORM_ALLOW_EXTERNAL=1 을 함께 두고 docs/EXTERNAL-ACCESS.md 를 따른다.',
  );
}

export function loadConfig(over: Partial<Config> = {}): Config {
  const dataDir = over.dataDir ?? process.env.BRAINSTORM_DATA_DIR ?? path.resolve('data');
  const listen = parseListen(process.env.BRAINSTORM_LISTEN ?? '127.0.0.1:8080');
  const origins = (process.env.BRAINSTORM_ORIGINS ?? listen.map((l) => `http://${l.host}:${l.port}`).join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const cfg: Config = {
    dataDir,
    dbPath: path.join(dataDir, 'brainstorm.db'),
    attachmentsDir: path.join(dataDir, 'attachments'),
    backupsDir: path.join(dataDir, 'backups'),
    listen,
    origins,
    secureCookie: (process.env.BRAINSTORM_SECURE_COOKIE as Config['secureCookie']) ?? 'auto',
    bodyMaxChars: int('BRAINSTORM_BODY_MAX_CHARS', 32_000),
    attachmentMaxBytes: int('BRAINSTORM_ATTACHMENT_MAX_BYTES', 20 * 1024 * 1024),
    attachmentMaxPerMessage: int('BRAINSTORM_ATTACHMENT_MAX_PER_MESSAGE', 5),
    uploadTtlMs: int('BRAINSTORM_UPLOAD_TTL_MS', 24 * 3600 * 1000),
    maxPendingUploads: int('BRAINSTORM_MAX_PENDING_UPLOADS', 30),
    httpBodyLimit: int('BRAINSTORM_HTTP_BODY_LIMIT', 256 * 1024),
    deliveryLeaseMs: int('BRAINSTORM_DELIVERY_LEASE_MS', 30_000),
    runLeaseMs: int('BRAINSTORM_RUN_LEASE_MS', 60_000),
    cancelAckMs: int('BRAINSTORM_CANCEL_ACK_MS', 30_000),
    retryBaseMs: int('BRAINSTORM_RETRY_BASE_MS', 2_000),
    auditGroupMs: int('BRAINSTORM_AUDIT_GROUP_MS', 60_000),
    maxDeliveryAttempts: int('BRAINSTORM_MAX_DELIVERY_ATTEMPTS', 5),
    defaultCallBudget: int('BRAINSTORM_DEFAULT_CALL_BUDGET', 3),
    pullMaxMessages: int('BRAINSTORM_PULL_MAX_MESSAGES', 50),
    rotateTokens: int('BRAINSTORM_ROTATE_TOKENS', 150_000),
    rotateReplies: int('BRAINSTORM_ROTATE_REPLIES', 10),
    carryMessages: int('BRAINSTORM_CARRY_MESSAGES', 12),
    carryHint: process.env.BRAINSTORM_CARRY_HINT ?? '',
    maxCallBudget: int('BRAINSTORM_MAX_CALL_BUDGET', 10),
    requestChainMax: int('BRAINSTORM_REQUEST_CHAIN_MAX', 6),
    sweepIntervalMs: int('BRAINSTORM_SWEEP_INTERVAL_MS', 1_000),
    wsRevalidateMs: int('BRAINSTORM_WS_REVALIDATE_MS', 5_000),
    webSessionDays: int('BRAINSTORM_WEB_SESSION_DAYS', 30),
    logLevel: process.env.BRAINSTORM_LOG_LEVEL ?? 'info',
    onCallOnly: (process.env.BRAINSTORM_ON_CALL_ONLY ?? 'librarian').split(',').map((x) => x.trim()).filter(Boolean),
    faceDrafter: process.env.BRAINSTORM_FACE_DRAFTER || '',
    faceReviewer: process.env.BRAINSTORM_FACE_REVIEWER || '',
    faceBaseTurns: int('BRAINSTORM_FACE_BASE_TURNS', 4),
    faceMaxTurns: int('BRAINSTORM_FACE_MAX_TURNS', 6),
    lang: process.env.BRAINSTORM_LANG || 'ko',
    modules: parseModules(process.env.BRAINSTORM_MODULES),
  };
  const merged = { ...cfg, ...over };
  if (over.dataDir) {
    merged.dbPath = over.dbPath ?? path.join(over.dataDir, 'brainstorm.db');
    merged.attachmentsDir = over.attachmentsDir ?? path.join(over.dataDir, 'attachments');
    merged.backupsDir = over.backupsDir ?? path.join(over.dataDir, 'backups');
  }
  return merged;
}

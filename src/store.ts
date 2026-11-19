// 규칙은 전부 여기 있다. HTTP 계층·CLI·시험이 같은 함수를 부른다.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { hashPassphrase, newId, randomToken, sha256, verifyPassphrase } from './crypto.js';
import {
  INPUT_MODES,
  type AgentConnection,
  type AuditActorKind,
  type AuditEntry,
  type AuditResult,
  type CredentialInfo,
  ROOM_TITLE,
  SOURCE_KINDS,
  THREAD_STATE_ACTIONS,
  type ThreadStateAction,
  type AgentSession,
  type AgentStatus,
  type AttachmentInfo,
  type CancelOutcome,
  type CancelResult,
  type ClaimSession,
  type InputMode,
  type Message,
  type MergeInfo,
  type Participant,
  type ParticipantKind,
  type Run,
  type RunEvent,
  type RunState,
  type SourceKind,
  type ClaimForward,
  type ClaimPulled,
  type ClaimCarry,
  type PullRequest,
  type PulledMessage,
  estimateTokens,
  type Thread,
  type WsNotice,
  CLAIM_KINDS,
  DELEGATION_CLOSED,
  DELEGATION_STATUSES,
  VERSION_SLOTS,
  type ClaimConflict,
  type ClaimInput,
  type ClaimKind,
  type Delegation,
  type DelegationClaim,
  type DelegationStatus,
  type VersionSlot,
  type RequestHold,
  type RequestPair,
  type ClaimHoldNotice,
  ANSWER_STAMP_RE,
  stripAnswerStamp,
  type ClaimFace,
  type FaceIssue,
  type FaceRev,
  type FaceRound,
  type FaceState,
  type ThreadMode,
} from './protocol.js';
import { DEFAULT_LANG, dictionaries, languages, normLang, protocolWords, t as tr } from './i18n.js';
import type { FaceStore } from './modules/face/store.js';
import type { MergeStore } from './modules/merge/store.js';
import type { QuestionStore } from './modules/questions/store.js';
import { TagStore } from './tagstore.js';
import { parseHold, parseRequest, toHold, type RequestStore } from './modules/requests/store.js';
import type { DelegationStore } from './modules/delegations/store.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    /** 응답 본문에 더 싣는 칸(예: 409 claim_conflict 의 conflicts) */
    public extra?: Record<string, unknown>,
    /** 번역 키·값(마스터 #823) — 오류 처리기가 요청 언어로 message 를 다시 쓴다. 없으면 `err.<code>` 가 사전에 있을 때만 */
    public i18n?: { key: string; vars?: Record<string, unknown> },
  ) {
    super(message ?? code);
  }
}

export interface Principal {
  participant: Participant;
  via: 'cookie' | 'token';
  credentialId?: string;
  scopes: string[];
  /** 감사 기록의 작업자를 덮어쓴다 — 관리 CLI 는 마스터 권한으로 돌지만 작업자는 'cli:root' 다 */
  actor?: AuditActor;
}

export interface AuditActor {
  id: string;
  kind: AuditActorKind;
}
/** CT 안 관리 CLI(root). 토큰 발급·폐기·참여자 등록은 이 길로만 한다(마스터 결정 2) */
export const CLI_ACTOR: AuditActor = { id: 'cli:root', kind: 'cli' };
export const SERVER_ACTOR: AuditActor = { id: 'server', kind: 'server' };
export const ANON_ACTOR: AuditActor = { id: 'anonymous', kind: 'anonymous' };

export interface AuditInput {
  actor: AuditActor;
  action: string;
  result: AuditResult;
  target_type?: string | null;
  target_id?: string | null;
  thread_id?: string | null;
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  requested_at?: number;
  processed_at?: number;
  /** 같은 감사 식별자로 이을 때(최종 결과 행) */
  corr_id?: string;
  /** 묶음 시간 안의 같은 (작업자, 작업 유형, 결과, 사유)는 횟수만 올린다 — 거부·조회 폭주 상한 */
  group?: boolean;
}

export interface NoticeEvent {
  notice: WsNotice;
  /** null = 스레드에 안 묶인 알림(위임 대장) — 인증된 연결 모두에게 */
  threadId: string | null;
  /** 지정되면 이 참여자에게만 */
  only?: string;
}

export interface PostInput {
  client_key?: unknown;
  body?: unknown;
  author_id?: unknown;
  source_kind?: unknown;
  input_mode?: unknown;
  reply_to_seq?: unknown;
  quote_of_seq?: unknown;
  recipients?: unknown;
  call_budget?: unknown;
  /** 먼저 올린 업로드 id 들 — 이 메시지에 묶는다 */
  attachments?: unknown;
  /** 태그 보기(마이그레이션 19): 보기에서 자동으로 붙는 주 태그(id 또는 이름 · ≤2) — 본문 첫 줄의 태그 줄과 합친다 */
  tags?: unknown;
}

export interface UploadInfo {
  id: string;
  name: string;
  kind: string;
  mime: string;
  size: number;
}

const IMAGE_MIME: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], 'image/gif'],
  [[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 'image/gif'],
];

/**
 * 첨부 형식은 내용으로 가른다(파일 이름·브라우저가 준 형식은 믿지 않는다).
 * image = PNG·JPEG·GIF·WebP 만(미리보기로 내보내는 것) · pdf · text = NUL 없는 UTF-8(앞 64KB) · 그 밖 file.
 * SVG 는 글자다 — 스크립트를 품을 수 있어 그림으로 내보내지 않는다.
 */
export function sniffAttachment(data: Buffer): { kind: 'image' | 'pdf' | 'text' | 'file'; mime: string } {
  for (const [sig, mime] of IMAGE_MIME) if (data.length >= sig.length && sig.every((x, i) => data[i] === x)) return { kind: 'image', mime };
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (data.toString('latin1', 0, 5) === '%PDF-') return { kind: 'pdf', mime: 'application/pdf' };
  const head = data.subarray(0, 64 * 1024);
  if (!head.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true }); // stream: 끝에서 잘린 글자는 오류가 아니다
      return { kind: 'text', mime: 'text/plain; charset=utf-8' };
    } catch {}
  }
  return { kind: 'file', mime: 'application/octet-stream' };
}

function safeFileName(name: string): string {
  return (name || 'file').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'file';
}

export type Row = Record<string, any>;

export const now = () => Date.now();

function toParticipant(r: Row): Participant {
  return r.disabled_at ? { id: r.id, kind: r.kind, name: r.name, is_master: !!r.is_master, disabled: true } : { id: r.id, kind: r.kind, name: r.name, is_master: !!r.is_master };
}

function toThread(r: Row): Thread {
  return {
    id: r.id,
    kind: r.kind === 'room' ? 'room' : 'thread',
    title: r.title,
    status: r.status,
    default_recipient: r.default_recipient,
    parent_thread_id: r.parent_thread_id,
    fork_seq: r.fork_seq,
    invoke_paused: !!r.invoke_paused,
    hidden: !!r.hidden,
    deleted_at: r.deleted_at ?? null,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last_seq: r.last_seq ?? null,
    mode: r.mode === 'face' ? 'face' : 'chat',
  };
}

/** 합침 묶음을 에이전트에게 펼칠 때의 출처 이름 · 길이 상한(넘으면 앞 글부터 덜어 냄) */
export function toMessage(r: Row): Message {
  return {
    seq: r.seq,
    id: r.id,
    thread_id: r.thread_id,
    author_id: r.author_id,
    client_key: r.client_key,
    body: r.body,
    body_version: r.body_version,
    reply_to_seq: r.reply_to_seq,
    quote_of_seq: r.quote_of_seq,
    source_kind: r.source_kind,
    input_mode: r.input_mode,
    recipients: JSON.parse(r.recipients),
    call_budget: r.call_budget,
    hop: r.hop,
    trigger_run_id: r.trigger_run_id,
    created_at: r.created_at,
    handoff_to: r.handoff_to ? JSON.parse(r.handoff_to) : [],
    pull_req: r.pull_req ? JSON.parse(r.pull_req) : null,
  };
}

/**
 * 끝줄 신호를 읽을 자리: 마지막 비어 있지 않은 줄의 번호. 끝에 붙은 `답변시각:` 도장 줄(Claude Code 훅 · 값 유무 무관)과
 * 그 앞의 빈 줄·구분선은 건너뛴다 — 도장이 «보류:»·«요청→»·«→ 이름»·«← 스레드»를 묻지 않게(정규식은 protocol 의 ANSWER_STAMP_RE 하나)
 */
export function signalTail(body: string): { lines: string[]; i: number } {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let i = lines.length - 1;
  for (;;) {
    while (i >= 0 && !lines[i].trim()) i--;
    if (i < 0 || !ANSWER_STAMP_RE.test(lines[i])) break;
    i--;
    while (i >= 0 && /^\s*(?:-{3,}|\*{3,}|_{3,})?\s*$/.test(lines[i])) i--;
  }
  return { lines, i };
}

/**
 * 끌어오기 신호(2026-10-13 마스터 #162): 답의 마지막 비어 있지 않은 줄이 `← 스레드제목`·`← 스레드제목 #a~#b`·`← #a~#b`·`← #a`
 * (또는 `<-`)이면 그 스레드를 후보(작성자가 읽을 수 있는 다른 스레드)에서 찾는다. 찾으면 줄을 떼고 요청을 돌려준다.
 * 못 찾거나 범위가 그 스레드 글이 아니면 줄을 그대로 둔다(마스터 눈에 보인다). 신호만 있는 답도 줄을 둔다.
 */
export function parsePull(
  body: string,
  threads: { id: string; title: string }[],
  threadOfSeq: (seq: number) => string | null,
): { body: string; pull: PullRequest | null; raw: string | null } {
  const { lines, i } = signalTail(body);
  if (i < 0) return { body, pull: null, raw: null };
  const m = /^\s*[*_`]*\s*(?:←|<-)\s*(.+?)\s*[*_`]*\s*$/.exec(lines[i]);
  if (!m) return { body, pull: null, raw: null };
  const raw = lines[i].trim();
  const r = /^(.*?)\s*(?:#(\d+)(?:\s*[~\-–]\s*#?(\d+))?)?$/.exec(m[1].trim());
  const title = (r?.[1] ?? '').trim().replace(/^[«"'“]+|[»"'”]+$/g, '').trim();
  const a = r?.[2] ? Number(r[2]) : null;
  const b = r?.[3] ? Number(r[3]) : null;
  let th: { id: string; title: string } | undefined;
  if (title) th = threads.find((t) => t.title.trim().toLowerCase() === title.toLowerCase());
  else if (a !== null) {
    const tid = threadOfSeq(a);
    th = threads.find((t) => t.id === tid);
  }
  const keep = { body, pull: null, raw };
  if (!th) return keep;
  if (a !== null && threadOfSeq(a) !== th.id) return keep;
  if (b !== null && (threadOfSeq(b) !== th.id || b < (a ?? 0))) return keep;
  const rest = lines.slice(0, i).join('\n').trim();
  if (!rest) return keep;
  return { body: rest, pull: { thread_id: th.id, title: th.title, from_seq: a, to_seq: b ?? a }, raw };
}

/**
 * 수동 전달 신호(2026-10-12 마스터 #62): 답의 마지막 비어 있지 않은 줄이 `→ 이름[, 이름…]`(또는 `->`)이면
 * 그 이름들을 후보(이 스레드의 다른 에이전트)에서 찾는다. 하나라도 찾으면 그 줄을 본문에서 떼고 id 를 돌려준다.
 * 못 찾으면 줄을 그대로 둔다 — 오타가 조용히 사라지지 않게(마스터 눈에 보인다). 끝줄만 본다.
 * 줄을 떼면 본문이 비는 경우(신호만 있는 답)도 줄을 둔다.
 */
export function parseHandoff(
  body: string,
  candidates: { id: string; name: string }[],
): { body: string; handoff_to: string[]; raw: string | null } {
  const { lines, i } = signalTail(body);
  if (i < 0) return { body, handoff_to: [], raw: null };
  const m = /^\s*[*_`]*\s*(?:→|->)\s*(.+?)\s*[*_`]*\s*$/.exec(lines[i]);
  if (!m) return { body, handoff_to: [], raw: null };
  const want = m[1].split(/\s*[,，、]\s*/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const ids: string[] = [];
  for (const w of want) {
    const c = candidates.find((x) => x.id.toLowerCase() === w || x.name.trim().toLowerCase() === w);
    if (c && !ids.includes(c.id)) ids.push(c.id);
  }
  const rest = lines.slice(0, i).join('\n').trim();
  if (!ids.length || !rest) return { body, handoff_to: [], raw: lines[i].trim() };
  return { body: rest, handoff_to: ids, raw: lines[i].trim() };
}

/** 취소 처리 결과 판정(정책 1). 화면의 «중단 결과» 칸과 취소 결과 화면이 이것 하나만 본다 */
export function cancelOutcomeOf(r: Row): CancelOutcome | null {
  if (r.state === 'cancelled') {
    if (r.error === 'stop_new') return 'withdrawn';
    if (r.error === 'generation_rotated') return 'rotated';
    if (r.cancel_requested_at == null) return r.cancel_requested ? 'legacy' : null;
    if (r.stop_ack_at != null) return 'acked';
    return r.started_at == null ? 'queued_cancelled' : 'acked';
  }
  if (r.cancel_requested_at == null) return null;
  if (r.state === 'running') return 'requested';
  if (r.state === 'unknown') return 'no_ack';
  if (r.state === 'succeeded') return 'completed_first';
  if (r.state === 'failed') return 'failed_first';
  return null;
}

function toRun(r: Row, cancelAckMs = 0): Run {
  return {
    id: r.id,
    thread_id: r.thread_id,
    trigger_seq: r.trigger_seq,
    agent_id: r.agent_id,
    session_id: r.session_id,
    generation: r.generation,
    state: r.state,
    cancel_requested: !!r.cancel_requested,
    created_at: r.created_at,
    started_at: r.started_at,
    ended_at: r.ended_at,
    error: r.error,
    usage: r.usage ? JSON.parse(r.usage) : null,
    result_seq: r.result_seq,
    cancel_requested_by: r.cancel_requested_by ?? null,
    cancel_requested_at: r.cancel_requested_at ?? null,
    stop_sent_at: r.stop_sent_at ?? null,
    stop_ack_at: r.stop_ack_at ?? null,
    finalized_at: r.finalized_at ?? null,
    last_checked_at: r.last_checked_at ?? null,
    cancel_outcome: cancelOutcomeOf(r),
    // 무응답 제한은 «중단 명령 뒤»부터(정책 1). 명령이 아직 안 실렸으면(heartbeat 전·어댑터 죽음) 요청 시각부터
    cancel_deadline_at: r.state === 'running' && r.cancel_requested_at != null ? (r.stop_sent_at ?? r.cancel_requested_at) + cancelAckMs : null,
    heartbeat_at: r.heartbeat_at ?? null,
    progress: r.progress ?? null,
    progress_at: r.progress_at ?? null,
  };
}

function toEvent(r: Row): RunEvent {
  let detail: Record<string, unknown> | null = null;
  if (r.detail) {
    try {
      detail = JSON.parse(r.detail);
    } catch {
      detail = null;
    }
  }
  return { id: r.id, at: r.at, event: r.event, source: r.source, detail };
}

function parseObj(s: unknown): Record<string, unknown> | null {
  if (typeof s !== 'string' || !s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function toAudit(r: Row): AuditEntry {
  return {
    id: r.id,
    corr_id: r.corr_id,
    actor_id: r.actor_id,
    actor_kind: r.actor_kind,
    action: r.action,
    target_type: r.target_type,
    target_id: r.target_id,
    thread_id: r.thread_id,
    requested_at: r.requested_at,
    processed_at: r.processed_at,
    result: r.result,
    reason: r.reason,
    before: parseObj(r.before_state),
    after: parseObj(r.after_state),
    repeat_count: r.repeat_count,
    last_at: r.last_at,
  };
}

function credStatus(c: Row, t: number): CredentialInfo['status'] {
  if (c.revoked_at) return 'revoked';
  if (c.expires_at && c.expires_at <= t) return 'expired';
  return 'active';
}

function toSession(r: Row): AgentSession {
  return {
    id: r.id,
    thread_id: r.thread_id,
    agent_id: r.agent_id,
    generation: r.generation,
    runtime: r.runtime,
    actual_model: r.actual_model,
    config_version: r.config_version,
    prev_session_id: r.prev_session_id,
    status: r.status,
    reason: r.reason,
    last_delivered_seq: r.last_delivered_seq,
    base_seq: r.base_seq ?? null,
    carry: !!r.carry,
    created_at: r.created_at,
    ended_at: r.ended_at,
  };
}

export function optInt(v: unknown, name: string): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ApiError(400, 'bad_request', `${name} must be an integer`);
  return v;
}

export function reqString(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || v.length === 0) throw new ApiError(400, 'bad_request', `${name} required`);
  if (v.length > max) throw new ApiError(413, 'too_large', `${name} exceeds ${max} chars`);
  return v;
}

export const FORWARD_NOTE_MAX = 4000;
const FORWARD_NOTE_HEAD = '[마스터 전달 메모';
const FORWARD_NOTE_HEAD_INERT = '[(인용) 마스터 전달 메모';
/** 글 안의 꾸민 머리를 무디게 — 모든 언어의 머리를 함께 본다(언어를 바꾼 뒤에도 옛 언어의 머리가 산 채로 실리지 않게) */
function inertForwardHeads(body: string): string {
  const pairs = new Map<string, string>([[FORWARD_NOTE_HEAD, FORWARD_NOTE_HEAD_INERT]]);
  for (const d of dictionaries().values()) {
    const h = d['srv.forward_note.head'];
    const inert = d['srv.forward_note.head_inert'];
    if (h && inert) pairs.set(h, inert);
  }
  for (const [h, inert] of pairs) if (body.includes(h)) body = body.split(h).join(inert);
  return body;
}

/** 차선(마스터 #1563) — 글(seq = ?)의 첫 주 태그 id, 없으면 ''. 파서가 머리 순서대로 넣으므로 rowid 가 곧 순서 */
// 휴지통에 든 태그는 차선이 되지 않는다(마이그레이션 21) — 그 태그가 붙은 옛 글의 새 전달은 다음 주 태그 또는 기본 차선으로. 이미 도는 실행은 제 lane 을 그대로 쥔다
const LANE_SQL =
  "SELECT COALESCE((SELECT lmt.tag_id FROM message_tags lmt JOIN tags ltg ON ltg.id = lmt.tag_id WHERE lmt.message_seq = ? AND lmt.role = 'primary' AND ltg.deleted_at IS NULL ORDER BY lmt.rowid LIMIT 1), '') AS lane";

export class Store {
  readonly events = new EventEmitter();
  /** 대면 모듈(src/modules/face) — 켜졌을 때만 붙는다(docs/MODULES.md) */
  face: FaceStore | null = null;
  /** 합치기 모듈(src/modules/merge) */
  merge: MergeStore | null = null;
  /** 태그 등록부(마이그레이션 19 · core) — 대표 에이전트·담당자·보관 */
  readonly tags: TagStore = new TagStore(this);
  /** 요청 모듈(src/modules/requests) — 꺼지면 요청·보류가 없고 «요청→»은 그냥 글이다 */
  requests: RequestStore | null = null;
  /** 위임 대장 모듈(src/modules/delegations) */
  delegations: DelegationStore | null = null;
  /** 질문함 모듈(src/modules/questions) — 꺼지면 질문 경로·claim 칸·글의 질문 머리가 없다 */
  questions: QuestionStore | null = null;

  constructor(
    readonly db: DB,
    readonly cfg: Config,
  ) {
    this.events.setMaxListeners(0);
    // 메인 채팅방은 «없으면 하나 만든다» — 기동할 때마다 불러도 하나다(마스터가 아직 없으면 init 때 만든다)
    this.ensureRoom();
  }

  /** @internal 모듈(src/modules)도 부른다 */ emit(e: NoticeEvent) {
    this.events.emit('notice', e);
  }

  // ───────────────────────── 감사 기록 (정책 9) ─────────────────────────

  /** 감사 기록의 작업자. CLI 는 마스터 권한으로 돌지만 'cli:root' 로 남는다 */
  actorOf(pr: Principal): AuditActor {
    if (pr.actor) return pr.actor;
    return { id: pr.participant.id, kind: pr.participant.kind === 'agent' ? 'agent' : 'master' };
  }

  /**
   * 감사 기록 한 줄. 호출한 쪽 트랜잭션 안이면 같이 확정된다.
   * group: 묶음 시간(cfg.auditGroupMs) 안에 같은 (작업자, 작업 유형, 결과, 사유) 행이 있으면 새 행 대신 repeat_count·last_at 만 올린다.
   * 상태 칸(before/after)은 서버가 고른 값만 — 본문·토큰 원문·해시·패스프레이즈는 부르는 쪽이 넣지 않는다.
   */
  /** 서버 언어(마스터 #823): 마스터가 고른 값(meta `lang`) → 설정 BRAINSTORM_LANG → ko. 서버 안내·에이전트 규약이 이 언어를 쓴다 */
  lang(): string {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = 'lang'").get() as Row | undefined;
    return normLang(r?.value) ?? normLang(this.cfg.lang) ?? DEFAULT_LANG;
  }

  /** 언어 바꾸기(마스터만) — 화면의 언어 설정이 부른다. 에이전트 규약도 다음 실행부터 이 언어 */
  setLang(pr: Principal, value: unknown): { lang: string } {
    this.requireMaster(pr, 'settings.lang');
    const l = normLang(value);
    if (!l) throw new ApiError(400, 'bad_lang', `unknown language: ${String(value).slice(0, 20)}`, { langs: languages().map((x) => x.code) });
    const before = this.lang();
    this.db.prepare("INSERT INTO meta(key, value) VALUES ('lang', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(l);
    if (before !== l) this.audit({ actor: this.actorOf(pr), action: 'settings.lang', result: 'ok', before: { lang: before }, after: { lang: l } });
    return { lang: l };
  }

  /** 에이전트별 모델(마스터 2026-11-04) — meta 'agent_model:<id>' · 없으면 null(어댑터 기본값) */
  agentModel(agentId: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(`agent_model:${agentId}`) as Row | undefined;
    return (r?.value as string) ?? null;
  }

  /** 에이전트 모델 바꾸기(마스터만) — 빈 값·null 은 지움. 다음 claim 부터 어댑터에 실린다(도는 실행·세션은 안 건드림) */
  setAgentModel(pr: Principal, agentId: string, value: unknown): { agent_id: string; model: string | null } {
    this.requireMaster(pr, 'agents.model');
    const p = this.getParticipant(agentId);
    if (!p || p.kind !== 'agent') throw new ApiError(404, 'not_found', 'agent not found');
    let m: string | null = null;
    if (value !== null && value !== undefined && value !== '') {
      if (typeof value !== 'string') throw new ApiError(400, 'bad_model', 'model must be a string or null');
      m = value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,99}$/.test(m)) throw new ApiError(400, 'bad_model', 'model: letters, digits and . _ : / @ [ ] - (≤100)', undefined, { key: 'err.bad_model' });
    }
    const before = this.agentModel(p.id);
    const key = `agent_model:${p.id}`;
    if (m) this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, m);
    else this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    if (before !== m)
      this.audit({ actor: this.actorOf(pr), action: 'agents.model', result: 'ok', target_type: 'participant', target_id: p.id, before: { model: before }, after: { model: m } });
    return { agent_id: p.id, model: m };
  }

  audit(e: AuditInput): { id: number; corr_id: string; grouped: boolean } {
    const t = now();
    const req = e.requested_at ?? t;
    const proc = e.processed_at ?? t;
    if (e.group) {
      const g = this.db
        .prepare(
          `SELECT id, corr_id FROM audit_log WHERE actor_id = ? AND action = ? AND result = ? AND COALESCE(reason, '') = ? AND requested_at > ?
           ORDER BY id DESC LIMIT 1`,
        )
        .get(e.actor.id, e.action, e.result, e.reason ?? '', t - this.cfg.auditGroupMs) as Row | undefined;
      if (g) {
        this.db.prepare('UPDATE audit_log SET repeat_count = repeat_count + 1, last_at = ? WHERE id = ?').run(proc, g.id);
        return { id: g.id, corr_id: g.corr_id, grouped: true };
      }
    }
    const json = (x: Record<string, unknown> | null | undefined) => {
      if (!x) return null;
      const s = JSON.stringify(x);
      return s.length > 2000 ? JSON.stringify({ truncated: true, keys: Object.keys(x) }) : s;
    };
    const corr = e.corr_id ?? newId('aud');
    const info = this.db
      .prepare(
        `INSERT INTO audit_log(corr_id, actor_id, actor_kind, action, target_type, target_id, thread_id, requested_at, processed_at, result, reason, before_state, after_state, repeat_count, last_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      )
      .run(
        corr,
        e.actor.id.slice(0, 64),
        e.actor.kind,
        e.action,
        e.target_type ?? null,
        e.target_id?.slice(0, 128) ?? null,
        e.thread_id ?? null,
        req,
        proc,
        e.result,
        e.reason?.slice(0, 64) ?? null,
        json(e.before),
        json(e.after),
        proc,
      );
    return { id: Number(info.lastInsertRowid), corr_id: corr, grouped: false };
  }

  /** 거부: 감사 한 줄(묶음) + ApiError. reason 은 감사에 남는 사유(응답 코드와 다를 수 있다 — 비멤버 읽기는 404 no_thread 지만 사유는 not_member) */
  /** @internal 모듈(src/modules)도 부른다 */ deny(
    pr: Principal,
    err: ApiError,
    a: { action: string; target_type?: string; target_id?: string | null; thread_id?: string | null; reason?: string },
  ): never {
    this.audit({
      actor: this.actorOf(pr),
      action: a.action,
      target_type: a.target_type ?? null,
      target_id: a.target_id ?? null,
      thread_id: a.thread_id ?? null,
      result: 'denied',
      reason: a.reason ?? err.code,
      after: { status: err.status },
      group: true,
    });
    throw err;
  }

  /** 실행 중단 요청의 최종 결과를 요청 행과 같은 감사 식별자로 남긴다(정책 9 «요청과 최종 처리 결과를 같은 감사 식별자로»). 트랜잭션 안에서 부른다 */
  /** @internal 모듈(src/modules)도 부른다 */ auditCancelFinal(r: Row, state: RunState, outcome: string, t: number, by?: string) {
    if (r.cancel_requested_at == null) return;
    const req = this.db
      .prepare("SELECT corr_id FROM audit_log WHERE action = 'run.cancel' AND target_id = ? AND result = 'requested' ORDER BY id DESC LIMIT 1")
      .get(r.id) as Row | undefined;
    this.audit({
      actor: SERVER_ACTOR,
      action: 'run.cancel',
      target_type: 'run',
      target_id: r.id,
      thread_id: r.thread_id,
      corr_id: req?.corr_id,
      requested_at: r.cancel_requested_at,
      processed_at: t,
      result: state === 'cancelled' ? 'ok' : state === 'unknown' ? 'failed' : 'noop',
      reason: outcome,
      before: { state: 'running', cancel_requested: true },
      after: { state, ...(by ? { confirmed_by: by } : {}) },
    });
  }

  /**
   * 감사 기록 조회(마스터만). 최근 발생(last_at — 묶음은 마지막 반복 시각) 순. 조회 자체도 감사에 남는다(묶음). 필터: q(작업자·대상·작업 유형·감사 식별자 부분 일치) · action(정확히, 또는 'token.*' 꼴 접두) ·
   * actor · result · thread · corr · since/until(ms) · page(1부터)·limit(≤200).
   */
  listAudit(pr: Principal, q: Record<string, unknown> = {}) {
    this.requireMaster(pr, 'audit.view');
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);
    const f = {
      q: str(q.q),
      action: str(q.action),
      actor: str(q.actor),
      result: str(q.result),
      thread: str(q.thread),
      corr: str(q.corr),
      since: Number(q.since) > 0 ? Number(q.since) : null,
      until: Number(q.until) > 0 ? Number(q.until) : null,
    };
    if (f.result && !['ok', 'requested', 'noop', 'denied', 'failed'].includes(f.result)) throw new ApiError(400, 'bad_result_filter');
    const limit = Math.min(Math.max(Math.floor(Number(q.limit)) || 50, 1), 200);
    const page = Math.max(Math.floor(Number(q.page)) || 1, 1);
    // 조회도 감사에 남긴다 — 걸러 본 조건만(결과 행은 안 담는다)
    const filters = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null));
    this.audit({ actor: this.actorOf(pr), action: 'audit.view', target_type: 'audit', result: 'ok', after: { filters, page }, group: true });
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.action) {
      if (f.action.endsWith('.*')) (where.push('action LIKE ?'), params.push(`${f.action.slice(0, -1)}%`));
      else (where.push('action = ?'), params.push(f.action));
    }
    if (f.actor) (where.push('actor_id = ?'), params.push(f.actor));
    if (f.result) (where.push('result = ?'), params.push(f.result));
    if (f.thread) (where.push('thread_id = ?'), params.push(f.thread));
    if (f.corr) (where.push('corr_id = ?'), params.push(f.corr));
    // 기간은 «마지막 발생» 기준 — 오래전에 시작된 묶음도 최근에 반복됐으면 보인다
    if (f.since) (where.push('last_at >= ?'), params.push(f.since));
    if (f.until) (where.push('requested_at < ?'), params.push(f.until));
    if (f.q) {
      const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(actor_id LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR corr_id LIKE ? ESCAPE '\\' OR thread_id LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like, like, like);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${w}`).get(...params) as Row).n as number;
    const rows = this.db.prepare(`SELECT * FROM audit_log ${w} ORDER BY last_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit) as Row[];
    const actors = (this.db.prepare('SELECT DISTINCT actor_id, actor_kind FROM audit_log ORDER BY actor_kind, actor_id').all() as Row[]).map((r) => ({
      id: r.actor_id as string,
      kind: r.actor_kind as AuditActorKind,
    }));
    const actions = (this.db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all() as Row[]).map((r) => r.action as string);
    return { entries: rows.map(toAudit), total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), actors, actions };
  }

  // ───────────────────────── 참여자 · 자격 증명 ─────────────────────────

  /** 참여자 등록(관리 CLI). 에이전트는 메인 채팅방 멤버가 된다 — 그 권한 부여도 감사 after 에 남는다 */
  createParticipant(id: string, kind: ParticipantKind, name: string, isMaster = false, by: AuditActor = CLI_ACTOR): Participant {
    if (!/^[a-z0-9_-]{1,64}$/.test(id)) throw new ApiError(400, 'bad_id', 'id: a-z 0-9 _ - 만, 64자 이하', undefined, { key: 'err.bad_id' });
    if (isMaster && kind !== 'human') throw new ApiError(400, 'bad_request', 'master must be human');
    let roomId: string | null = null;
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO participants(id, kind, name, is_master, created_at) VALUES (?,?,?,?,?)')
        .run(id, kind, name, isMaster ? 1 : 0, now());
      if (!isMaster && kind === 'agent') {
        // 새 에이전트는 메인 채팅방 멤버로 (마스터 결정 3: 모든 에이전트가 방 멤버). 다른 스레드는 마스터가 고른다
        const room = this.roomRow();
        if (room) {
          this.insertMembers(room.id, [id], now());
          roomId = room.id;
        }
      }
      this.audit({
        actor: by,
        action: 'participant.create',
        target_type: 'participant',
        target_id: id,
        thread_id: roomId,
        result: 'ok',
        after: { kind, is_master: isMaster, ...(roomId ? { room_member: { can_read: true, can_post: true } } : {}) },
      });
    })();
    if (isMaster) this.ensureRoom();
    if (roomId) this.emit({ notice: { t: 'thread', thread_id: roomId }, threadId: roomId });
    return this.getParticipant(id)!;
  }

  /** 표시명만 바꾼다. id(내부 안정 키)·토큰·세션·기록은 그대로 — 이름은 나중에 지어도 된다 */
  renameParticipant(id: string, name: string, by: AuditActor = CLI_ACTOR): Participant {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n || n.length > 100) throw new ApiError(400, 'bad_name', '이름: 1~100자', undefined, { key: 'err.bad_name' });
    const before = this.getParticipant(id);
    const info = this.db.prepare('UPDATE participants SET name = ? WHERE id = ? AND disabled_at IS NULL').run(n, id);
    if (info.changes !== 1) throw new ApiError(404, 'no_participant');
    this.audit({ actor: by, action: 'participant.rename', target_type: 'participant', target_id: id, result: 'ok', before: { name: before?.name ?? null }, after: { name: n } });
    const p = this.getParticipant(id)!;
    // 열린 화면이 참여자 이름을 다시 읽도록 — 알림에는 내용을 싣지 않는다
    for (const t of this.db.prepare('SELECT thread_id FROM thread_members WHERE participant_id = ?').all(id) as Row[])
      this.emit({ notice: { t: 'thread', thread_id: t.thread_id }, threadId: t.thread_id });
    return p;
  }

  getParticipant(id: string): Participant | null {
    const r = this.db.prepare('SELECT * FROM participants WHERE id = ? AND disabled_at IS NULL').get(id) as Row | undefined;
    return r ? toParticipant(r) : null;
  }

  getMaster(): Participant | null {
    const r = this.db.prepare('SELECT * FROM participants WHERE is_master = 1').get() as Row | undefined;
    return r ? toParticipant(r) : null;
  }

  /** includeDisabled: 화면의 이름 사전용 — 끈 참여자도 옛 글의 작성자 이름은 보여야 한다(disabled: true 로 표시) */
  listParticipants(includeDisabled = false): Participant[] {
    return (
      this.db.prepare(`SELECT * FROM participants ${includeDisabled ? '' : 'WHERE disabled_at IS NULL '}ORDER BY kind DESC, id`).all() as Row[]
    ).map(toParticipant);
  }

  /** 작성자 표시명 — 끈 참여자도 이름은 남는다 */
  /** @internal 모듈(src/modules)도 부른다 */ nameOf(id: string): string {
    return ((this.db.prepare('SELECT name FROM participants WHERE id = ?').get(id) as Row | undefined)?.name as string) ?? id;
  }

  /**
   * 참여자 끄기(관리 CLI · 2026-10-19 마스터 #441 «비활성화하고 숨겨둬»).
   * 글·감사 기록은 그대로 두고, 들어오는 길과 보이는 자리를 걷는다:
   * 토큰 전부 폐기 · 활성 세션 은퇴 · 대기 실행·배달 취소 · 스레드 멤버 해제 · 기본 수신자·요청 짝에서 뺀다.
   * 뺀 스레드 목록은 감사 before 에 남는다(되살릴 때 그 목록으로 member set). 마스터는 끌 수 없다.
   */
  disableParticipant(id: string, by: AuditActor = CLI_ACTOR): { id: string; outcome: 'disabled' | 'already_disabled'; threads: number; credentials: number } {
    return this.db.transaction(() => {
      const r = this.db.prepare('SELECT * FROM participants WHERE id = ?').get(id) as Row | undefined;
      if (!r) throw new ApiError(404, 'no_participant');
      if (r.is_master) throw new ApiError(400, 'bad_request', '마스터는 끌 수 없다', undefined, { key: 'err.bad_request.master_disable' });
      if (r.disabled_at) {
        this.audit({ actor: by, action: 'participant.disable', target_type: 'participant', target_id: id, result: 'noop', reason: 'already_disabled' });
        return { id, outcome: 'already_disabled' as const, threads: 0, credentials: 0 };
      }
      const t = now();
      const threads = (this.db.prepare('SELECT thread_id FROM thread_members WHERE participant_id = ?').all(id) as Row[]).map((x) => x.thread_id as string);
      const drThreads = (this.db.prepare('SELECT id FROM threads WHERE default_recipient = ?').all(id) as Row[]).map((x) => x.id as string);
      const creds = this.db.prepare('UPDATE credentials SET revoked_at = ? WHERE participant_id = ? AND revoked_at IS NULL').run(t, id).changes;
      const sess = (this.db.prepare("SELECT id FROM agent_sessions WHERE agent_id = ? AND status = 'active'").all(id) as Row[]).map((x) => x.id as string);
      for (const sid of sess) {
        this.db
          .prepare(
            "UPDATE runs SET state = 'cancelled', cancel_requested = 1, ended_at = ?, finalized_at = ?, error = 'participant_disabled', lease_expires_at = NULL WHERE session_id = ? AND state = 'queued'",
          )
          .run(t, t, sid);
        this.db.prepare("UPDATE runs SET cancel_requested = 1 WHERE session_id = ? AND state = 'running'").run(sid);
        this.db.prepare("UPDATE agent_sessions SET status = 'retired', ended_at = ? WHERE id = ?").run(t, sid);
      }
      this.db
        .prepare("UPDATE deliveries SET status = 'cancelled', last_error = 'participant_disabled', lease_token_hash = NULL, updated_at = ? WHERE recipient_id = ? AND status IN ('pending','leased')")
        .run(t, id);
      this.db.prepare('DELETE FROM thread_members WHERE participant_id = ?').run(id);
      this.db.prepare('UPDATE threads SET default_recipient = NULL WHERE default_recipient = ?').run(id);
      const pairs = this.db.prepare('DELETE FROM request_pairs WHERE from_id = ? OR to_id = ?').run(id, id).changes;
      this.db.prepare('UPDATE participants SET disabled_at = ? WHERE id = ?').run(t, id);
      this.audit({
        actor: by, action: 'participant.disable', target_type: 'participant', target_id: id, result: 'ok',
        before: { name: r.name, threads, default_recipient_of: drThreads, sessions: sess.length },
        after: { disabled_at: t, credentials_revoked: creds, request_pairs_removed: pairs },
      });
      for (const th of new Set([...threads, ...drThreads])) this.emit({ notice: { t: 'thread', thread_id: th }, threadId: th });
      return { id, outcome: 'disabled' as const, threads: threads.length, credentials: creds };
    })();
  }

  /**
   * 참여자 완전 삭제(2026-10-19 마스터 #447 «oc-main은 완전 정리해»): 꺼진 참여자만 · 남은 글·만든 스레드·위임이 없을 때만.
   * 글이 있으면 옛 글의 작성자 이름이 깨지니 거절한다 — 그 스레드를 먼저 영구 삭제한다. 감사 기록은 남는다(FK 없음).
   */
  purgeParticipant(id: string, by: AuditActor = CLI_ACTOR): { id: string; outcome: 'purged'; removed: Record<string, number> } {
    const r = this.db.prepare('SELECT * FROM participants WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new ApiError(404, 'no_participant');
    if (r.is_master) throw new ApiError(400, 'bad_request', '마스터는 지울 수 없다', undefined, { key: 'err.bad_request.master_delete' });
    if (!r.disabled_at) throw new ApiError(409, 'not_disabled', '먼저 participant disable', undefined, { key: 'err.not_disabled' });
    const held = (q: string) => (this.db.prepare(q).all(id) as Row[]).map((x) => x.v as string);
    const msgThreads = held('SELECT DISTINCT thread_id AS v FROM messages WHERE author_id = ?');
    if (msgThreads.length) throw new ApiError(409, 'has_messages', `남은 글이 있는 스레드: ${msgThreads.join(', ')}`, undefined, { key: 'err.has_messages', vars: { threads: msgThreads.join(', ') } });
    const made = held('SELECT id AS v FROM threads WHERE created_by = ?');
    if (made.length) throw new ApiError(409, 'has_threads', `만든 스레드: ${made.join(', ')}`, undefined, { key: 'err.has_threads', vars: { threads: made.join(', ') } });
    const dels = held('SELECT id AS v FROM delegations WHERE created_by = ?');
    if (dels.length) throw new ApiError(409, 'has_delegations', `만든 위임: ${dels.join(', ')}`, undefined, { key: 'err.has_delegations', vars: { delegations: dels.join(', ') } });
    const files = held('SELECT path AS v FROM uploads WHERE owner_id = ?');
    const removed: Record<string, number> = {};
    this.db.transaction(() => {
      this.db.pragma('defer_foreign_keys = ON');
      const run = (k: string, q: string, n = 1) => (removed[k] = this.db.prepare(q).run(...Array(n).fill(id)).changes);
      run('run_events', 'DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE agent_id = ?)');
      run('runs', 'DELETE FROM runs WHERE agent_id = ?');
      this.db.prepare('UPDATE runs SET cancel_requested_by = NULL WHERE cancel_requested_by = ?').run(id);
      run('context_snapshots', 'DELETE FROM context_snapshots WHERE session_id IN (SELECT id FROM agent_sessions WHERE agent_id = ?)');
      this.db.prepare('UPDATE context_snapshots SET summary_author_id = NULL WHERE summary_author_id = ?').run(id);
      run('agent_sessions', 'DELETE FROM agent_sessions WHERE agent_id = ?');
      run('deliveries', 'DELETE FROM deliveries WHERE recipient_id = ?');
      run('credentials', 'DELETE FROM credentials WHERE participant_id = ?');
      run('web_sessions', 'DELETE FROM web_sessions WHERE participant_id = ?');
      run('thread_members', 'DELETE FROM thread_members WHERE participant_id = ?');
      this.db.prepare('UPDATE threads SET default_recipient = NULL WHERE default_recipient = ?').run(id);
      run('uploads', 'DELETE FROM uploads WHERE owner_id = ?');
      run('request_pairs', 'DELETE FROM request_pairs WHERE from_id = ? OR to_id = ?', 2);
      run('request_holds', 'DELETE FROM request_holds WHERE requester_id = ? OR recipient_id = ?', 2);
      this.db.prepare('DELETE FROM participants WHERE id = ?').run(id);
      this.audit({
        actor: by, action: 'participant.purge', target_type: 'participant', target_id: id, result: 'ok',
        before: { name: r.name, kind: r.kind, created_at: r.created_at, disabled_at: r.disabled_at }, after: { removed },
      });
    })();
    for (const f of files) fs.rmSync(path.join(this.cfg.dataDir, f), { force: true });
    return { id, outcome: 'purged' as const, removed };
  }

  /** 패스프레이즈 설정(관리 CLI·init). 감사에는 «바꿨다»와 끊은 웹 세션 수만 — 값·해시는 없다 */
  setPassphrase(participantId: string, pass: string, by: AuditActor = CLI_ACTOR) {
    if (pass.length < 12) {
      this.audit({ actor: by, action: 'passphrase.set', target_type: 'participant', target_id: participantId, result: 'failed', reason: 'weak_passphrase' });
      throw new ApiError(400, 'weak_passphrase', '12자 이상', undefined, { key: 'err.weak_passphrase' });
    }
    const p = this.getParticipant(participantId);
    if (!p || p.kind !== 'human') throw new ApiError(400, 'bad_request', 'human participant required');
    this.db.transaction(() => {
      this.db.prepare('UPDATE participants SET passphrase_hash = ? WHERE id = ?').run(hashPassphrase(pass), participantId);
      // 패스프레이즈를 바꾸면 기존 웹 세션을 모두 끊는다
      const n = this.db.prepare('DELETE FROM web_sessions WHERE participant_id = ?').run(participantId).changes;
      this.audit({ actor: by, action: 'passphrase.set', target_type: 'participant', target_id: participantId, result: 'ok', after: { web_sessions_removed: n } });
    })();
  }

  /** 에이전트 토큰 발급 — 관리 CLI 만(마스터 결정 2: 화면은 조회·폐기만). 원문은 돌려줄 뿐 DB·감사에는 해시조차 안 남긴다(감사엔 자격 증명 id·라벨·범위·만료) */
  createToken(participantId: string, opts: { scope?: string[]; label?: string; expiresInDays?: number } = {}, by: AuditActor = CLI_ACTOR) {
    const p = this.getParticipant(participantId);
    const fail = (err: ApiError) => {
      this.audit({ actor: by, action: 'credential.create', target_type: 'participant', target_id: participantId, result: 'failed', reason: err.code });
      return err;
    };
    if (!p) throw fail(new ApiError(404, 'no_participant'));
    if (p.kind !== 'agent') throw fail(new ApiError(400, 'not_agent', '토큰은 에이전트에게만 발급한다 (PWA에 어댑터 토큰을 넣지 않는다)', undefined, { key: 'err.not_agent' }));
    const token = randomToken('bst');
    const id = newId('cred');
    const scope = opts.scope ?? ['adapter'];
    const label = opts.label ? String(opts.label).slice(0, 100) : null;
    const expires = opts.expiresInDays ? now() + opts.expiresInDays * 86_400_000 : null;
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO credentials(id, participant_id, token_hash, scope, label, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, participantId, sha256(token), JSON.stringify(scope), label, now(), expires);
      this.audit({
        actor: by,
        action: 'credential.create',
        target_type: 'credential',
        target_id: id,
        result: 'ok',
        after: { participant_id: participantId, scope, label, expires_at: expires },
      });
    })();
    return { id, token, participant_id: participantId, scope, expires_at: expires };
  }

  /** 자격 증명 폐기. 이미 폐기됐으면 noop, 없으면 failed — 셋 다 감사에 남는다 */
  revokeToken(credentialId: string, by: AuditActor = CLI_ACTOR): boolean {
    return this.revokeCredentialRow(credentialId, by).outcome === 'revoked';
  }

  private revokeCredentialRow(credentialId: string, by: AuditActor): { outcome: 'revoked' | 'already_revoked' | 'none'; row?: Row } {
    return this.db.transaction(() => {
      const c = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(String(credentialId)) as Row | undefined;
      if (!c) {
        this.audit({ actor: by, action: 'credential.revoke', target_type: 'credential', target_id: String(credentialId).slice(0, 64), result: 'failed', reason: 'no_credential' });
        return { outcome: 'none' as const };
      }
      const before = { participant_id: c.participant_id, label: c.label, status: credStatus(c, now()), revoked_at: c.revoked_at };
      if (c.revoked_at) {
        this.audit({ actor: by, action: 'credential.revoke', target_type: 'credential', target_id: c.id, result: 'noop', reason: 'already_revoked', before });
        return { outcome: 'already_revoked' as const, row: c };
      }
      const t = now();
      this.db.prepare('UPDATE credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(t, c.id);
      this.audit({ actor: by, action: 'credential.revoke', target_type: 'credential', target_id: c.id, result: 'ok', before, after: { status: 'revoked', revoked_at: t } });
      return { outcome: 'revoked' as const, row: this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(c.id) as Row };
    })();
  }

  /** 화면의 [폐기](마스터만). 붙어 있던 WS 는 재검사 주기(5초) 안에 끊긴다 */
  revokeCredential(pr: Principal, credentialId: string) {
    this.requireMaster(pr, 'credential.revoke', { target_type: 'credential', target_id: credentialId });
    const r = this.revokeCredentialRow(credentialId, this.actorOf(pr));
    if (r.outcome === 'none') throw new ApiError(404, 'no_credential');
    return { ok: true, outcome: r.outcome, credential: this.credInfo(r.row!, now()) };
  }

  private credInfo(c: Row, t: number): CredentialInfo & { participant_id: string } {
    let scope: string[] = [];
    try {
      scope = JSON.parse(c.scope);
    } catch {}
    return {
      id: c.id,
      participant_id: c.participant_id,
      label: c.label,
      scope,
      created_at: c.created_at,
      expires_at: c.expires_at,
      revoked_at: c.revoked_at,
      last_used_at: c.last_used_at,
      status: credStatus(c, t),
    };
  }

  /**
   * 에이전트 연결 화면(기획서 2.1 을 «에이전트 연결 상태»로 — 마스터 결정 1·2). 마스터만.
   * 서버가 아는 신호만: 자격 증명(라벨·발급·만료·폐기·마지막 사용) · 마지막 접속 · 서버가 거절한 마지막 연결(감사 기록) · 방 멤버 · 실행.
   * 토큰 값·해시는 내지 않는다. 어댑터 프로세스의 «진행률»은 서버가 모르므로 없다.
   */
  listConnections(pr: Principal): { agents: AgentConnection[]; now: number } {
    this.requireMaster(pr, 'connections.view');
    const t = now();
    const base = this.listAgents(pr);
    const room = this.roomRow();
    const creds = this.db.prepare('SELECT * FROM credentials ORDER BY created_at DESC').all() as Row[];
    const agents = base.map((a) => {
      const denied = this.db
        .prepare("SELECT reason, last_at, repeat_count FROM audit_log WHERE action = 'auth.token' AND result = 'denied' AND actor_id = ? ORDER BY last_at DESC LIMIT 1")
        .get(a.id) as Row | undefined;
      const runs = this.db
        .prepare("SELECT SUM(state IN ('queued','running')) AS active, MAX(created_at) AS last_at FROM runs WHERE agent_id = ?")
        .get(a.id) as Row;
      const lastRun = this.db.prepare('SELECT state FROM runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1').get(a.id) as Row | undefined;
      const lastModel = this.db
        .prepare('SELECT s.runtime, s.actual_model FROM runs r JOIN agent_sessions s ON s.id = r.session_id WHERE r.agent_id = ? AND s.actual_model IS NOT NULL ORDER BY r.created_at DESC LIMIT 1')
        .get(a.id) as Row | undefined;
      const threads = (this.db.prepare('SELECT COUNT(*) AS n FROM thread_members WHERE participant_id = ? AND can_read = 1').get(a.id) as Row).n as number;
      return {
        ...a,
        credential_list: creds.filter((c) => c.participant_id === a.id).map((c) => {
          const { participant_id: _p, ...info } = this.credInfo(c, t);
          return info;
        }),
        room_member: room ? !!this.membership(room.id, a.id)?.can_read : false,
        threads,
        last_denied: denied ? { at: denied.last_at, reason: denied.reason, count: denied.repeat_count } : null,
        runs: { active: runs.active ?? 0, last_at: runs.last_at ?? null, last_state: (lastRun?.state as RunState) ?? null },
        model: this.agentModel(a.id),
        last_model: lastModel ? { runtime: (lastModel.runtime as string) ?? null, model: (lastModel.actual_model as string) ?? null } : null,
      };
    });
    return { agents, now: t };
  }

  listTokens() {
    return this.db
      .prepare(
        'SELECT id, participant_id, scope, label, created_at, expires_at, revoked_at, last_used_at FROM credentials ORDER BY created_at',
      )
      .all();
  }

  /**
   * 토큰 인증. 거절은 감사에 남는다(정책 9 «폐기된 토큰 사용») — 작업 유형 auth.token, 사유 token_revoked·token_expired·token_unknown·
   * participant_disabled. 폐기·만료 토큰은 주인을 알므로 작업자가 그 에이전트, 모르는 토큰은 anonymous. 같은 (작업자, 사유)는 묶음 시간 안에 한 행.
   */
  authenticateToken(token: string, via: 'rest' | 'ws' = 'rest'): Principal | null {
    const denied = (actor: AuditActor, reason: string, credId?: string) => {
      this.audit({ actor, action: 'auth.token', target_type: credId ? 'credential' : null, target_id: credId ?? null, result: 'denied', reason, after: { via }, group: true });
      return null;
    };
    if (!token || token.length > 200) return denied(ANON_ACTOR, 'token_malformed');
    const r = this.db.prepare('SELECT * FROM credentials WHERE token_hash = ?').get(sha256(token)) as Row | undefined;
    if (!r) return denied(ANON_ACTOR, 'token_unknown');
    const owner: AuditActor = { id: r.participant_id, kind: 'agent' };
    if (r.revoked_at) return denied(owner, 'token_revoked', r.id);
    if (r.expires_at && r.expires_at <= now()) return denied(owner, 'token_expired', r.id);
    const p = this.getParticipant(r.participant_id);
    if (!p) return denied(owner, 'participant_disabled', r.id);
    this.db.prepare('UPDATE credentials SET last_used_at = ? WHERE id = ?').run(now(), r.id);
    return { participant: p, via: 'token', credentialId: r.id, scopes: JSON.parse(r.scope) };
  }

  /** 긴 연결(WebSocket)이 쥐고 있는 자격 증명이 아직 유효한가 */
  credentialStillValid(credentialId: string): boolean {
    const r = this.db.prepare('SELECT revoked_at, expires_at FROM credentials WHERE id = ?').get(credentialId) as Row | undefined;
    return !!r && !r.revoked_at && !(r.expires_at && r.expires_at <= now());
  }

  login(pass: string): { sessionToken: string; participant: Participant; expiresAt: number } | null {
    const r = this.db.prepare('SELECT * FROM participants WHERE is_master = 1 AND disabled_at IS NULL').get() as Row | undefined;
    if (!r || !r.passphrase_hash || typeof pass !== 'string' || pass.length > 256) return null;
    if (!verifyPassphrase(pass, r.passphrase_hash)) return null;
    const token = randomToken('bss');
    const exp = now() + this.cfg.webSessionDays * 86_400_000;
    this.db
      .prepare('INSERT INTO web_sessions(id_hash, participant_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)')
      .run(sha256(token), r.id, now(), exp, now());
    return { sessionToken: token, participant: toParticipant(r), expiresAt: exp };
  }

  /**
   * 관리 CLI 전용: 마스터 웹 세션을 짧게 하나 만든다(시험 스크립트용). 패스프레이즈를 건드리지 않는다.
   * CT 안 root 는 원래 DB 를 다 만질 수 있으므로 새 권한이 아니다. 기본 60분, 최대 1일.
   */
  createWebSessionForMaster(minutes: number, by: AuditActor = CLI_ACTOR): { sessionToken: string; expiresAt: number } {
    const m = this.getMaster();
    if (!m) throw new ApiError(400, 'no_master');
    const mins = Math.min(Math.max(Math.floor(minutes), 1), 24 * 60);
    const token = randomToken('bss');
    const exp = now() + mins * 60_000;
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO web_sessions(id_hash, participant_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)')
        .run(sha256(token), m.id, now(), exp, now());
      this.audit({ actor: by, action: 'websession.create', target_type: 'participant', target_id: m.id, result: 'ok', after: { minutes: mins, expires_at: exp } });
    })();
    return { sessionToken: token, expiresAt: exp };
  }

  resolveWebSession(token: string): Principal | null {
    if (!token || token.length > 200) return null;
    const r = this.db.prepare('SELECT * FROM web_sessions WHERE id_hash = ?').get(sha256(token)) as Row | undefined;
    if (!r || r.expires_at <= now()) return null;
    const p = this.getParticipant(r.participant_id);
    if (!p || p.kind !== 'human') return null;
    return { participant: p, via: 'cookie', scopes: ['web'] };
  }

  webSessionStillValid(token: string): boolean {
    return this.resolveWebSession(token) !== null;
  }

  /** 웹 세션 하나 끊기. by 를 주면(관리 CLI) 감사에 남긴다 — 화면의 로그아웃은 자기 세션이라 남기지 않는다 */
  logout(token: string, by?: AuditActor) {
    const n = this.db.prepare('DELETE FROM web_sessions WHERE id_hash = ?').run(sha256(token)).changes;
    if (by) this.audit({ actor: by, action: 'websession.revoke', target_type: 'web_session', result: n ? 'ok' : 'noop', reason: n ? null : 'no_session' });
  }

  logoutAll(by: AuditActor = CLI_ACTOR) {
    const n = this.db.prepare('DELETE FROM web_sessions').run().changes;
    this.audit({ actor: by, action: 'websession.revoke_all', target_type: 'web_session', result: 'ok', after: { removed: n } });
    return n;
  }

  // ───────────────────────── 권한 ─────────────────────────

  /** @internal 모듈(src/modules)도 부른다 */ membership(threadId: string, pid: string): Row | undefined {
    return this.db.prepare('SELECT * FROM thread_members WHERE thread_id = ? AND participant_id = ?').get(threadId, pid) as
      | Row
      | undefined;
  }

  canRead(pid: string, threadId: string): boolean {
    const p = this.getParticipant(pid);
    if (!p) return false;
    if (p.is_master) return true;
    return !!this.membership(threadId, pid)?.can_read;
  }

  /** @internal 모듈(src/modules)도 부른다 */ requireThread(threadId: string): Row {
    const t = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as Row | undefined;
    if (!t) throw new ApiError(404, 'no_thread');
    return t;
  }

  /** 읽기 권한. 권한 밖 스레드는 «없음»(404)과 구별하지 않지만, 있는 스레드를 비멤버가 연 것은 감사에 남긴다(사유 not_member) */
  /** 토큰 범위 `read_all`(사서 · 마스터 2026-10-14 #200): 멤버가 아니어도 지워지지 않은 모든 스레드를 **읽기만** 한다 */
  readAll(pr: Principal): boolean {
    return pr.via === 'token' && pr.scopes.includes('read_all');
  }

  /** readOnly = 조회만 하는 자리(스레드·메시지·맥락·실행·배달 목록). 거기서만 `read_all` 이 멤버 검사를 대신한다 */
  /** 글 번호 → 그 글이 사는 대화(마스터 #1537 «#1533 을 누르면 그 대화로»). 읽을 수 있는 대화의 글만 · 없거나 못 읽으면 404 */
  locateMessage(pr: Principal, seqIn: unknown): { seq: number; thread_id: string } {
    const seq = Number(seqIn);
    if (!Number.isInteger(seq) || seq < 1) throw new ApiError(400, 'bad_request', 'seq must be a positive integer');
    const m = this.db.prepare('SELECT thread_id FROM messages WHERE seq = ?').get(seq) as Row | undefined;
    if (!m) throw new ApiError(404, 'no_message');
    try {
      this.requireRead(pr, m.thread_id as string, 'message.locate', true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) throw new ApiError(404, 'no_message');
      throw e;
    }
    return { seq, thread_id: m.thread_id as string };
  }

  /** @internal 모듈(src/modules)도 부른다 */ requireRead(pr: Principal, threadId: string, action = 'thread.read', readOnly = false): Row {
    const t = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as Row | undefined;
    if (!t) throw new ApiError(404, 'no_thread');
    if (t.deleted_at && !pr.participant.is_master) throw new ApiError(404, 'no_thread');
    if (!this.canRead(pr.participant.id, threadId) && !(readOnly && this.readAll(pr)))
      this.deny(pr, new ApiError(404, 'no_thread'), { action, target_type: 'thread', target_id: threadId, thread_id: threadId, reason: 'not_member' });
    return t;
  }

  /** 마스터만. 거절은 감사에 남는다 — action = 시도한 작업 */
  /** @internal 모듈(src/modules)도 부른다 */ requireMaster(pr: Principal, action: string, target: { target_type?: string; target_id?: string | null; thread_id?: string | null } = {}) {
    if (!pr.participant.is_master || pr.via !== 'cookie') this.deny(pr, new ApiError(403, 'master_only'), { action, ...target });
  }

  private requireAdapter(pr: Principal, action: string, target: { target_type?: string; target_id?: string | null } = {}) {
    if (pr.participant.kind !== 'agent' || pr.via !== 'token' || !pr.scopes.includes('adapter'))
      this.deny(pr, new ApiError(403, 'adapter_scope_required'), { action, ...target });
  }

  // ───────────────────────── 스레드 ─────────────────────────

  private roomRow(): Row | undefined {
    return this.db.prepare("SELECT * FROM threads WHERE kind = 'room'").get() as Row | undefined;
  }

  /**
   * 메인 채팅방이 없으면 하나 만든다. 멤버 = 마스터 + 그때 있는 모든 에이전트(마스터 결정 3).
   * 이미 있으면 아무것도 안 한다 — 마스터가 방에서 뺀 에이전트를 기동 때 다시 넣지 않는다.
   * 마스터가 아직 없으면(init 전) null. 옛 루트 스레드는 손대지 않는다(부모 없는 스레드로 남는다).
   */
  ensureRoom(): string | null {
    const existing = this.roomRow();
    if (existing) return existing.id;
    const master = this.getMaster();
    if (!master) return null;
    const id = newId('th');
    const t = now();
    const created = this.db.transaction(() => {
      if (this.roomRow()) return false;
      this.db
        .prepare("INSERT INTO threads(id, kind, title, created_by, created_at, updated_at) VALUES (?, 'room', ?, ?, ?, ?)")
        .run(id, ROOM_TITLE, master.id, t, t);
      const agents = (this.db.prepare("SELECT id FROM participants WHERE kind = 'agent' AND disabled_at IS NULL").all() as Row[]).map(
        (r) => r.id as string,
      );
      this.insertMembers(id, [master.id, ...agents], t);
      return true;
    })();
    if (!created) return this.roomRow()!.id;
    this.emit({ notice: { t: 'thread', thread_id: id }, threadId: id });
    return id;
  }

  /** 마스터 화면: 에이전트별 연결 상태. 토큰 값·해시는 내지 않는다 */
  listAgents(pr: Principal): AgentStatus[] {
    this.requireMaster(pr, 'agents.view');
    const t = now();
    const agents = this.db.prepare("SELECT id, name FROM participants WHERE kind = 'agent' AND disabled_at IS NULL ORDER BY id").all() as Row[];
    const creds = this.db.prepare('SELECT participant_id, revoked_at, expires_at, last_used_at FROM credentials').all() as Row[];
    return agents.map((a) => {
      const mine = creds.filter((c) => c.participant_id === a.id);
      const active = mine.filter((c) => !c.revoked_at && !(c.expires_at && c.expires_at <= t));
      const last = mine.reduce<number | null>((m, c) => (c.last_used_at && (m === null || c.last_used_at > m) ? c.last_used_at : m), null);
      const lastActive = active.reduce<number | null>((m, c) => (c.last_used_at && (m === null || c.last_used_at > m) ? c.last_used_at : m), null);
      const state: AgentStatus['state'] =
        mine.length === 0 ? 'no_credential' : active.length === 0 ? 'revoked' : lastActive === null ? 'never' : 'seen';
      return {
        id: a.id,
        name: a.name,
        state,
        last_seen_at: last,
        credentials: { active: active.length, revoked_or_expired: mine.length - active.length },
      };
    });
  }

  /** 스레드 생성·분기의 중복 방지 키 */
  private threadKey(v: unknown): string | null {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || v.length > 128) throw new ApiError(400, 'bad_request', 'client_key: string ≤128');
    return v;
  }

  /** 같은 생성자·같은 키의 스레드가 있으면 돌려준다. 같은 요청의 재시도가 아니면 409 */
  private existingByKey(createdBy: string, key: string | null, same: (r: Row) => boolean): Row | undefined {
    if (key === null) return undefined;
    const r = this.db.prepare('SELECT * FROM threads WHERE created_by = ? AND client_key = ?').get(createdBy, key) as Row | undefined;
    if (r && !same(r)) throw new ApiError(409, 'client_key_reused', 'client_key was used for a different thread request');
    return r;
  }

  listThreads(pr: Principal): Thread[] {
    const base = `SELECT t.*, (SELECT MAX(seq) FROM messages m WHERE m.thread_id = t.id) AS last_seq FROM threads t`;
    const rows = pr.participant.is_master
      ? (this.db.prepare(`${base} ORDER BY t.kind = 'room' DESC, t.created_at`).all() as Row[])
      : this.readAll(pr)
      ? (this.db.prepare(`${base} WHERE t.deleted_at IS NULL ORDER BY t.kind = 'room' DESC, t.created_at`).all() as Row[])
      : (this.db
          .prepare(
            `${base} JOIN thread_members tm ON tm.thread_id = t.id AND tm.participant_id = ? AND tm.can_read = 1 WHERE t.deleted_at IS NULL ORDER BY t.kind = 'room' DESC, t.created_at`,
          )
          .all(pr.participant.id) as Row[]);
    return rows.map(toThread);
  }

  getThread(pr: Principal, threadId: string) {
    const t = this.requireRead(pr, threadId, 'thread.read', true);
    const last = this.db.prepare('SELECT MAX(seq) AS s FROM messages WHERE thread_id = ?').get(threadId) as Row;
    const members = this.db
      .prepare(
        `SELECT tm.participant_id, p.name, p.kind, tm.can_read, tm.can_post, tm.can_invoke
         FROM thread_members tm JOIN participants p ON p.id = tm.participant_id WHERE tm.thread_id = ? ORDER BY p.kind DESC, p.id`,
      )
      .all(threadId) as Row[];
    const sessions = (
      this.db.prepare('SELECT * FROM agent_sessions WHERE thread_id = ? ORDER BY agent_id, generation').all(threadId) as Row[]
    ).map((r) => (r.status === 'active' ? { ...toSession(r), metrics: this.sessionMetrics(r.id as string) } : toSession(r)));
    return {
      rotate_policy: { tokens: this.cfg.rotateTokens, replies: this.cfg.rotateReplies, carry_messages: this.cfg.carryMessages },
      thread: toThread({ ...t, last_seq: last.s }),
      members: members.map((m) => ({
        participant_id: m.participant_id,
        name: m.name,
        kind: m.kind,
        can_read: !!m.can_read,
        can_post: !!m.can_post,
        can_invoke: !!m.can_invoke,
      })),
      sessions,
      // 합치기(#706): 하위 스레드면 지난 합침들과 아직 안 합친 제 글 수
      ...(t.parent_thread_id && this.merge
        ? {
            merges: (this.db.prepare('SELECT message_seq, parent_thread_id, from_seq, to_seq, count, created_at FROM thread_merges WHERE child_thread_id = ? ORDER BY message_seq').all(threadId) as Row[]).map((r) => ({ ...r })),
            unmerged: this.merge.unmergedOf(threadId).rows.length,
          }
        : {}),
      // 마스터 화면만: 이 스레드의 보류된 요청(확인 안 한 것 먼저) — 머리 «보류된 요청 N» · 보조 패널 «실행» 탭
      ...(this.requests && pr.participant.is_master && pr.via === 'cookie'
        ? { request_holds: (this.db.prepare('SELECT * FROM request_holds WHERE thread_id = ? ORDER BY acked_at IS NOT NULL, created_at DESC LIMIT 100').all(threadId) as Row[]).map(toHold) }
        : {}),
    };
  }

  createThread(
    pr: Principal,
    input: { title?: unknown; default_recipient?: unknown; members?: unknown; kind?: unknown; client_key?: unknown },
  ): { thread: Thread; duplicate: boolean } {
    this.requireMaster(pr, 'thread.create');
    // 메인 채팅방은 하나뿐이고 서버가 만든다 — API 로 방을 더 만들 수 없다
    if (input.kind !== undefined && input.kind !== 'thread') throw new ApiError(409, 'room_exists', 'the main room is created by the server and is unique');
    const title = reqString(input.title, 'title', 200).trim();
    if (!title) throw new ApiError(400, 'bad_request', 'title required');
    const ckey = this.threadKey(input.client_key);
    const members = new Set<string>();
    if (input.members !== undefined) {
      if (!Array.isArray(input.members)) throw new ApiError(400, 'bad_request', 'members must be an array');
      for (const m of input.members) {
        if (typeof m !== 'string' || !this.getParticipant(m)) throw new ApiError(400, 'bad_member', `unknown participant ${m}`);
        members.add(m);
      }
    }
    let dr: string | null = null;
    if (input.default_recipient !== undefined && input.default_recipient !== null && input.default_recipient !== '') {
      if (typeof input.default_recipient !== 'string') throw new ApiError(400, 'bad_request');
      const p = this.getParticipant(input.default_recipient);
      if (!p || p.kind !== 'agent') throw new ApiError(400, 'bad_recipient', '기본 수신자는 에이전트여야 한다', undefined, { key: 'err.bad_recipient.default_agent' });
      dr = p.id;
      members.add(p.id);
    }
    members.add(pr.participant.id);
    const id = newId('th');
    const t = now();
    const dup = this.db.transaction(() => {
      const ex = this.existingByKey(pr.participant.id, ckey, (r) => r.parent_thread_id === null && r.title === title && r.kind === 'thread');
      if (ex) {
        this.audit({ actor: this.actorOf(pr), action: 'thread.create', target_type: 'thread', target_id: ex.id, thread_id: ex.id, result: 'noop', reason: 'duplicate' });
        return ex.id as string;
      }
      this.db
        .prepare('INSERT INTO threads(id, title, default_recipient, created_by, created_at, updated_at, client_key) VALUES (?,?,?,?,?,?,?)')
        .run(id, title, dr, pr.participant.id, t, t, ckey);
      this.insertMembers(id, members, t);
      // 스레드 생성도 열람·게시 권한 부여다 — 누가 멤버가 됐는지 남긴다
      this.audit({ actor: this.actorOf(pr), action: 'thread.create', target_type: 'thread', target_id: id, thread_id: id, result: 'ok', after: { members: [...members], default_recipient: dr } });
      return null;
    })();
    if (dup) return { thread: this.getThread(pr, dup).thread, duplicate: true };
    this.emit({ notice: { t: 'thread', thread_id: id }, threadId: id });
    return { thread: this.getThread(pr, id).thread, duplicate: false };
  }

  private insertMembers(threadId: string, members: Iterable<string>, t: number) {
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO thread_members(thread_id, participant_id, can_read, can_post, can_invoke, added_at) VALUES (?,?,?,?,?,?)',
    );
    for (const m of members) {
      const p = this.getParticipant(m)!;
      // 사람은 호출 권한까지. 에이전트는 읽기·게시만 (에이전트 간 자동 호출은 끔)
      ins.run(threadId, m, 1, 1, p.kind === 'human' ? 1 : 0, t);
    }
  }

  setMember(pr: Principal, threadId: string, input: { participant_id?: unknown; can_read?: unknown; can_post?: unknown; remove?: unknown }) {
    this.requireMaster(pr, 'member.set', { target_type: 'thread', target_id: threadId, thread_id: threadId });
    this.requireThread(threadId);
    const failed = (err: ApiError): never => {
      this.audit({
        actor: this.actorOf(pr),
        action: input.remove === true ? 'member.remove' : 'member.set',
        target_type: 'participant',
        target_id: typeof input.participant_id === 'string' ? input.participant_id.slice(0, 64) : null,
        thread_id: threadId,
        result: 'failed',
        reason: err.code,
      });
      throw err;
    };
    if (typeof input.participant_id !== 'string') failed(new ApiError(400, 'bad_request'));
    const p = this.getParticipant(input.participant_id as string);
    if (!p) return failed(new ApiError(400, 'bad_member'));
    if (p.is_master) failed(new ApiError(400, 'master_always_member', 'master is always a member'));
    const view = (m: Row | undefined) => (m ? { member: true, can_read: !!m.can_read, can_post: !!m.can_post, can_invoke: !!m.can_invoke } : { member: false });
    this.db.transaction(() => {
      const before = this.membership(threadId, p.id);
      if (input.remove === true) {
        this.db.prepare('DELETE FROM thread_members WHERE thread_id = ? AND participant_id = ?').run(threadId, p.id);
      } else {
        this.db
          .prepare(
            `INSERT INTO thread_members(thread_id, participant_id, can_read, can_post, can_invoke, added_at) VALUES (?,?,?,?,0,?)
             ON CONFLICT(thread_id, participant_id) DO UPDATE SET can_read = excluded.can_read, can_post = excluded.can_post`,
          )
          .run(threadId, p.id, input.can_read === false ? 0 : 1, input.can_post === false ? 0 : 1, now());
      }
      const after = this.membership(threadId, p.id);
      const b = view(before);
      const a = view(after);
      // 권한 부여·회수(정책 9): 이전 상태와 확정된 결과
      this.audit({
        actor: this.actorOf(pr),
        action: input.remove === true ? 'member.remove' : 'member.set',
        target_type: 'participant',
        target_id: p.id,
        thread_id: threadId,
        result: JSON.stringify(b) === JSON.stringify(a) ? 'noop' : 'ok',
        reason: JSON.stringify(b) === JSON.stringify(a) ? 'unchanged' : null,
        before: b,
        after: a,
      });
    })();
    this.emit({ notice: { t: 'thread', thread_id: threadId }, threadId });
    return this.getThread(pr, threadId);
  }

  /** 스레드가 «보는» 메시지 seq 인가 — 자기 메시지 + 분기 때 가져온 메시지 */
  private visibleInThread(threadId: string, seq: number): boolean {
    const r = this.db
      .prepare(
        `SELECT 1 FROM messages WHERE seq = ? AND thread_id = ?
         UNION ALL SELECT 1 FROM thread_context WHERE thread_id = ? AND message_seq = ? LIMIT 1`,
      )
      .get(seq, threadId, threadId, seq);
    return !!r;
  }

  forkThread(
    pr: Principal,
    threadId: string,
    input: { from_seq?: unknown; title?: unknown; include?: unknown; default_recipient?: unknown; client_key?: unknown },
  ): { thread: Thread; duplicate: boolean } {
    this.requireMaster(pr, 'thread.fork', { target_type: 'thread', target_id: threadId, thread_id: threadId });
    const ckey = this.threadKey(input.client_key);
    const parent = this.requireRead(pr, threadId);
    if (parent.deleted_at) throw new ApiError(409, 'thread_deleted');
    const fromSeq = optInt(input.from_seq, 'from_seq');
    if (fromSeq === null || !this.visibleInThread(threadId, fromSeq))
      throw new ApiError(400, 'bad_fork_point', 'from_seq must be a message visible in the thread');
    const title = reqString(input.title ?? tr(this.lang(), 'srv.fork_title', { title: parent.title }), 'title', 200);
    const candidates = (
      this.db
        .prepare(
          `SELECT seq FROM messages WHERE thread_id = ? AND seq <= ?
           UNION SELECT message_seq FROM thread_context WHERE thread_id = ? AND message_seq <= ? ORDER BY 1`,
        )
        .all(threadId, fromSeq, threadId, fromSeq) as Row[]
    ).map((r) => r.seq as number);
    let chosen: number[];
    const inc = input.include ?? 'upto';
    if (inc === 'upto') chosen = candidates;
    else if (inc === 'none') chosen = [];
    else if (Array.isArray(inc)) {
      const set = new Set(candidates);
      chosen = [];
      for (const s of inc) {
        if (typeof s !== 'number' || !set.has(s)) throw new ApiError(400, 'bad_include', `seq ${s} is not before the fork point`);
        chosen.push(s);
      }
    } else throw new ApiError(400, 'bad_include', "include: 'upto' | 'none' | seq[]");

    let dr: string | null = parent.default_recipient;
    if (typeof input.default_recipient === 'string' && input.default_recipient) {
      const p = this.getParticipant(input.default_recipient);
      if (!p || p.kind !== 'agent') throw new ApiError(400, 'bad_recipient');
      dr = p.id;
    }
    const id = newId('th');
    const t = now();
    const dup = this.db.transaction(() => {
      // 같은 요청의 재시도(응답 유실·두 번 누름)면 새로 만들지 않고 처음 것을 돌려준다
      const ex = this.existingByKey(pr.participant.id, ckey, (r) => r.parent_thread_id === threadId && r.fork_seq === fromSeq && r.title === title);
      if (ex) {
        this.audit({ actor: this.actorOf(pr), action: 'thread.fork', target_type: 'thread', target_id: ex.id, thread_id: ex.id, result: 'noop', reason: 'duplicate' });
        return ex.id as string;
      }
      this.db
        .prepare(
          'INSERT INTO threads(id, title, default_recipient, parent_thread_id, fork_seq, created_by, created_at, updated_at, client_key) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run(id, title, dr, threadId, fromSeq, pr.participant.id, t, t, ckey);
      this.db
        .prepare(
          `INSERT INTO thread_members(thread_id, participant_id, can_read, can_post, can_invoke, added_at)
           SELECT ?, participant_id, can_read, can_post, can_invoke, ? FROM thread_members WHERE thread_id = ?`,
        )
        .run(id, t, threadId);
      const members = new Set<string>([pr.participant.id]);
      if (dr) members.add(dr);
      this.insertMembers(id, members, t);
      const ins = this.db.prepare('INSERT INTO thread_context(thread_id, message_seq) VALUES (?,?)');
      for (const s of chosen) ins.run(id, s);
      const mem = (this.db.prepare('SELECT participant_id FROM thread_members WHERE thread_id = ?').all(id) as Row[]).map((r) => r.participant_id);
      this.audit({
        actor: this.actorOf(pr),
        action: 'thread.fork',
        target_type: 'thread',
        target_id: id,
        thread_id: id,
        result: 'ok',
        after: { parent_thread_id: threadId, fork_seq: fromSeq, included: chosen.length, members: mem },
      });
      return null;
    })();
    if (dup) return { thread: this.getThread(pr, dup).thread, duplicate: true };
    this.emit({ notice: { t: 'thread', thread_id: id }, threadId: id });
    return { thread: this.getThread(pr, id).thread, duplicate: false };
  }

  // ───────────────────────── 메시지 ─────────────────────────

  private attachmentsFor(seqs: number[]): Map<number, AttachmentInfo[]> {
    const map = new Map<number, AttachmentInfo[]>();
    if (seqs.length === 0) return map;
    const rows = this.db
      .prepare(`SELECT id, message_seq, name, kind, mime, size FROM attachments WHERE message_seq IN (${seqs.map(() => '?').join(',')}) ORDER BY rowid`)
      .all(...seqs) as Row[];
    for (const r of rows) {
      const list = map.get(r.message_seq) ?? [];
      list.push({ id: r.id, name: r.name, kind: r.kind, size: r.size, mime: r.mime });
      map.set(r.message_seq, list);
    }
    return map;
  }

  /** @internal */ withAttachments(msgs: Message[]): Message[] {
    const map = this.attachmentsFor(msgs.map((m) => m.seq));
    const mg = this.merge?.mergesFor(msgs.map((m) => m.seq));
    const tg = this.tags.tagsFor(msgs.map((m) => m.seq));
    const qm = this.questions?.questionsFor(msgs.map((m) => m.seq));
    return msgs.map((m) => ({
      ...m,
      attachments: map.get(m.seq) ?? [],
      tags: tg.get(m.seq) ?? { primary: [], inline: [] },
      ...(mg?.has(m.seq) ? { merge: mg.get(m.seq) } : {}),
      ...(qm?.has(m.seq) ? { question: qm.get(m.seq) } : {}),
    }));
  }

  /** 커서 뒤(after)로 오름차순. older 를 주면 거꾸로 — before 보다 작은 글 중 가장 최근 limit 개(before = null 이면 맨 끝부터 · 방을 열 때 최근 글만 · 마스터 #1732).
   *  older 쪽의 has_more 는 «그보다 옛 글이 더 있나» · next_cursor 는 받은 글의 가장 큰 seq(없으면 after/0). 어느 쪽이든 글은 seq 오름차순이다. */
  listMessages(pr: Principal, threadId: string, after = 0, limit = 200, older?: { before: number | null }): { messages: Message[]; next_cursor: number; has_more: boolean } {
    this.requireRead(pr, threadId, 'thread.read', true);
    const lim = Math.min(Math.max(1, limit), 500);
    if (older) {
      const rows = (
        older.before == null
          ? this.db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT ?').all(threadId, lim + 1)
          : this.db.prepare('SELECT * FROM messages WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(threadId, older.before, lim + 1)
      ) as Row[];
      const has_more = rows.length > lim;
      const msgs = this.withAttachments(rows.slice(0, lim).reverse().map(toMessage));
      return { messages: msgs, next_cursor: msgs.length ? msgs[msgs.length - 1].seq : 0, has_more };
    }
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(threadId, after, lim + 1) as Row[];
    const has_more = rows.length > lim;
    const msgs = this.withAttachments(rows.slice(0, lim).map(toMessage));
    return { messages: msgs, next_cursor: msgs.length ? msgs[msgs.length - 1].seq : after, has_more };
  }

  /** 분기 때 부모에서 가져온 메시지(읽기 전용 맥락) */
  getContext(pr: Principal, threadId: string): Message[] {
    this.requireRead(pr, threadId, 'thread.read', true);
    const rows = this.db
      .prepare(
        'SELECT m.* FROM thread_context c JOIN messages m ON m.seq = c.message_seq WHERE c.thread_id = ? ORDER BY m.seq',
      )
      .all(threadId) as Row[];
    return this.withAttachments(rows.map(toMessage));
  }

  postMessage(
    pr: Principal,
    threadId: string,
    input: PostInput,
  ): { message: Message; duplicate: boolean; deliveries: string[]; invoke_paused: boolean; target: { id: string; title: string; kind: Thread['kind'] } } {
    const me = pr.participant;
    // 사칭: 작성자는 서버가 인증으로 정한다. 다른 값을 내밀면 거절한다.
    const dn = (code: string, msg?: string, i18n?: ApiError['i18n']): never =>
      this.deny(pr, new ApiError(403, code, msg, undefined, i18n), { action: 'thread.post', target_type: 'thread', target_id: threadId, thread_id: threadId });
    if (input.author_id !== undefined && input.author_id !== me.id) dn('impersonation', 'author is set by the server');
    const thread = this.requireRead(pr, threadId, 'thread.post');
    if (!me.is_master && !this.membership(threadId, me.id)?.can_post) dn('no_post_permission');
    if (thread.deleted_at) throw new ApiError(409, 'thread_deleted');
    if (thread.status !== 'open') throw new ApiError(409, 'thread_closed');

    const clientKey = reqString(input.client_key, 'client_key', 128);
    let uploadIds: string[] = [];
    if (input.attachments !== undefined && input.attachments !== null) {
      if (!Array.isArray(input.attachments) || input.attachments.some((x) => typeof x !== 'string')) throw new ApiError(400, 'bad_attachment');
      uploadIds = [...new Set(input.attachments as string[])];
      if (uploadIds.length > this.cfg.attachmentMaxPerMessage)
        throw new ApiError(400, 'too_many_attachments', `한 메시지에 ${this.cfg.attachmentMaxPerMessage}개까지`, undefined, { key: 'err.too_many_attachments.max', vars: { max: this.cfg.attachmentMaxPerMessage } });
    }
    // 첨부가 있으면 본문은 비어도 된다(그림만 보내기)
    const body = uploadIds.length && (input.body === '' || input.body === undefined) ? '' : reqString(input.body, 'body', this.cfg.bodyMaxChars);
    if (!body.trim() && !uploadIds.length) throw new ApiError(400, 'bad_request', 'body is blank');

    const human = me.kind === 'human';
    const sourceKind = (input.source_kind ?? (human ? 'instruction' : 'observation')) as SourceKind;
    if (!SOURCE_KINDS.includes(sourceKind)) throw new ApiError(400, 'bad_source_kind');
    // 에이전트 출력은 «사용자 지시»로 승격되지 않는다
    if (!human && sourceKind === 'instruction') dn('source_kind_forbidden', 'agents cannot post instructions');
    const inputMode = (input.input_mode ?? 'text') as InputMode;
    if (!INPUT_MODES.includes(inputMode)) throw new ApiError(400, 'bad_input_mode');
    if (!human && inputMode !== 'text') dn('bad_input_mode');

    const replyTo = optInt(input.reply_to_seq, 'reply_to_seq');
    const quoteOf = optInt(input.quote_of_seq, 'quote_of_seq');
    for (const [s, n] of [
      [replyTo, 'reply_to_seq'],
      [quoteOf, 'quote_of_seq'],
    ] as const)
      if (s !== null && !this.visibleInThread(threadId, s)) throw new ApiError(400, 'bad_ref', `${n} not in thread`);

    // 수신자는 구조화된 칸으로만. 본문 속 @이름은 호출이 아니다.
    let recipients: string[];
    if (input.recipients === undefined || input.recipients === null) {
      recipients = human && thread.default_recipient ? [thread.default_recipient] : [];
    } else {
      if (!Array.isArray(input.recipients) || input.recipients.some((r) => typeof r !== 'string'))
        throw new ApiError(400, 'bad_recipients');
      recipients = [...new Set(input.recipients as string[])];
    }
    // 대면 모드(마스터 #581): 마스터 글의 받는 이는 서버가 정한다 — 새 라운드면 초안 쪽 · 질문 답이면 물은 쪽 · 도는 중이면 글만
    // 대면 모듈이 꺼져 있으면(BRAINSTORM_MODULES · 마스터 #1207) 대면 모드였던 스레드도 보통 채팅으로 돈다
    const fm = human && thread.mode === 'face' && thread.kind !== 'room' ? this.face : null;
    const face = !!fm;
    if (fm) {
      recipients = [];
      const fr = fm.faceLatest(threadId);
      if (!thread.invoke_paused && !(fr && (fr.state === 'running' || fr.state === 'question'))) fm.faceCheckMembers(threadId);
    }
    // 요청(마스터 #352): 에이전트 간 호출 금지의 유일한 예외 — 출처 request · 받는 이 한 명 · 허용 짝 · 새 호출 금지 아님 · 연쇄 상한 안
    const request = sourceKind === 'request';
    if (request) {
      if (human || !this.requests) dn('source_kind_forbidden', 'request is for agents');
      const rq = this.requests!;
      if (recipients.length !== 1) throw new ApiError(400, 'bad_recipients', '요청은 받는 이 한 명', undefined, { key: 'err.bad_recipients.request_one' });
      const why = rq.requestBlock(thread, me.id, recipients[0]);
      if (why === 'request_pair_not_allowed') dn(why, `${me.id} → ${recipients[0]} 는 허용 짝이 아니다`, { key: 'err.request_pair_not_allowed', vars: { from: me.id, to: recipients[0] } });
      if (why === 'invoke_paused')
        this.deny(pr, new ApiError(409, 'invoke_paused', '새 호출 금지 중', undefined, { key: 'err.invoke_paused.paused' }), { action: 'request.create', target_type: 'thread', target_id: threadId, thread_id: threadId });
      if (why === 'request_chain_limit') {
        rq.recordHold({ thread_id: threadId, request_seq: null, requester_id: me.id, recipient_id: recipients[0], kind: 'chain_limit', reason: 'request_chain_limit', note: body.slice(0, 4000), run_id: null });
        this.deny(pr, new ApiError(409, 'request_chain_limit', `마스터 글 뒤 요청 ${this.cfg.requestChainMax}개 — 마스터 확인 필요`, undefined, { key: 'err.request_chain_limit', vars: { max: this.cfg.requestChainMax } }), {
          action: 'request.create', target_type: 'thread', target_id: threadId, thread_id: threadId,
        });
      }
    } else if (!human && recipients.length > 0) dn('agent_invocation_disabled', 'agent-to-agent invocation is disabled');
    if (!request && recipients.length > 0 && !me.is_master && !this.membership(threadId, me.id)?.can_invoke) dn('no_invoke_permission');
    for (const r of recipients) {
      const p = this.getParticipant(r);
      if (!p || p.kind !== 'agent') throw new ApiError(400, 'bad_recipient', `${r} is not an agent`);
      if (!this.membership(threadId, r)?.can_read) throw new ApiError(400, 'bad_recipient', `${r} is not a member of the thread`);
    }
    let budget = face ? null : optInt(input.call_budget, 'call_budget');
    if (budget === null) budget = recipients.length > 0 && !request ? this.cfg.defaultCallBudget : null;
    if (budget !== null && (budget < 0 || budget > this.cfg.maxCallBudget))
      throw new ApiError(400, 'bad_call_budget', `0..${this.cfg.maxCallBudget}`);
    if (budget !== null && recipients.length > budget) throw new ApiError(400, 'call_budget_exceeded');

    if (uploadIds.length) this.sweepUploads();
    // 태그(사양 2.1): 보기의 주 태그 + 첫 줄 태그 줄 ≤2 · 본문 속은 인라인 · 넘치면 400 · 보관 태그는 거절 — 글을 남기기 전에 가른다
    const tagSet0 = this.tags.resolve(body, 'head', input.tags);
    const tagSet = replyTo !== null ? this.tags.inheritReply(tagSet0, replyTo) : tagSet0;
    const t = now();
    let faceRound: Row | undefined;
    let faceTo: string | null = null;
    const result = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM messages WHERE author_id = ? AND client_key = ?').get(me.id, clientKey) as
        | Row
        | undefined;
      if (existing) {
        if (existing.thread_id !== threadId || existing.body !== body) throw new ApiError(409, 'client_key_reused');
        const ds = (this.db.prepare('SELECT id FROM deliveries WHERE message_seq = ?').all(existing.seq) as Row[]).map((d) => d.id);
        return { message: toMessage(existing), duplicate: true, deliveries: ds };
      }
      // 업로드는 내 것이고 아직 안 묶인 것만(남의 것·이미 쓴 것·걷힌 것은 거절 — 메시지도 남기지 않는다)
      const ups = uploadIds.map((id) => this.db.prepare('SELECT * FROM uploads WHERE id = ? AND owner_id = ?').get(id, me.id) as Row | undefined);
      if (ups.some((u) => !u)) throw new ApiError(400, 'bad_attachment', '업로드가 없거나 이미 쓰였거나 만료됐다', undefined, { key: 'err.bad_attachment.upload' });
      const id = newId('msg');
      const info = this.db
        .prepare(
          `INSERT INTO messages(id, thread_id, author_id, client_key, body, reply_to_seq, quote_of_seq, source_kind, input_mode, recipients, call_budget, hop, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)`,
        )
        .run(id, threadId, me.id, clientKey, body, replyTo, quoteOf, sourceKind, inputMode, JSON.stringify(recipients), budget, t);
      const seq = Number(info.lastInsertRowid);
      // 첨부를 배달보다 먼저 묶는다 — 에이전트는 첨부가 다 붙은 메시지만 받는다
      for (const u of ups as Row[]) {
        this.db
          .prepare('INSERT INTO attachments(id, message_seq, kind, mime, name, path, size, sha256, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(u.id, seq, u.kind, u.mime, u.name, u.path, u.size, u.sha256, t);
        this.db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id);
      }
      this.tags.attach(seq, tagSet);
      const ds: string[] = [];
      if (face && !thread.invoke_paused) {
        const f = fm!.faceMasterPost(threadId, seq, t);
        faceRound = f.round;
        if (f.to) {
          const did = newId('dlv');
          this.db
            .prepare(`INSERT INTO deliveries(id, message_seq, thread_id, recipient_id, status, attempts, created_at, updated_at) VALUES (?,?,?,?, 'pending', 0, ?, ?)`)
            .run(did, seq, threadId, f.to, t, t);
          ds.push(did);
          faceTo = f.to;
        }
      }
      if (!thread.invoke_paused) {
        const ins = this.db.prepare(
          `INSERT INTO deliveries(id, message_seq, thread_id, recipient_id, status, attempts, created_at, updated_at) VALUES (?,?,?,?, 'pending', 0, ?, ?)`,
        );
        for (const r of recipients) {
          const did = newId('dlv');
          ins.run(did, seq, threadId, r, t, t);
          ds.push(did);
        }
      }
      this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(t, threadId);
      if (request) this.requests!.auditRequest(pr, threadId, seq, recipients[0], 'ok', null, ds[0] ?? null);
      const row = this.db.prepare('SELECT * FROM messages WHERE seq = ?').get(seq) as Row;
      return { message: toMessage(row), duplicate: false, deliveries: ds };
    })();
    if (!result.duplicate) {
      this.emit({ notice: { t: 'msg', thread_id: threadId, seq: result.message.seq }, threadId });
      if (result.deliveries.length)
        for (const r of recipients) this.emit({ notice: { t: 'delivery', thread_id: threadId }, threadId, only: r });
      if (faceTo) this.emit({ notice: { t: 'delivery', thread_id: threadId }, threadId, only: faceTo });
      if (faceRound) fm!.faceEmit(fm!.faceRow(faceRound.id)!);
    }
    return {
      ...result,
      message: this.withAttachments([result.message])[0],
      invoke_paused: !!thread.invoke_paused,
      // 서버가 확정한 게시 대상(URL 의 스레드) — 화면 맥락과 달라도 여기에만 저장된다
      target: { id: thread.id as string, title: thread.title as string, kind: (thread.kind === 'room' ? 'room' : 'thread') as Thread['kind'] },
    };
  }

  // ───────────────────────── 첨부 ─────────────────────────

  addAttachment(pr: Principal, threadId: string, seq: number, name: string, data: Buffer): AttachmentInfo {
    this.requireRead(pr, threadId, 'attachment.add');
    const m = this.db.prepare('SELECT * FROM messages WHERE seq = ? AND thread_id = ?').get(seq, threadId) as Row | undefined;
    if (!m) throw new ApiError(404, 'no_message');
    if (m.author_id !== pr.participant.id)
      this.deny(pr, new ApiError(403, 'not_author'), { action: 'attachment.add', target_type: 'message', target_id: String(seq), thread_id: threadId });
    this.checkAttachmentSize(data);
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE message_seq = ?').get(seq) as Row).n as number;
    if (count >= this.cfg.attachmentMaxPerMessage) throw new ApiError(400, 'too_many_attachments');
    const safeName = safeFileName(name);
    const { kind, mime } = sniffAttachment(data);
    const id = newId('att');
    const rel = this.writeAttachmentFile(id, data);
    this.db
      .prepare('INSERT INTO attachments(id, message_seq, kind, mime, name, path, size, sha256, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, seq, kind, mime, safeName, rel, data.length, sha256(data), now());
    this.emit({ notice: { t: 'msg', thread_id: threadId, seq }, threadId });
    return { id, name: safeName, kind, size: data.length, mime };
  }

  private checkAttachmentSize(data: Buffer) {
    if (data.length === 0) throw new ApiError(400, 'empty');
    if (data.length > this.cfg.attachmentMaxBytes) throw new ApiError(413, 'too_large');
  }

  /** 파일을 먼저 쓰고(fsync) 행을 넣는다 — 백업의 DB 스냅숏이 가리키는 파일은 항상 있다. 데이터 디렉터리 기준 상대 경로를 돌려준다 */
  private writeAttachmentFile(id: string, data: Buffer): string {
    fs.mkdirSync(this.cfg.attachmentsDir, { recursive: true });
    const fd = fs.openSync(path.join(this.cfg.attachmentsDir, id), 'wx', 0o640);
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return path.join('attachments', id);
  }

  /** 메시지보다 먼저 올리는 파일. 메시지를 쓸 때 attachments 로 묶인다. 안 묶이면 uploadTtlMs 뒤 걷힌다 */
  addUpload(pr: Principal, name: string, data: Buffer): UploadInfo {
    this.checkAttachmentSize(data);
    this.sweepUploads();
    const me = pr.participant.id;
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE owner_id = ?').get(me) as Row).n as number;
    if (n >= this.cfg.maxPendingUploads) throw new ApiError(429, 'too_many_uploads', '묶지 않은 업로드가 너무 많다', undefined, { key: 'err.too_many_uploads' });
    const safeName = safeFileName(name);
    const { kind, mime } = sniffAttachment(data);
    const id = newId('att'); // 묶이면 그대로 첨부 id 가 된다(파일 이름도)
    const rel = this.writeAttachmentFile(id, data);
    this.db
      .prepare('INSERT INTO uploads(id, owner_id, kind, mime, name, path, size, sha256, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, me, kind, mime, safeName, rel, data.length, sha256(data), now());
    return { id, name: safeName, kind, mime, size: data.length };
  }

  /** 묶기 전에 버린 업로드 — 주인만. 행과 파일을 지운다 */
  deleteUpload(pr: Principal, id: string): { ok: true } {
    const u = this.db.prepare('SELECT * FROM uploads WHERE id = ? AND owner_id = ?').get(id, pr.participant.id) as Row | undefined;
    if (!u) throw new ApiError(404, 'no_upload');
    this.db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
    fs.rmSync(path.join(this.cfg.dataDir, u.path), { force: true });
    return { ok: true };
  }

  /** 만료된(묶이지 않은) 업로드를 걷는다. 행을 먼저 지우고 파일은 뒤에 */
  sweepUploads(t = now()): number {
    const rows = this.db.prepare('SELECT id, path FROM uploads WHERE created_at <= ?').all(t - this.cfg.uploadTtlMs) as Row[];
    if (!rows.length) return 0;
    const del = this.db.prepare('DELETE FROM uploads WHERE id = ?');
    this.db.transaction(() => {
      for (const r of rows) del.run(r.id);
    })();
    for (const r of rows) fs.rmSync(path.join(this.cfg.dataDir, r.path), { force: true });
    return rows.length;
  }

  getAttachment(pr: Principal, id: string): { name: string; fullPath: string; size: number; kind: string; mime: string } {
    const a = this.db
      .prepare('SELECT a.*, m.thread_id FROM attachments a JOIN messages m ON m.seq = a.message_seq WHERE a.id = ?')
      .get(id) as Row | undefined;
    if (!a) throw new ApiError(404, 'no_attachment');
    // 자기 스레드 또는 그 메시지를 가져온 분기 스레드에서 읽을 수 있으면 된다
    const threads = [
      a.thread_id,
      ...(this.db.prepare('SELECT thread_id FROM thread_context WHERE message_seq = ?').all(a.message_seq) as Row[]).map((r) => r.thread_id),
    ];
    if (!threads.some((t) => this.canRead(pr.participant.id, t)))
      this.deny(pr, new ApiError(404, 'no_attachment'), { action: 'attachment.read', target_type: 'attachment', target_id: id, thread_id: a.thread_id, reason: 'not_member' });
    return { name: a.name, fullPath: path.join(this.cfg.dataDir, a.path), size: a.size, kind: a.kind, mime: a.mime };
  }

  // ───────────────────────── 세션 ─────────────────────────

  private activeSession(threadId: string, agentId: string, lane = ''): Row | undefined {
    return this.db
      .prepare("SELECT * FROM agent_sessions WHERE thread_id = ? AND agent_id = ? AND lane = ? AND status = 'active'")
      .get(threadId, agentId, lane) as Row | undefined;
  }

  /** 차선(마스터 #1563): 글의 첫 주 태그 id — 없으면 '' (기본 차선). claim 의 SQL 식과 같은 규칙 */
  private laneOf(seq: number): string {
    const r = this.db.prepare(LANE_SQL).get(seq) as Row | undefined;
    return (r?.lane as string) ?? '';
  }

  private nextGeneration(threadId: string, agentId: string): number {
    const max = this.db.prepare('SELECT MAX(generation) AS g FROM agent_sessions WHERE thread_id = ? AND agent_id = ?').get(threadId, agentId) as Row;
    return (max.g ?? 0) + 1;
  }

  /** 새 세대의 경계: 교체 시점 스레드의 마지막 seq (분기로 가져온 맥락 포함) */
  private threadMaxSeq(threadId: string): number | null {
    const r = this.db
      .prepare('SELECT MAX(seq) AS s FROM messages WHERE thread_id = ? OR seq IN (SELECT message_seq FROM thread_context WHERE thread_id = ?)')
      .get(threadId, threadId) as Row;
    return r.s ?? null;
  }

  /** 이 세대가 이미 본 마지막 seq: 성공한 실행이 남긴 답의 seq 최댓값. 없으면 세대 경계 */
  private sessionSeenSeq(session: Row, exceptRunId?: string): number | null {
    const r = this.db
      // 전달 실행은 «실제로 받은 맥락의 끝»(seen_upto)까지만 본 것으로 친다 — 답 seq 로 뛰면 그 사이 글이 조용히 «본 것»이 된다
      .prepare("SELECT MAX(COALESCE(seen_upto, result_seq)) AS s FROM runs WHERE session_id = ? AND state = 'succeeded' AND id <> ?")
      .get(session.id, exceptRunId ?? '') as Row;
    const seen = r.s ?? null;
    const base = session.base_seq ?? null;
    if (seen === null) return base;
    return base === null ? seen : Math.max(seen, base);
  }

  private ensureSession(threadId: string, agentId: string, lane = ''): Row {
    const s = this.activeSession(threadId, agentId, lane);
    if (s) return s;
    const id = newId('ses');
    // 세대 번호는 차선과 상관없이 이 방 × 에이전트에서 MAX+1(UNIQUE 제약 · 어댑터 세션 키가 세대로 갈린다)
    this.db
      .prepare(
        "INSERT INTO agent_sessions(id, thread_id, agent_id, generation, status, reason, lane, created_at) VALUES (?,?,?,?,'active','first',?,?)",
      )
      .run(id, threadId, agentId, this.nextGeneration(threadId, agentId), lane, now());
    return this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as Row;
  }

  /** 세션 교체: 새 세대를 연다. 옛 세대의 진행 중 실행은 취소된다. */
  rotateSession(pr: Principal, threadId: string, input: { agent_id?: unknown; reason?: unknown; carry?: unknown; lane?: unknown }): AgentSession {
    this.requireRead(pr, threadId, 'session.rotate');
    let agentId: string;
    if (pr.participant.kind === 'agent') {
      this.requireAdapter(pr, 'session.rotate', { target_type: 'thread', target_id: threadId });
      // 어댑터는 자기 세션만 교체한다 — 남의 세션을 이어받거나 고를 수 없다
      if (input.agent_id !== undefined && input.agent_id !== pr.participant.id)
        this.deny(pr, new ApiError(403, 'impersonation'), { action: 'session.rotate', target_type: 'thread', target_id: threadId, thread_id: threadId });
      agentId = pr.participant.id;
    } else {
      this.requireMaster(pr, 'session.rotate', { target_type: 'thread', target_id: threadId, thread_id: threadId });
      if (typeof input.agent_id !== 'string') throw new ApiError(400, 'bad_request', 'agent_id required');
      agentId = input.agent_id;
    }
    const agent = this.getParticipant(agentId);
    if (!agent || agent.kind !== 'agent' || !this.membership(threadId, agentId)) {
      this.audit({ actor: this.actorOf(pr), action: 'session.rotate', target_type: 'agent', target_id: agentId.slice(0, 64), thread_id: threadId, result: 'failed', reason: 'bad_agent' });
      throw new ApiError(400, 'bad_agent');
    }
    const reason = typeof input.reason === 'string' ? input.reason.slice(0, 500) : 'manual';
    // 차선(#1563): lane 을 주면 그 차선만, 안 주면 이 에이전트의 살아 있는 차선을 모두 교체한다(기본 차선 결과를 돌려줌)
    const lanes =
      typeof input.lane === 'string'
        ? [input.lane]
        : (this.db.prepare("SELECT lane FROM agent_sessions WHERE thread_id = ? AND agent_id = ? AND status = 'active' ORDER BY lane DESC").all(threadId, agentId) as Row[]).map(
            (r) => r.lane as string,
          );
    if (!lanes.length) lanes.push('');
    let out!: AgentSession;
    for (const lane of lanes) out = this.rotateCore(threadId, agentId, this.actorOf(pr), pr.participant.id, reason, input.carry === true, undefined, lane);
    return out;
  }

  /**
   * 이어받기 경계: 새 세대가 원문으로 받을 «최근 cfg.carryMessages 개»의 바로 앞 seq. 글이 그보다 적으면 null(처음부터).
   * 그 앞의 옛 대화는 원문 대신 이어받은 맥락(사서 요약 · baalda 원문 위치)으로 넘어간다.
   */
  private carryBase(threadId: string, uptoSeq: number): number | null {
    const k = this.cfg.carryMessages;
    const r = this.db
      .prepare(
        `SELECT seq FROM messages WHERE (thread_id = ? OR seq IN (SELECT message_seq FROM thread_context WHERE thread_id = ?)) AND seq <= ?
         ORDER BY seq DESC LIMIT 1 OFFSET ?`,
      )
      .get(threadId, threadId, uptoSeq, k) as Row | undefined;
    return (r?.seq as number) ?? null;
  }

  /** 세션 맥락 크기: 마지막 성공 실행의 보고로 잰다 — claude-cli 는 (캐시 읽기+쓰기+입력)/도구 왕복, openai 는 실어 보낸 추정 토큰 */
  sessionMetrics(sessionId: string): { ctx_tokens: number | null; replies: number } {
    const replies = (this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE session_id = ? AND state = 'succeeded'").get(sessionId) as Row).n as number;
    const r = this.db.prepare("SELECT usage FROM runs WHERE session_id = ? AND state = 'succeeded' AND usage IS NOT NULL ORDER BY ended_at DESC LIMIT 1").get(sessionId) as Row | undefined;
    let ctx: number | null = null;
    try {
      const u = r ? JSON.parse(r.usage as string) : null;
      const cli = u?.['claude-cli'];
      const tk = u?.tokens;
      if (cli && tk && typeof tk.cache_read === 'number') ctx = Math.round(((tk.cache_read ?? 0) + (tk.cache_write ?? 0) + (tk.input ?? 0)) / Math.max(1, cli.num_turns ?? 1));
      else if (typeof u?.context?.est_tokens === 'number') ctx = u.context.est_tokens;
    } catch {
      /* 보고 모양이 다르면 모름 */
    }
    return { ctx_tokens: ctx, replies };
  }

  /**
   * 이어받은 맥락(새 세대의 첫 실행에만): 사서의 가장 최근 요약 글(이 스레드 · 원인 이전) + 원문 사본 위치 안내.
   * 원문으로는 최근 cfg.carryMessages 개만 실린다(base_seq). 첫 실행이 끝나면 다음부터는 안 붙는다.
   */
  private carryFor(session: Row, threadId: string, uptoSeq: number): ClaimCarry | null {
    if (!session.carry || session.generation <= 1) return null;
    const done = this.db.prepare("SELECT 1 FROM runs WHERE session_id = ? AND state = 'succeeded' LIMIT 1").get(session.id);
    if (done) return null;
    const lib = this.cfg.onCallOnly;
    const sum = lib.length
      ? (this.db
          .prepare(
            `SELECT seq, author_id, body, created_at FROM messages WHERE thread_id = ? AND seq <= ? AND author_id IN (${lib.map(() => '?').join(',')})
             ORDER BY seq DESC LIMIT 1`,
          )
          .get(threadId, uptoSeq, ...lib) as Row | undefined)
      : undefined;
    const th = this.db.prepare('SELECT title FROM threads WHERE id = ?').get(threadId) as Row;
    const older = (
      this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE (thread_id = ? OR seq IN (SELECT message_seq FROM thread_context WHERE thread_id = ?)) AND seq <= ?').get(threadId, threadId, session.base_seq ?? 0) as Row
    ).n as number;
    return {
      from_generation: (session.generation as number) - 1,
      reason: (session.reason as string) ?? '',
      thread_title: th.title as string,
      // 외부 내보내기와 같은 이름 규칙(제목의 금지 글자 → _ · 80자 · (id 의 th_ 뒤))
      thread_note: `brainStorm/${String(th.title).replace(/[\\/:*?"<>|\n]/g, '_').trim().slice(0, 80)} (${threadId.slice(3)}).md`,
      older_hint: this.cfg.carryHint || undefined,
      older_messages: older,
      base_seq: (session.base_seq as number) ?? null,
      summary: sum ? { seq: sum.seq as number, author_name: this.nameOf(sum.author_id as string), body: (sum.body as string).slice(0, 12000), created_at: sum.created_at as number } : null,
    };
  }

  /** 자동 교체 판정(마스터 #283 A): 맥락 cfg.rotateTokens 이상 또는 답 cfg.rotateReplies 개 이상. 0 이면 그 기준은 끔 */
  private rotateDue(session: Row): string | null {
    const m = this.sessionMetrics(session.id as string);
    if (this.cfg.rotateTokens > 0 && m.ctx_tokens !== null && m.ctx_tokens >= this.cfg.rotateTokens)
      return tr(this.lang(), 'srv.rotate.auto_tokens', { k: Math.round(m.ctx_tokens / 1000), limit: Math.round(this.cfg.rotateTokens / 1000) });
    if (this.cfg.rotateReplies > 0 && m.replies >= this.cfg.rotateReplies) return tr(this.lang(), 'srv.rotate.auto_replies', { n: m.replies, limit: this.cfg.rotateReplies });
    return null;
  }

  private rotateCore(threadId: string, agentId: string, actor: AuditActor, by: string, reason: string, carry: boolean, uptoSeq?: number, lane = ''): AgentSession {
    const t = now();
    const changed: Row[] = [];
    const head = this.threadMaxSeq(threadId);
    const base = carry && head !== null ? this.carryBase(threadId, uptoSeq ?? head) : head;
    const id = this.db.transaction(() => {
      const old = this.activeSession(threadId, agentId, lane);
      const gen = this.nextGeneration(threadId, agentId);
      if (old) {
        this.db.prepare("UPDATE agent_sessions SET status = 'retired', ended_at = ? WHERE id = ?").run(t, old.id);
        const active = this.db.prepare("SELECT * FROM runs WHERE session_id = ? AND state IN ('queued','running')").all(old.id) as Row[];
        for (const r of active) {
          // 세션 교체는 옛 세대를 즉시 닫는다(그 세대의 늦은 완료는 stale_generation 으로 어차피 거절된다)
          this.db
            .prepare(
              "UPDATE runs SET state = 'cancelled', cancel_requested = 1, ended_at = ?, finalized_at = ?, error = 'generation_rotated', lease_expires_at = NULL WHERE id = ?",
            )
            .run(t, t, r.id);
          this.ev(r.id, 'rotated', by, { from_state: r.state, new_generation: gen }, t);
          this.ev(r.id, 'finalized', 'server', { state: 'cancelled' }, t);
          this.auditCancelFinal(r, 'cancelled', 'rotated', t);
          changed.push(r);
        }
      }
      const nid = newId('ses');
      this.db
        .prepare(
          "INSERT INTO agent_sessions(id, thread_id, agent_id, generation, prev_session_id, status, reason, last_delivered_seq, base_seq, carry, lane, created_at) VALUES (?,?,?,?,?, 'active', ?, ?, ?, ?, ?, ?)",
        )
        .run(nid, threadId, agentId, gen, old?.id ?? null, reason, old?.last_delivered_seq ?? null, base, carry ? 1 : 0, lane, t);
      // 세션 교체(정책 9): 이전 세대와 새 세대, 닫힌 실행 수. 사유 문자열은 마스터·어댑터가 적은 교체 사유(본문 아님)
      this.audit({
        actor,
        action: 'session.rotate',
        target_type: 'agent',
        target_id: agentId,
        thread_id: threadId,
        result: 'ok',
        before: old ? { session_id: old.id, generation: old.generation } : { session_id: null, generation: null },
        after: { session_id: nid, generation: gen, cancelled_runs: changed.length, reason: reason.slice(0, 200), carry, base_seq: base },
      });
      return nid;
    })();
    for (const r of changed) this.emit({ notice: { t: 'run', thread_id: threadId, run_id: r.id, state: 'cancelled' }, threadId });
    this.emit({ notice: { t: 'thread', thread_id: threadId }, threadId });
    return toSession(this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as Row);
  }

  // ───────────────────────── 전달 · 실행 ─────────────────────────

  /** 실행 이력 한 줄. 본문·토큰은 넣지 않는다 */
  /** @internal 모듈(src/modules)도 부른다 */ ev(runId: string, event: string, source: string, detail?: Record<string, unknown> | null, t = now()) {
    this.db
      .prepare('INSERT INTO run_events(run_id, at, event, source, detail) VALUES (?,?,?,?,?)')
      .run(runId, t, event, source, detail ? JSON.stringify(detail).slice(0, 2000) : null);
  }

  /** @internal 모듈(src/modules)도 부른다 */ runRow(runId: string): Row | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Row | undefined;
  }

  /** @internal 모듈(src/modules)도 부른다 */ toRunOut(r: Row): Run {
    return toRun(r, this.cfg.cancelAckMs);
  }

  /**
   * lease·무응답 제한 처리. 전달은 다시 내보내고(최소 한 번), 실행은 unknown 으로 둔다(자동 재실행 없음).
   * 중단 요청됨(running + cancel_requested_at)인 실행은 중단 명령 뒤 cancelAckMs 안에 확인·완료가 없으면 unknown(정책 1 무응답 제한).
   * 명령이 아직 안 실렸으면(어댑터가 heartbeat 를 못 보냄) 요청 시각부터 센다 — 죽은 어댑터도 같은 시간 안에 판정된다.
   */
  sweep(t = now()): number {
    let n = 0;
    const changedRuns: Row[] = [];
    this.db.transaction(() => {
      const timedOut = this.db
        .prepare("SELECT * FROM runs WHERE state = 'running' AND cancel_requested_at IS NOT NULL AND COALESCE(stop_sent_at, cancel_requested_at) <= ?")
        .all(t - this.cfg.cancelAckMs) as Row[];
      for (const r of timedOut) {
        // run_token 은 지우지 않는다 — 늦게 온 확인·완료를 «이벤트로만» 남기려면 그 어댑터를 알아봐야 한다(상태가 이미 확정이라 반영은 안 된다)
        this.db
          .prepare(
            "UPDATE runs SET state = 'unknown', ended_at = ?, finalized_at = ?, error = 'cancel_ack_timeout', lease_expires_at = NULL WHERE id = ? AND state = 'running'",
          )
          .run(t, t, r.id);
        this.ev(r.id, 'cancel_ack_timeout', 'server', { waited_ms: t - (r.stop_sent_at ?? r.cancel_requested_at), stop_sent: r.stop_sent_at != null }, t);
        this.ev(r.id, 'finalized', 'server', { state: 'unknown' }, t);
        this.auditCancelFinal(r, 'unknown', 'no_ack', t);
        changedRuns.push(r);
        n++;
      }
      const ds = this.db.prepare("SELECT * FROM deliveries WHERE status = 'leased' AND lease_expires_at <= ?").all(t) as Row[];
      for (const d of ds) {
        if (d.attempts >= this.cfg.maxDeliveryAttempts) {
          this.db
            .prepare("UPDATE deliveries SET status = 'dead', lease_token_hash = NULL, last_error = 'max_attempts', updated_at = ? WHERE id = ?")
            .run(t, d.id);
        } else {
          const backoff = Math.min(this.cfg.retryBaseMs * 2 ** (d.attempts - 1), 60_000);
          this.db
            .prepare(
              "UPDATE deliveries SET status = 'pending', lease_token_hash = NULL, lease_expires_at = NULL, retry_at = ?, last_error = 'lease_expired', updated_at = ? WHERE id = ?",
            )
            .run(t + backoff, t, d.id);
        }
        n++;
      }
      const rs = this.db
        .prepare("SELECT * FROM runs WHERE state IN ('queued','running') AND lease_expires_at <= ?")
        .all(t) as Row[];
      for (const r of rs) {
        this.db
          .prepare(
            "UPDATE runs SET state = 'unknown', ended_at = ?, finalized_at = ?, error = 'lease_expired', run_token_hash = NULL WHERE id = ?",
          )
          .run(t, t, r.id);
        this.ev(r.id, 'lease_expired', 'server', { from_state: r.state }, t);
        this.ev(r.id, 'finalized', 'server', { state: 'unknown' }, t);
        this.auditCancelFinal(r, 'unknown', 'lease_expired', t);
        changedRuns.push(r);
        n++;
      }
    })();
    for (const r of changedRuns)
      this.emit({ notice: { t: 'run', thread_id: r.thread_id, run_id: r.id, state: 'unknown' }, threadId: r.thread_id });
    return n;
  }

  private contextFor(threadId: string, uptoSeq: number, limit = 50): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE (thread_id = ? OR seq IN (SELECT message_seq FROM thread_context WHERE thread_id = ?))
         AND seq <= ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(threadId, threadId, uptoSeq, limit) as Row[];
    return rows.reverse().map(toMessage);
  }

  claim(pr: Principal, input: { worker?: unknown } = {}) {
    this.requireAdapter(pr, 'adapter.claim');
    const me = pr.participant.id;
    const worker = typeof input.worker === 'string' ? input.worker.slice(0, 100) : 'unnamed';
    this.sweep();
    const t = now();
    const out = this.db.transaction(() => {
      for (let i = 0; i < 20; i++) {
        const d = this.db
          .prepare(
            `SELECT d.* FROM deliveries d JOIN threads t ON t.id = d.thread_id
             WHERE d.recipient_id = ? AND d.status = 'pending' AND (d.retry_at IS NULL OR d.retry_at <= ?)
               AND t.invoke_paused = 0 AND t.deleted_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.thread_id = d.thread_id AND r.agent_id = d.recipient_id
                               AND r.state IN ('queued','running') AND r.trigger_seq <> d.message_seq
                               AND r.lane = (${LANE_SQL.replace('?', 'd.message_seq')}))
             ORDER BY d.message_seq LIMIT 1`,
          )
          .get(me, t) as Row | undefined;
        if (!d) return null;
        if (!this.membership(d.thread_id, me)?.can_read) {
          this.db
            .prepare("UPDATE deliveries SET status = 'cancelled', last_error = 'no_read_access', updated_at = ? WHERE id = ?")
            .run(t, d.id);
          continue;
        }
        const leaseToken = randomToken('lease');
        const leaseExp = t + this.cfg.deliveryLeaseMs;
        this.db
          .prepare(
            "UPDATE deliveries SET status = 'leased', lease_token_hash = ?, lease_expires_at = ?, attempts = attempts + 1, retry_at = NULL, updated_at = ? WHERE id = ?",
          )
          .run(sha256(leaseToken), leaseExp, t, d.id);
        // 자동 세션 교체(마스터 #283 A): 지금 세대가 기준을 넘었으면 이 실행부터 새 세대 — 최근 글 원문 + 이어받은 맥락으로 시작
        const lane = this.laneOf(d.message_seq as number);
        {
          const cur = this.activeSession(d.thread_id, me, lane);
          const already = this.db.prepare('SELECT 1 FROM runs WHERE trigger_seq = ? AND agent_id = ?').get(d.message_seq, me);
          const due = cur && !already ? this.rotateDue(cur) : null;
          if (due) this.rotateCore(d.thread_id, me, { id: 'server', kind: 'server' }, 'server', due, true, (d.message_seq as number) - 1, lane); // 원인 앞의 최근 N개 + 원인
        }
        const session = this.ensureSession(d.thread_id, me, lane);
        // 같은 원인·수신자에 대한 실행은 한 번만 만든다 (세대가 바뀌어도 자동 재실행하지 않는다)
        const existing = this.db
          .prepare('SELECT * FROM runs WHERE trigger_seq = ? AND agent_id = ? ORDER BY generation DESC LIMIT 1')
          .get(d.message_seq, me) as Row | undefined;
        let run: Row;
        let runToken: string | null = null;
        if (existing) {
          run = existing;
        } else {
          // 수동 전달이면 원인(▶)보다 뒤 — 누른 시점의 스레드 머리까지 싣는다(지난 글을 넘겨도 그 뒤 대화가 맥락에 있게)
          const upto = d.context_upto_seq != null ? Math.max(d.context_upto_seq as number, d.message_seq as number) : (d.message_seq as number);
          const ctx = this.contextFor(d.thread_id, upto);
          if (!ctx.some((m) => m.seq === d.message_seq))
            ctx.unshift(toMessage(this.db.prepare('SELECT * FROM messages WHERE seq = ?').get(d.message_seq) as Row));
          const snapshot = {
            thread_id: d.thread_id,
            trigger_seq: d.message_seq,
            context_upto_seq: d.context_upto_seq ?? null,
            generation: session.generation,
            seqs: ctx.map((m) => [m.seq, m.body_version]),
            worker,
          };
          runToken = randomToken('run');
          const rid = newId('run');
          this.db
            .prepare(
              `INSERT INTO runs(id, thread_id, trigger_seq, delivery_id, agent_id, session_id, generation, input_snapshot, state, run_token_hash, lease_expires_at, lane, created_at)
               VALUES (?,?,?,?,?,?,?,?, 'queued', ?, ?, ?, ?)`,
            )
            .run(rid, d.thread_id, d.message_seq, d.id, me, session.id, session.generation, JSON.stringify(snapshot), sha256(runToken), t + this.cfg.runLeaseMs, lane, t);
          this.db
            .prepare('UPDATE agent_sessions SET last_delivered_seq = MAX(COALESCE(last_delivered_seq, 0), ?) WHERE id = ?')
            .run(d.message_seq, session.id);
          this.ev(rid, 'created', 'server', { worker, generation: session.generation, delivery_id: d.id, context: ctx.length }, t);
          // 보류 알림(#374): 이 에이전트가 이 스레드에서 보낸 요청이 보류됐고 아직 안 알렸으면 이 실행에 한 번 싣는다(세대 무관 · 사유 없음)
          if (this.requests)
            this.db
              .prepare("UPDATE request_holds SET notified_run_id = ? WHERE thread_id = ? AND requester_id = ? AND kind = 'held' AND notified_run_id IS NULL")
              .run(rid, d.thread_id, me);
          run = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(rid) as Row;
        }
        const [trigger] = this.withAttachments([toMessage(this.db.prepare('SELECT * FROM messages WHERE seq = ?').get(d.message_seq) as Row)]);
        const thread = this.db.prepare('SELECT id, title FROM threads WHERE id = ?').get(d.thread_id) as Row;
        const snap = JSON.parse(run.input_snapshot);
        const seqs = (snap.seqs as [number, number][]).map((x) => x[0]);
        const context = this.withAttachments(
          seqs.length
            ? (this.db.prepare(`SELECT * FROM messages WHERE seq IN (${seqs.map(() => '?').join(',')}) ORDER BY seq`).all(...seqs) as Row[]).map(toMessage)
            : [],
        );
        // 2026-10-10 마스터 결정: 이 에이전트가 끝내지 못한(취소·실패·미확인) 요청은 맥락에 남기되 표시를 붙인다 —
        //   표시가 없으면 모델이 다음 턴에 답 없는 옛 요청까지 이어 답했다(운영 실측 · «2000단어 가이드»).
        const others = context.filter((m) => m.seq !== d.message_seq).map((m) => m.seq);
        if (others.length) {
          const rows = this.db
            .prepare(
              `SELECT trigger_seq, state FROM runs WHERE agent_id = ? AND trigger_seq IN (${others.map(() => '?').join(',')})
               ORDER BY generation, created_at`,
            )
            .all(me, ...others) as Row[];
          const last = new Map<number, string>();
          for (const r of rows) last.set(r.trigger_seq as number, r.state as string);
          for (const m of context) {
            const st = last.get(m.seq);
            if (st === 'cancelled' || st === 'failed' || st === 'unknown') m.run_outcome = st;
          }
        }
        // 합침 묶음 글(#706)은 옮긴 글 전문으로 펼친다 — 화면엔 머리 한 줄 + 묶음, 에이전트에겐 전문
        for (const m of [trigger, ...context]) if (m.merge) m.body = this.merge!.mergeTranscript(m);
        // 전달 메모(#740): 글 안의 꾸민 머리는 무디게 하고(사칭 방지) 마스터 메모를 전달된 글 끝 블록으로 싣는다 — 어댑터는 본문을 그대로 그린다
        for (const m of [trigger, ...context]) if (m.body) m.body = inertForwardHeads(m.body);
        //   어댑터는 원인 글을 맥락 쪽 사본(같은 seq)으로 그리므로 둘 다에 붙인다
        if (d.forwarded_by && d.forward_note)
          for (const m of [trigger, ...context.filter((x) => x.seq === d.message_seq)])
            m.body = `${m.body ?? ''}\n\n${tr(this.lang(), 'srv.forward_note.block', { head: tr(this.lang(), 'srv.forward_note.head'), note: d.forward_note })}`;
        // 제 글의 넘김 신호는 본문에서 떼였으므로 상태로 돌려준다(다음 턴에 «내가 넘겼나»를 제 기록에서 보게 · 받는 쪽엔 안 붙인다)
        for (const m of context) {
          if (m.author_id !== me || !m.handoff_to.length) continue;
          const sent = new Set(
            (this.db.prepare('SELECT recipient_id FROM deliveries WHERE message_seq = ? AND forwarded_by IS NOT NULL').all(m.seq) as Row[]).map(
              (x) => x.recipient_id as string,
            ),
          );
          m.handoff_state = Object.fromEntries(m.handoff_to.map((id) => [id, sent.has(id) ? 'forwarded' : 'pending'] as const));
        }
        return {
          delivery: { id: d.id, lease_token: leaseToken, lease_expires_at: leaseExp, attempts: d.attempts + 1 },
          run: { ...this.toRunOut(run), run_token: runToken },
          duplicate: !!existing,
          thread: { id: thread.id, title: thread.title },
          session: {
            id: session.id,
            generation: session.generation,
            base_seq: session.base_seq ?? null,
            seen_seq: this.sessionSeenSeq(session, run.id),
          } satisfies ClaimSession,
          trigger,
          context,
          forward: d.forwarded_by
            ? ({ by: d.forwarded_by as string, context_upto_seq: Math.max(d.context_upto_seq as number, d.message_seq as number), note: (d.forward_note as string) ?? null } satisfies ClaimForward)
            : null,
          carry: this.carryFor(session, d.thread_id, d.message_seq as number),
          face: this.face?.faceForClaim(d.thread_id, d.message_seq as number, me) ?? null,
          request_rule: !!this.requests,
          hold_notices: (
            this.db.prepare('SELECT id, request_seq FROM request_holds WHERE notified_run_id = ? ORDER BY created_at').all(run.id) as Row[]
          ).map((h) => ({ hold_id: h.id as string, request_seq: (h.request_seq as number) ?? null }) satisfies ClaimHoldNotice),
          pulled: d.pulled
            ? ({ ...(JSON.parse(d.pulled as string) as ClaimPulled), context_upto_seq: Math.max((d.context_upto_seq as number) ?? 0, d.message_seq as number) } satisfies ClaimPulled)
            : null,
          /** 규약·안내 언어(마스터 #823) — 어댑터가 프롬프트를 이 언어로 싣는다 */
          lang: this.lang(),
          /** 마스터가 정한 이 에이전트의 모델(2026-11-04) — 없으면 null = 어댑터 기본값. 어댑터가 env 보다 먼저 쓴다 */
          model: this.agentModel(me),
          /** 질문함(모듈 questions): 이 방에 내가 올린 열린 질문 — 어댑터가 프롬프트 끝에 붙인다 · 꺼지면 null */
          open_questions: this.questions?.openForClaim(d.thread_id, me) ?? null,
        };
      }
      return null;
    })();
    if (out && !out.duplicate)
      this.emit({ notice: { t: 'run', thread_id: out.thread.id, run_id: out.run.id, state: 'queued' }, threadId: out.thread.id });
    return out;
  }

  ackDelivery(pr: Principal, deliveryId: string, input: { lease_token?: unknown }) {
    this.requireAdapter(pr, 'adapter.ack', { target_type: 'delivery', target_id: deliveryId });
    this.sweep();
    const d = this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId) as Row | undefined;
    if (!d) throw new ApiError(404, 'no_delivery');
    if (d.recipient_id !== pr.participant.id)
      this.deny(pr, new ApiError(404, 'no_delivery'), { action: 'adapter.ack', target_type: 'delivery', target_id: deliveryId, thread_id: d.thread_id, reason: 'not_owner' });
    if (typeof input.lease_token !== 'string' || sha256(input.lease_token) !== d.lease_token_hash)
      throw new ApiError(409, 'lease_lost', `delivery is ${d.status}`);
    if (d.status === 'acked') return { ok: true, status: 'acked' };
    if (d.status !== 'leased') throw new ApiError(409, 'lease_lost', `delivery is ${d.status}`);
    this.db.prepare("UPDATE deliveries SET status = 'acked', acked_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), d.id);
    return { ok: true, status: 'acked' };
  }

  /** 실행 소유권 확인: 이 어댑터가 받은 run_token 이어야 한다 */
  /** @internal */ ownRun(pr: Principal, runId: string, runToken: unknown): Row {
    this.requireAdapter(pr, 'adapter.run', { target_type: 'run', target_id: runId });
    this.sweep();
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Row | undefined;
    if (!r) throw new ApiError(404, 'no_run');
    if (r.agent_id !== pr.participant.id)
      this.deny(pr, new ApiError(404, 'no_run'), { action: 'adapter.run', target_type: 'run', target_id: runId, thread_id: r.thread_id, reason: 'not_owner' });
    if (typeof runToken !== 'string' || !r.run_token_hash || sha256(runToken) !== r.run_token_hash)
      throw new ApiError(409, 'not_run_owner', `run is ${r.state}`);
    return r;
  }

  startRun(pr: Principal, runId: string, input: { run_token?: unknown; runtime?: unknown; model?: unknown; config_version?: unknown }) {
    const r = this.ownRun(pr, runId, input.run_token);
    if (r.state !== 'queued') throw new ApiError(409, 'bad_state', `run is ${r.state}`);
    const s = this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(r.session_id) as Row;
    if (s.status !== 'active') throw new ApiError(409, 'stale_generation');
    const t = now();
    const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200) : null);
    this.db.transaction(() => {
      this.db.prepare("UPDATE runs SET state = 'running', started_at = ?, lease_expires_at = ? WHERE id = ?").run(t, t + this.cfg.runLeaseMs, r.id);
      this.ev(r.id, 'started', pr.participant.id, { runtime: str(input.runtime), config_version: str(input.config_version) }, t);
      // 실제 모델을 기록한다 — 대체(fallback)를 숨기지 않는다
      this.db
        .prepare(
          'UPDATE agent_sessions SET runtime = COALESCE(?, runtime), actual_model = COALESCE(?, actual_model), config_version = COALESCE(?, config_version) WHERE id = ?',
        )
        .run(str(input.runtime), str(input.model), str(input.config_version), s.id);
    })();
    this.emit({ notice: { t: 'run', thread_id: r.thread_id, run_id: r.id, state: 'running' }, threadId: r.thread_id });
    return { ok: true, state: 'running' as RunState, lease_expires_at: t + this.cfg.runLeaseMs };
  }

  /**
   * 살아 있음. 중단 요청된 실행이면 {cancel:true} — 첫 번째로 실어 보낸 시각을 «중단 명령 시각»으로 남긴다.
   * 취소가 이미 확정된 실행(대기 중 취소·세션 교체)도 {cancel:true}.
   */
  heartbeat(pr: Principal, runId: string, input: { run_token?: unknown; progress?: unknown }) {
    const r = this.ownRun(pr, runId, input.run_token);
    if (r.state === 'cancelled') return { cancel: true, state: r.state };
    if (r.state !== 'running' && r.state !== 'queued') throw new ApiError(409, 'bad_state', `run is ${r.state}`);
    const t = now();
    const exp = t + this.cfg.runLeaseMs;
    // 읽음·경과: 마지막 신호 시각은 늘, 경과 한 줄은 바뀌었을 때만 적고 화면에 알린다
    const note = typeof input.progress === 'string' ? input.progress.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    this.db.prepare('UPDATE runs SET heartbeat_at = ? WHERE id = ?').run(t, r.id);
    if (note && note !== r.progress) {
      this.db.prepare('UPDATE runs SET progress = ?, progress_at = ? WHERE id = ?').run(note, t, r.id);
      this.emit({ notice: { t: 'run', thread_id: r.thread_id, run_id: r.id, state: r.state }, threadId: r.thread_id });
    }
    if (r.state === 'running' && r.cancel_requested_at != null) {
      this.db.transaction(() => {
        this.db.prepare('UPDATE runs SET lease_expires_at = ? WHERE id = ?').run(exp, r.id);
        if (r.stop_sent_at == null) {
          this.db.prepare('UPDATE runs SET stop_sent_at = ? WHERE id = ? AND stop_sent_at IS NULL').run(t, r.id);
          this.ev(r.id, 'stop_sent', 'server', { via: 'heartbeat' }, t);
        }
      })();
      if (r.stop_sent_at == null)
        this.emit({ notice: { t: 'run', thread_id: r.thread_id, run_id: r.id, state: 'running' }, threadId: r.thread_id });
      return { cancel: true, state: r.state, cancel_deadline_at: (r.stop_sent_at ?? t) + this.cfg.cancelAckMs, lease_expires_at: exp };
    }
    this.db.prepare('UPDATE runs SET lease_expires_at = ? WHERE id = ?').run(exp, r.id);
    return { cancel: false, state: r.state, lease_expires_at: exp };
  }

  /**
   * 어댑터의 중단 확인(정책 1). 중단 요청된 running 실행 → cancelled.
   * 이미 cancelled 면 멱등(확인 시각만 채운다). 이미 다른 최종 상태(완료 우선·무응답 unknown 등)면 409 — 상태는 안 바꾸고 이벤트로만 남긴다.
   */
  ackCancel(pr: Principal, runId: string, input: { run_token?: unknown }) {
    const r = this.ownRun(pr, runId, input.run_token);
    const t = now();
    const who = pr.participant.id;
    if (r.state === 'running') {
      if (r.cancel_requested_at == null) throw new ApiError(409, 'no_cancel_request', 'cancel was not requested for this run');
      this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE runs SET state = 'cancelled', stop_ack_at = ?, ended_at = ?, finalized_at = ?, error = 'cancelled_by_master', lease_expires_at = NULL WHERE id = ? AND state = 'running'",
          )
          .run(t, t, t, r.id);
        this.ev(r.id, 'stop_ack', who, { waited_ms: t - r.cancel_requested_at }, t);
        this.ev(r.id, 'finalized', 'server', { state: 'cancelled' }, t);
        this.auditCancelFinal(r, 'cancelled', 'acked', t, who);
      })();
      this.emit({ notice: { t: 'run', thread_id: r.thread_id, run_id: r.id, state: 'cancelled' }, threadId: r.thread_id });
      return { ok: true, state: 'cancelled' as RunState, duplicate: false };
    }
    if (r.state === 'cancelled') {
      if (r.stop_ack_at == null) {
        this.db.transaction(() => {
          this.db.prepare('UPDATE runs SET stop_ack_at = ? WHERE id = ? AND stop_ack_at IS NULL').run(t, r.id);
          this.ev(r.id, 'stop_ack', who, { after_final: true }, t);
        })();
      }
      return { ok: true, state: 'cancelled' as RunState, duplicate: true };
    }
    this.ev(r.id, 'late_stop_ack', who, { state: r.state }, t);
    throw new ApiError(409, 'bad_state', `run is ${r.state}`);
  }

  completeRun(
    pr: Principal,
    runId: string,
    input: { run_token?: unknown; body?: unknown; usage?: unknown; source_kind?: unknown; runtime?: unknown; model?: unknown; context_upto_seq?: unknown },
  ) {
    const r = this.ownRun(pr, runId, input.run_token);
    if (r.state === 'succeeded' && r.result_seq) {
      const m = this.db.prepare('SELECT * FROM messages WHERE seq = ?').get(r.result_seq) as Row;
      return { run: this.toRunOut(r), message: toMessage(m), duplicate: true };
    }
    if (r.state === 'succeeded') {
      // 보류로 끝난 실행(답 글 없음)의 재전송
      const h = this.db.prepare("SELECT * FROM request_holds WHERE run_id = ? AND kind = 'held'").get(r.id) as Row | undefined;
      if (h) return { run: this.toRunOut(r), message: null, held: toHold(h), duplicate: true };
    }
    // 이미 확정된 실행(취소 확인 뒤·무응답 unknown·실패)의 늦은 완료는 상태를 바꾸지 않는다 — 이벤트로만(정책 1)
    if (r.state !== 'running') {
      this.ev(r.id, 'late_complete', pr.participant.id, { state: r.state, body_chars: typeof input.body === 'string' ? input.body.length : null });
      throw new ApiError(409, 'bad_state', `run is ${r.state}`);
    }
    const s = this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(r.session_id) as Row;
    if (s.status !== 'active') throw new ApiError(409, 'stale_generation');
    if (!this.membership(r.thread_id, pr.participant.id)?.can_post)
      this.deny(pr, new ApiError(403, 'no_post_permission'), { action: 'thread.post', target_type: 'run', target_id: r.id, thread_id: r.thread_id });
    const postedBody = reqString(input.body, 'body', this.cfg.bodyMaxChars);
    // 끝의 `답변시각:` 도장 줄은 게시 본문에서 걷는다(끝줄 신호를 안 묻게 · 도장만 있는 답은 그대로)
    const rawBody = stripAnswerStamp(postedBody) || postedBody;
    const sk0 = (input.source_kind ?? 'proposal') as SourceKind;
    if (!SOURCE_KINDS.includes(sk0) || sk0 === 'instruction' || sk0 === 'request') throw new ApiError(403, 'source_kind_forbidden');
    // 대면 턴(마스터 #581): 끝줄 신호를 읽지 않고 합의문·질문을 본다 → 판·안건·다음 차례
    const faceRound = this.face?.faceTurnRound(r.thread_id, r.trigger_seq, pr.participant.id);
    if (faceRound) return this.face!.completeFace(pr, r, faceRound, rawBody, sk0, input);
    const trigRow = this.db.prepare('SELECT hop, source_kind, recipients, author_id FROM messages WHERE seq = ?').get(r.trigger_seq) as Row;
    // 보류(마스터 #352 «예외 처리»): 나에게 온 요청에 끝줄 «보류: 사유»로 답하면 스레드에 안 올리고 request_holds 에 남긴다 — 요청한 쪽도 안 깨운다
    if (this.requests && trigRow.source_kind === 'request' && (JSON.parse(trigRow.recipients) as string[]).includes(pr.participant.id)) {
      const hold = parseHold(rawBody);
      if (hold) return this.requests.completeHeld(pr, r, trigRow, hold, input);
    }
    // 끝줄 신호 셋(→ 넘김 · 요청→ · ← 끌어오기)은 어느 순서로 와도 뗀다
    const hoC = this.handoffCandidates(r.thread_id, pr.participant.id);
    const plC = this.pullCandidates(r.thread_id, pr.participant.id);
    const seqTh = (q: number) => ((this.db.prepare('SELECT thread_id FROM messages WHERE seq = ?').get(q) as Row | undefined)?.thread_id as string) ?? null;
    let finalBody = rawBody;
    let pull: PullRequest | null = null;
    let handoff: string[] = [];
    let hoRaw: string | null = null;
    let plRaw: string | null = null;
    let rqTo: string | null = null;
    let rqRaw: string | null = null;
    for (let k = 0; k < 3; k++) {
      if (!pull) {
        const p = parsePull(finalBody, plC, seqTh);
        plRaw ??= p.raw;
        if (p.pull) {
          pull = p.pull;
          finalBody = p.body;
          continue;
        }
      }
      if (!handoff.length && !rqTo) {
        const h = parseHandoff(finalBody, hoC);
        hoRaw ??= h.raw;
        if (h.handoff_to.length) {
          handoff = h.handoff_to;
          finalBody = h.body;
          continue;
        }
        if (!this.requests) break;
        const q = parseRequest(finalBody, hoC);
        rqRaw ??= q.raw;
        if (q.matched.length) {
          // 받는 이가 둘 이상이면 요청이 아니다 — 찾은 이들은 넘김 버튼으로
          if (q.to) rqTo = q.to;
          else handoff = q.matched;
          finalBody = q.body;
          continue;
        }
      }
      break;
    }
    // 요청: 허용 짝 · 받는 이가 읽음 · 새 호출 금지 아님 · 연쇄 상한 안이면 바로 그 에이전트에게 배달. 아니면 기존 넘김 버튼으로 떨어진다(답은 잃지 않는다)
    const thRow = this.requireThread(r.thread_id);
    const rqBlock = rqTo ? this.requests!.requestBlock(thRow, pr.participant.id, rqTo) : null;
    const asRequest = !!rqTo && !rqBlock;
    if (rqTo && rqBlock) handoff = [rqTo];
    const ho = { handoff_to: handoff, raw: hoRaw };
    const pl = { pull, raw: plRaw };
    // 전달 실행: 어댑터가 «여기까지 보냈다»를 되돌려 주면 그만큼 본 것으로, 안 주면(옛 어댑터) 원인까지만 본 것으로 친다
    const fwd = this.db.prepare('SELECT context_upto_seq FROM deliveries WHERE id = ?').get(r.delivery_id) as Row | undefined;
    let seenUpto: number | null = null;
    if (fwd?.context_upto_seq != null) {
      const echo = optInt(input.context_upto_seq, 'context_upto_seq');
      seenUpto = echo !== null && echo === fwd.context_upto_seq ? fwd.context_upto_seq : r.trigger_seq;
    }
    const sk: SourceKind = asRequest ? 'request' : sk0;
    const usage = input.usage === undefined ? null : JSON.stringify(input.usage).slice(0, 4000);
    const t = now();
    const trig = trigRow;
    // 중단 요청 뒤·확인 전에 온 완료는 받는다(«완료 우선 확정», 마스터 결정 5) — LLM 이 이미 답한 사실을 숨기지 않는다
    const duringCancel = r.cancel_requested_at != null;
    let requestDelivery: string | null = null;
    const seq = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO messages(id, thread_id, author_id, client_key, body, reply_to_seq, source_kind, input_mode, recipients, hop, trigger_run_id, handoff_to, pull_req, created_at)
           VALUES (?,?,?,?,?,?,?, 'text', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId('msg'), r.thread_id, pr.participant.id, `run:${r.id}`, finalBody, r.trigger_seq, sk, JSON.stringify(asRequest ? [rqTo] : []), trig.hop + 1, r.id,
          JSON.stringify(ho.handoff_to), pl.pull ? JSON.stringify(pl.pull) : null, t,
        );
      const seq = Number(info.lastInsertRowid);
      // 태그(사양 2.1): 끝줄 태그 줄이 있으면 그것 · 없으면 받은 글의 주 태그를 물려받는다 · 넘쳐도 답은 버리지 않고 앞 둘만
      this.tags.attach(seq, this.tags.resolve(finalBody, 'tail', undefined, this.tags.primaryOf(r.trigger_seq), false));
      // 에이전트 답은 전달(delivery)을 만들지 않는다 — 에이전트 간 자동 호출 없음. 예외는 허용 짝의 요청 하나(마스터 #352)
      if (asRequest) {
        const did = newId('dlv');
        this.db
          .prepare(`INSERT INTO deliveries(id, message_seq, thread_id, recipient_id, status, attempts, created_at, updated_at) VALUES (?,?,?,?, 'pending', 0, ?, ?)`)
          .run(did, seq, r.thread_id, rqTo, t, t);
        requestDelivery = did;
        this.ev(r.id, 'request_sent', 'server', { to: rqTo, delivery_id: did, result_seq: seq }, t);
        this.requests!.auditRequest(pr, r.thread_id, seq, rqTo!, 'ok', null, did);
      } else if (rqTo && rqBlock) {
        this.ev(r.id, 'request_refused', 'server', { to: rqTo, reason: rqBlock }, t);
        if (rqBlock === 'request_chain_limit')
          this.requests!.recordHold({ thread_id: r.thread_id, request_seq: seq, requester_id: pr.participant.id, recipient_id: rqTo, kind: 'chain_limit', reason: 'request_chain_limit', note: null, run_id: r.id });
        this.requests!.auditRequest(pr, r.thread_id, seq, rqTo, 'denied', rqBlock, null);
      }
      this.db
        .prepare(
          "UPDATE runs SET state = 'succeeded', ended_at = ?, finalized_at = ?, usage = ?, result_seq = ?, seen_upto = ?, lease_expires_at = NULL WHERE id = ?",
        )
        .run(t, t, usage, seq, seenUpto, r.id);
      this.ev(r.id, 'completed', pr.participant.id, { result_seq: seq, during_cancel: duringCancel }, t);
      if (ho.raw) this.ev(r.id, 'handoff_parsed', 'server', { raw: ho.raw.slice(0, 200), matched: ho.handoff_to }, t);
      if (rqRaw) this.ev(r.id, 'request_parsed', 'server', { raw: rqRaw.slice(0, 200), matched: rqTo }, t);
      if (pl.raw) this.ev(r.id, 'pull_parsed', 'server', { raw: pl.raw.slice(0, 200), matched: pl.pull ? pl.pull.thread_id : null }, t);
      this.ev(r.id, 'finalized', 'server', duringCancel ? { state: 'succeeded', completed_first: true } : { state: 'succeeded' }, t);
      if (duringCancel) this.auditCancelFinal(r, 'succeeded', 'completed_first', t, pr.participant.id);
      // 실행이 끝난 뒤에야 아는 실제 런타임·모델을 세션에 적는다 (start 때 값보다 이것이 사실)
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.slice(0, 200) : null);
      this.db
        .prepare('UPDATE agent_sessions SET runtime = COALESCE(?, runtime), actual_model = COALESCE(?, actual_model) WHERE id = ?')
        .run(str(input.runtime), str(input.model), r.session_id);
      return seq;
    })();
    this.emit({ notice: { t: 'msg', thread_id: r.thread_id, seq }, threadId: r.thread_id });
    this.emit({ notice: { t: 'run', thread_id: r.thread_id, run_id: r.id, state: 'succeeded' }, threadId: r.thread_id });
    if (requestDelivery) this.emit({ notice: { t: 'delivery', thread_id: r.thread_id }, threadId: r.thread_id, only: rqTo! });
    const run = this.toRunOut(this.runRow(r.id)!);
    return { run, message: toMessage(this.db.prepare('SELECT * FROM messages WHERE seq = ?').get(seq) as Row), duplicate: false };
  }

  failRun(pr: Principal, runId: string, input: { run_token?: unknown; error?: unknown }) {
    const r = this.ownRun(pr, runId, input.run_token);
    if (r.state !== 'running' && r.state !== 'queued') {
      this.ev(r.id, 'late_fail', pr.participant.id, { state: r.state });
      throw new ApiError(409, 'bad_state', `run is ${r.state}`);
    }
    const err = typeof input.error === 'string' ? input.error.slice(0, 2000) : 'failed';
    const t = now();
    const duringCancel = r.cancel_requested_at != null;
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE runs SET state = 'failed', ended_at = ?, finalized_at = ?, error = ?, lease_expires_at = NULL WHERE id = ?")
        .run(t, t, err, r.id);
      this.ev(r.id, 'failed', pr.participant.id, { error: err.slice(0, 200), during_cancel: duringCancel }, t);
      this.ev(r.id, 'finalized', 'server', duringCancel ? { state: 'failed', failed_first: true } : { state: 'failed' }, t);
      if (duringCancel) this.auditCancelFinal(r, 'failed', 'failed_first', t, pr.participant.id);
      this.face?.faceOnFail(r, t);
    })();
    this.emit({ notice: { t: 'run', thread_id: r.thread_id, run_id: r.id, state: 'failed' }, threadId: r.thread_id });
    return { ok: true, state: 'failed' };
  }

  listRuns(pr: Principal, threadId: string, limit = 50): Run[] {
    this.requireRead(pr, threadId, 'thread.read', true);
    return (
      this.db.prepare('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?').all(threadId, Math.min(limit, 200)) as Row[]
    ).map((r) => this.toRunOut(r));
  }

  listDeliveries(pr: Principal, threadId: string) {
    this.requireRead(pr, threadId, 'thread.read', true);
    return this.db
      .prepare(
        `SELECT d.id, d.message_seq, d.recipient_id, d.status, d.attempts, d.acked_at, d.retry_at, d.last_error, d.created_at, d.forwarded_by, d.forward_note,
                (SELECT r.id FROM runs r WHERE r.delivery_id = d.id ORDER BY r.generation DESC LIMIT 1) AS run_id,
                (SELECT r.state FROM runs r WHERE r.delivery_id = d.id ORDER BY r.generation DESC LIMIT 1) AS run_state,
                (SELECT r.cancel_requested_at IS NOT NULL FROM runs r WHERE r.delivery_id = d.id ORDER BY r.generation DESC LIMIT 1) AS run_cancel_requested,
                d.pulled_from, (SELECT title FROM threads WHERE id = d.pulled_from) AS pulled_title,
                CASE WHEN d.pulled IS NULL THEN NULL ELSE json_array_length(d.pulled, '$.messages') END AS pulled_count,
                CASE WHEN d.pulled IS NULL THEN NULL ELSE json_extract(d.pulled, '$.from_seq') END AS pulled_from_seq,
                CASE WHEN d.pulled IS NULL THEN NULL ELSE json_extract(d.pulled, '$.to_seq') END AS pulled_to_seq,
                (SELECT json_extract(r.usage, '$.context.pulled_truncated') FROM runs r WHERE r.delivery_id = d.id AND r.state = 'succeeded' ORDER BY r.generation DESC LIMIT 1) AS pulled_truncated
           FROM deliveries d WHERE d.thread_id = ? ORDER BY d.message_seq`,
      )
      .all(threadId);
  }

  /** 끌어오기 신호의 후보 = 작성자가 읽을 수 있는 다른 스레드(휴지통 제외) — 가시성 거울: 못 읽는 스레드는 아예 이름으로 안 잡힌다 */
  private pullCandidates(threadId: string, authorId: string): { id: string; title: string }[] {
    return this.db
      .prepare(
        `SELECT t.id, t.title FROM threads t JOIN thread_members m ON m.thread_id = t.id AND m.participant_id = ? AND m.can_read = 1
          WHERE t.id <> ? AND t.deleted_at IS NULL`,
      )
      .all(authorId, threadId) as { id: string; title: string }[];
  }

  /** 그 에이전트가 마지막으로 신고한 맥락 예산(openai 경로가 run 마다 usage.context.budget_tokens 로 올린다). 없으면 null */
  private lastBudget(agentId: string): number | null {
    const rows = this.db
      .prepare("SELECT usage FROM runs WHERE agent_id = ? AND state = 'succeeded' AND usage LIKE '%budget_tokens%' ORDER BY ended_at DESC LIMIT 1")
      .all(agentId) as Row[];
    try {
      const b = rows.length ? JSON.parse(rows[0].usage as string)?.context?.budget_tokens : null;
      return typeof b === 'number' && b > 0 ? b : null;
    } catch {
      return null;
    }
  }

  /** 끌어올 원문 고르기: 범위가 있으면 그 범위의 그 스레드 글, 없으면 최근 글 — 상한 cfg.pullMaxMessages(넘으면 거절) */
  private pullSelect(req: PullRequest): Row[] {
    const max = this.cfg.pullMaxMessages;
    if (req.from_seq !== null) {
      const to = req.to_seq ?? req.from_seq;
      const rows = this.db
        .prepare('SELECT * FROM messages WHERE thread_id = ? AND seq BETWEEN ? AND ? ORDER BY seq LIMIT ?')
        .all(req.thread_id, req.from_seq, to, max + 1) as Row[];
      if (rows.length > max) throw new ApiError(400, 'pull_too_many', `범위가 글 ${max}개를 넘는다 — 범위를 좁힌다`, undefined, { key: 'err.pull_too_many', vars: { max: max } });
      return rows;
    }
    return (this.db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT ?').all(req.thread_id, max) as Row[]).reverse();
  }

  private pullPlan(pr: Principal, threadId: string, seq: number) {
    this.requireMaster(pr, 'message.pull', { target_type: 'message', target_id: String(seq), thread_id: threadId });
    const thread = this.requireRead(pr, threadId, 'message.pull');
    const m = this.db.prepare('SELECT * FROM messages WHERE seq = ? AND thread_id = ?').get(seq, threadId) as Row | undefined;
    if (!m) throw new ApiError(404, 'no_message');
    if (!m.pull_req) throw new ApiError(400, 'no_pull_request', '이 글에는 끌어오기 신호(← …)가 없다', undefined, { key: 'err.no_pull_request' });
    const req = JSON.parse(m.pull_req as string) as PullRequest;
    const agent = m.author_id as string;
    const src = this.db.prepare('SELECT id, title, deleted_at FROM threads WHERE id = ?').get(req.thread_id) as Row | undefined;
    if (!src || src.deleted_at) throw new ApiError(409, 'pull_source_gone', '원본 스레드가 없거나 휴지통에 있다', undefined, { key: 'err.pull_source_gone' });
    // 가시성 거울: 받는 에이전트(= 청한 에이전트)가 원본 스레드를 지금도 읽을 수 있어야 한다
    if (!this.canRead(agent, req.thread_id)) throw new ApiError(400, 'recipient_cannot_read', '받는 에이전트가 원본 스레드를 못 읽는다', undefined, { key: 'err.recipient_cannot_read' });
    const rows = this.pullSelect(req);
    if (!rows.length) throw new ApiError(400, 'pull_empty', '가져올 글이 없다', undefined, { key: 'err.pull_empty' });
    const atts = (q: number) => (this.db.prepare('SELECT name FROM attachments WHERE message_seq = ? ORDER BY id').all(q) as Row[]).map((a) => a.name as string);
    const messages: PulledMessage[] = rows.map((r) => {
      const p = this.getParticipant(r.author_id as string);
      return {
        seq: r.seq as number,
        author_id: r.author_id as string,
        author_name: this.nameOf(r.author_id as string),
        is_master: !!p?.is_master,
        source_kind: r.source_kind as SourceKind,
        body: r.body as string,
        created_at: r.created_at as number,
        attachments: atts(r.seq as number),
      };
    });
    const pulled: ClaimPulled = { thread: { id: src.id as string, title: src.title as string }, from_seq: messages[0].seq, to_seq: messages[messages.length - 1].seq, messages };
    const est = estimateTokens(messages.map((x) => `${x.author_name} ${x.body} ${x.attachments.join(' ')}`).join('\n')) + messages.length * 12;
    const budget = this.lastBudget(agent);
    // 예산 거울(#158): 받는 쪽이 마지막으로 신고한 예산과 맞댄다 — 넘으면 거절, 1/3 넘으면 경고, 신고 없으면 모름
    const level = budget === null ? 'unknown' : est > budget ? 'over' : est > budget / 3 ? 'warn' : 'ok';
    return { thread, m, agent, pulled, est, budget, level: level as 'ok' | 'warn' | 'over' | 'unknown' };
  }

  /** 끌어오기 미리보기(마스터) — 누르기 전에 범위·크기·예산 판정을 본다 */
  pullPreview(pr: Principal, threadId: string, seq: number) {
    const p = this.pullPlan(pr, threadId, seq);
    return {
      source: p.pulled.thread,
      from_seq: p.pulled.from_seq,
      to_seq: p.pulled.to_seq,
      count: p.pulled.messages.length,
      est_tokens: p.est,
      budget_tokens: p.budget,
      level: p.level,
      recipient: p.agent,
    };
  }

  /**
   * 끌어오기(2026-10-13 마스터 #162): 에이전트가 끝줄 «← …»로 청한 맥락을, 마스터가 눌러 그 에이전트에게 건넨다.
   * 새 메시지 없이 그 글에 대한 배달 하나(받는 쪽 = 청한 에이전트)에 원문 사본을 붙인다 — 한 번만 실린다.
   * 같은 글은 한 번(UNIQUE) · 거둔 것(실행 없음)은 다시 · 새 호출 금지면 409 · 예산을 넘으면 409.
   */
  pullContext(pr: Principal, threadId: string, seq: number) {
    const p = this.pullPlan(pr, threadId, seq);
    if (p.thread.deleted_at) throw new ApiError(409, 'thread_deleted');
    if (p.thread.status !== 'open') throw new ApiError(409, 'thread_closed');
    if (p.thread.invoke_paused) throw new ApiError(409, 'invoke_paused', '새 호출 금지 중 — 풀고 다시 누르세요', undefined, { key: 'err.invoke_paused.retry' });
    if (p.level === 'over') throw new ApiError(409, 'over_budget', `가져올 것(약 ${p.est}토큰)이 받는 쪽 예산(${p.budget})을 넘는다 — 범위를 좁힌다`, undefined, { key: 'err.over_budget', vars: { est: p.est, budget: p.budget } });
    const t = now();
    const snap = JSON.stringify(p.pulled);
    // 누른 시점의 스레드 머리 — 청한 글 뒤에 오간 대화도 이번 턴에 싣고, 실어 보낸 데까지만 «본 것»으로 친다(#165 · 수동 전달과 같은 칸)
    const head = this.threadMaxSeq(threadId) ?? seq;
    const res = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT OR IGNORE INTO deliveries(id, message_seq, thread_id, recipient_id, status, attempts, created_at, updated_at, pulled, pulled_from, context_upto_seq)
           VALUES (?,?,?,?, 'pending', 0, ?, ?, ?, ?, ?)`,
        )
        .run(newId('dlv'), seq, threadId, p.agent, t, t, snap, p.pulled.thread.id, head);
      let d = this.db.prepare('SELECT id, message_seq, recipient_id, status, pulled_from FROM deliveries WHERE message_seq = ? AND recipient_id = ?').get(seq, p.agent) as Row;
      let duplicate = info.changes === 0;
      if (duplicate && (d.status === 'cancelled' || d.status === 'dead') && !this.db.prepare('SELECT 1 FROM runs WHERE trigger_seq = ? AND agent_id = ?').get(seq, p.agent)) {
        this.db
          .prepare(
            `UPDATE deliveries SET status = 'pending', attempts = 0, last_error = NULL, retry_at = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
                    pulled = ?, pulled_from = ?, context_upto_seq = ?, updated_at = ? WHERE id = ?`,
          )
          .run(snap, p.pulled.thread.id, head, t, d.id);
        d = this.db.prepare('SELECT id, message_seq, recipient_id, status, pulled_from FROM deliveries WHERE id = ?').get(d.id) as Row;
        duplicate = false;
      }
      this.audit({
        actor: this.actorOf(pr),
        action: 'message.pull',
        result: duplicate ? 'noop' : 'ok',
        reason: duplicate ? 'already_delivered' : null,
        target_type: 'message',
        target_id: String(seq),
        thread_id: threadId,
        after: { delivery_id: d.id, recipient_id: p.agent, from_thread: p.pulled.thread.id, from_seq: p.pulled.from_seq, to_seq: p.pulled.to_seq, count: p.pulled.messages.length, est_tokens: p.est, budget_tokens: p.budget, level: p.level },
      });
      return { d, duplicate };
    })();
    if (!res.duplicate) {
      this.emit({ notice: { t: 'delivery', thread_id: threadId }, threadId, only: p.agent });
      this.emit({ notice: { t: 'thread', thread_id: threadId }, threadId });
    }
    return { ok: true, duplicate: res.duplicate, delivery: res.d, level: p.level, est_tokens: p.est, budget_tokens: p.budget, count: p.pulled.messages.length };
  }

  /** 넘김 신호의 후보 = 이 스레드에서 읽을 수 있는 다른 에이전트 */
  private handoffCandidates(threadId: string, authorId: string): { id: string; name: string }[] {
    return this.db
      .prepare(
        `SELECT p.id, p.name FROM thread_members m JOIN participants p ON p.id = m.participant_id
          WHERE m.thread_id = ? AND p.kind = 'agent' AND m.can_read = 1 AND p.id <> ?`,
      )
      .all(threadId, authorId) as { id: string; name: string }[];
  }

  /**
   * 수동 전달(2026-10-12 마스터 #62): 에이전트 글 하나를 다른 에이전트 한 명에게 «이 글에 답하라»로 넘긴다. 마스터만.
   * 새 메시지를 만들지 않는다 — 원글에 대한 배달 하나(forwarded_by · context_upto_seq = 지금 스레드 머리).
   * 같은 글·같은 대상은 한 번뿐(UNIQUE(message_seq, recipient_id)) — 다시 누르면 duplicate.
   * «새 호출 금지» 중이면 거절한다(눌렀는데 아무 일 없다가 풀 때 몰아서 터지지 않게).
   */
  forwardMessage(pr: Principal, threadId: string, seq: number, input: { recipient?: unknown; note?: unknown } = {}) {
    const target = { target_type: 'message', target_id: String(seq), thread_id: threadId };
    this.requireMaster(pr, 'message.forward', target);
    const thread = this.requireRead(pr, threadId, 'message.forward');
    if (thread.deleted_at) throw new ApiError(409, 'thread_deleted');
    if (thread.status !== 'open') throw new ApiError(409, 'thread_closed');
    if (thread.invoke_paused) throw new ApiError(409, 'invoke_paused', '새 호출 금지 중 — 풀고 다시 누르세요', undefined, { key: 'err.invoke_paused.retry' });
    const m = this.db.prepare('SELECT * FROM messages WHERE seq = ? AND thread_id = ?').get(seq, threadId) as Row | undefined;
    if (!m) throw new ApiError(404, 'no_message');
    const author = this.getParticipant(m.author_id as string);
    if (!author || author.kind !== 'agent') throw new ApiError(400, 'not_agent_message', '에이전트 글만 전달한다 — 마스터 글은 수신 대상으로 보낸다', undefined, { key: 'err.not_agent_message' });
    const rid = input.recipient;
    if (typeof rid !== 'string' || !this.handoffCandidates(threadId, author.id).some((c) => c.id === rid))
      throw new ApiError(400, 'bad_recipient', '이 스레드의 다른 에이전트 한 명', undefined, { key: 'err.bad_recipient.forward' });
    // 전달 메모(#740): 선택 · 앞뒤 공백을 걷고 비면 없음
    if (input.note != null && typeof input.note !== 'string') throw new ApiError(400, 'bad_request', 'note 는 문자열', undefined, { key: 'err.bad_request.note_string' });
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;
    if (note && note.length > FORWARD_NOTE_MAX) throw new ApiError(400, 'note_too_long', `전달 메모는 ${FORWARD_NOTE_MAX}자까지`, undefined, { key: 'err.note_too_long', vars: { max: FORWARD_NOTE_MAX } });
    const t = now();
    const head = this.threadMaxSeq(threadId) ?? seq;
    const res = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT OR IGNORE INTO deliveries(id, message_seq, thread_id, recipient_id, status, attempts, created_at, updated_at, forwarded_by, context_upto_seq, forward_note)
           VALUES (?,?,?,?, 'pending', 0, ?, ?, ?, ?, ?)`,
        )
        .run(newId('dlv'), seq, threadId, rid, t, t, pr.participant.id, head, note);
      let d = this.db.prepare('SELECT id, message_seq, recipient_id, status, forwarded_by, context_upto_seq, forward_note FROM deliveries WHERE message_seq = ? AND recipient_id = ?').get(seq, rid) as Row;
      let duplicate = info.changes === 0;
      // 거둔(취소·실패) 전달은 실행이 안 생겼으면 다시 보낼 수 있다 — 같은 행을 되살린다(UNIQUE 그대로)
      if (duplicate && (d.status === 'cancelled' || d.status === 'dead')) {
        const ran = this.db.prepare('SELECT 1 FROM runs WHERE trigger_seq = ? AND agent_id = ?').get(seq, rid);
        if (!ran) {
          this.db
            .prepare(
              `UPDATE deliveries SET status = 'pending', attempts = 0, last_error = NULL, retry_at = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
                      forwarded_by = ?, context_upto_seq = ?, forward_note = ?, updated_at = ? WHERE id = ?`,
            )
            .run(pr.participant.id, head, note, t, d.id);
          d = this.db.prepare('SELECT id, message_seq, recipient_id, status, forwarded_by, context_upto_seq, forward_note FROM deliveries WHERE id = ?').get(d.id) as Row;
          duplicate = false;
        }
      }
      this.audit({
        actor: this.actorOf(pr),
        action: 'message.forward',
        result: duplicate ? 'noop' : 'ok',
        reason: duplicate ? 'already_delivered' : null,
        target_type: 'message',
        target_id: String(seq),
        thread_id: threadId,
        after: { delivery_id: d.id, recipient_id: rid, context_upto_seq: duplicate ? d.context_upto_seq : head, signalled: JSON.parse(m.handoff_to ?? '[]').includes(rid), note: duplicate ? undefined : note ?? undefined },
      });
      return { d, duplicate };
    })();
    if (!res.duplicate) {
      this.emit({ notice: { t: 'delivery', thread_id: threadId }, threadId, only: rid });
      this.emit({ notice: { t: 'thread', thread_id: threadId }, threadId });
    }
    return { ok: true, duplicate: res.duplicate, delivery: res.d };
  }

  // ───────────────────────── 실행 목록 · 상세 (마스터 화면) ─────────────────────────

  /**
   * 스레드를 가로지르는 실행 목록. 필터: state(6상태 · 'cancel_requested' · 'waiting'), agent, thread, since(ms).
   * 기간 필터는 끝난 실행에만 건다 — 진행 중 실행과 전달 대기는 언제 생겼든 보인다.
   * waiting = 전달만 있고 아직 실행이 안 생긴 것(«전달 대기», 실행 행이 없음).
   */
  listRunsAll(pr: Principal, q: { state?: unknown; agent?: unknown; thread?: unknown; since?: unknown; limit?: unknown } = {}) {
    this.requireMaster(pr, 'runs.view');
    this.sweep();
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const state = str(q.state);
    const agent = str(q.agent);
    const thread = str(q.thread);
    const since = Number(q.since) > 0 ? Number(q.since) : null;
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const RUN_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'];
    if (state && !RUN_STATES.includes(state) && state !== 'cancel_requested' && state !== 'waiting')
      throw new ApiError(400, 'bad_state_filter', 'state: queued|running|succeeded|failed|cancelled|unknown|cancel_requested|waiting');
    const where: string[] = [];
    const params: unknown[] = [];
    if (agent) (where.push('r.agent_id = ?'), params.push(agent));
    if (thread) (where.push('r.thread_id = ?'), params.push(thread));
    if (since) (where.push("(r.created_at >= ? OR r.state IN ('queued','running'))"), params.push(since));
    if (state === 'cancel_requested') where.push("r.state = 'running' AND r.cancel_requested_at IS NOT NULL");
    else if (state && state !== 'waiting') (where.push('r.state = ?'), params.push(state));
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    let runs: (Run & { thread_title: string; thread_kind: Thread['kind'] })[] = [];
    let total = 0;
    if (state !== 'waiting') {
      total = (this.db.prepare(`SELECT COUNT(*) AS n FROM runs r ${w}`).get(...params) as Row).n;
      runs = (
        this.db
          .prepare(`SELECT r.*, t.title AS thread_title, t.kind AS thread_kind FROM runs r JOIN threads t ON t.id = r.thread_id ${w} ORDER BY r.created_at DESC LIMIT ?`)
          .all(...params, limit) as Row[]
      ).map((r) => ({ ...this.toRunOut(r), thread_title: r.thread_title, thread_kind: r.thread_kind === 'room' ? 'room' : 'thread' }));
    }
    let waiting: Row[] = [];
    if (!state || state === 'waiting') {
      const dw: string[] = ["d.status IN ('pending','leased')", 'NOT EXISTS (SELECT 1 FROM runs r WHERE r.trigger_seq = d.message_seq AND r.agent_id = d.recipient_id)'];
      const dp: unknown[] = [];
      if (agent) (dw.push('d.recipient_id = ?'), dp.push(agent));
      if (thread) (dw.push('d.thread_id = ?'), dp.push(thread));
      waiting = (
        this.db
          .prepare(
            `SELECT d.id, d.message_seq, d.thread_id, d.recipient_id, d.status, d.attempts, d.retry_at, d.last_error, d.created_at,
                    t.title AS thread_title, t.kind AS thread_kind
             FROM deliveries d JOIN threads t ON t.id = d.thread_id WHERE ${dw.join(' AND ')} ORDER BY d.message_seq LIMIT 200`,
          )
          .all(...dp) as Row[]
      ).map((d) => ({ ...d, thread_kind: d.thread_kind === 'room' ? 'room' : 'thread' }));
    }
    return { runs, total, waiting, cancel_ack_ms: this.cfg.cancelAckMs };
  }

  /** 실행 상세: 기본 정보·입력(원인 글·넘긴 seq·세대)·출력(답 글)·이벤트 로그. 그 스레드를 읽을 수 있어야 한다 */
  getRunDetail(pr: Principal, runId: string) {
    this.sweep();
    const r = this.runRow(runId);
    if (!r) throw new ApiError(404, 'no_run');
    if (!this.canRead(pr.participant.id, r.thread_id))
      this.deny(pr, new ApiError(404, 'no_run'), { action: 'run.read', target_type: 'run', target_id: runId, thread_id: r.thread_id, reason: 'not_member' });
    const t = this.db.prepare('SELECT id, title, kind, parent_thread_id, fork_seq FROM threads WHERE id = ?').get(r.thread_id) as Row;
    const agent = this.db.prepare('SELECT id, name FROM participants WHERE id = ?').get(r.agent_id) as Row;
    const s = this.db
      .prepare('SELECT id, generation, status, runtime, actual_model, config_version FROM agent_sessions WHERE id = ?')
      .get(r.session_id) as Row;
    const trig = this.db.prepare('SELECT * FROM messages WHERE seq = ?').get(r.trigger_seq) as Row | undefined;
    const res = r.result_seq ? (this.db.prepare('SELECT * FROM messages WHERE seq = ?').get(r.result_seq) as Row | undefined) : undefined;
    let snap: Row = {};
    try {
      snap = JSON.parse(r.input_snapshot);
    } catch {}
    const events = (this.db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY id').all(r.id) as Row[]).map(toEvent);
    return {
      run: this.toRunOut(r),
      thread: { id: t.id, title: t.title, kind: t.kind === 'room' ? 'room' : 'thread', parent_thread_id: t.parent_thread_id, fork_seq: t.fork_seq },
      agent: { id: agent.id, name: agent.name },
      session: s
        ? { id: s.id, generation: s.generation, status: s.status, runtime: s.runtime, actual_model: s.actual_model, config_version: s.config_version }
        : null,
      input: {
        trigger: trig ? toMessage(trig) : null,
        seqs: Array.isArray(snap.seqs) ? (snap.seqs as [number, number][]).map((x) => x[0]) : [],
        worker: typeof snap.worker === 'string' ? snap.worker : null,
      },
      output: { message: res ? toMessage(res) : null },
      events,
      cancel_ack_ms: this.cfg.cancelAckMs,
    };
  }

  /**
   * «상태 새로 확인»: 무응답 제한 판정을 먼저 돌리고(sweep) 저장된 최종 상태와 확인 시각을 돌려준다.
   * 상태는 바꾸지 않는다 — unknown 은 unknown 그대로, 자동 재실행도 없다(정책 1).
   */
  refreshRun(pr: Principal, runId: string) {
    this.requireMaster(pr, 'run.refresh', { target_type: 'run', target_id: runId });
    this.sweep();
    const r = this.runRow(runId);
    if (!r) throw new ApiError(404, 'no_run');
    const t = now();
    this.db.transaction(() => {
      this.db.prepare('UPDATE runs SET last_checked_at = ? WHERE id = ?').run(t, r.id);
      this.ev(r.id, 'checked', pr.participant.id, { state: r.state }, t);
    })();
    return this.getRunDetail(pr, runId);
  }

  // ───────────────────────── 멈춤 · 취소 ─────────────────────────

  /**
   * 실행 하나에 취소 요청을 건다(트랜잭션 안에서 부른다). 정책 1:
   *   queued  → 즉시 cancelled (어댑터는 start 가 거절돼 돌리지 않는다)
   *   running → 요청만 기록(«중단 요청됨»). heartbeat 가 cancel 을 싣고, 어댑터 확인이면 cancelled, cancelAckMs 무응답이면 unknown
   *   그 밖   → 상태를 바꾸지 않는다(이벤트만)
   */
  /** @internal 모듈(src/modules)도 부른다 */ requestCancel(r: Row, who: string, t: number, actor?: AuditActor): CancelResult {
    const o = this.requestCancelInner(r, who, t);
    // 실행 취소·중단(정책 9). 실행 중이면 «요청»만 — 최종 결과는 auditCancelFinal 이 같은 감사 식별자로 잇는다
    const a = actor ?? { id: who, kind: 'master' as const };
    const base = { actor: a, action: 'run.cancel', target_type: 'run', target_id: r.id as string, thread_id: r.thread_id as string, requested_at: t, before: { state: r.state } };
    if (o === 'cancelled') this.audit({ ...base, result: 'ok', reason: 'queued_cancelled', after: { state: 'cancelled' } });
    else if (o === 'requested') this.audit({ ...base, result: 'requested', after: { state: 'running', cancel_requested: true, ack_limit_ms: this.cfg.cancelAckMs } });
    else this.audit({ ...base, result: 'noop', reason: o, after: { state: r.state } });
    return o;
  }

  private requestCancelInner(r: Row, who: string, t: number): CancelResult {
    if (r.state === 'queued') {
      this.db
        .prepare(
          "UPDATE runs SET state = 'cancelled', cancel_requested = 1, cancel_requested_by = ?, cancel_requested_at = ?, ended_at = ?, finalized_at = ?, error = 'cancelled_by_master', lease_expires_at = NULL WHERE id = ? AND state = 'queued'",
        )
        .run(who, t, t, t, r.id);
      this.ev(r.id, 'cancel_requested', who, { from_state: 'queued' }, t);
      this.ev(r.id, 'finalized', 'server', { state: 'cancelled', before_start: true }, t);
      return 'cancelled';
    }
    if (r.state === 'running') {
      if (r.cancel_requested_at != null) {
        this.ev(r.id, 'cancel_repeat', who, null, t);
        return 'already_requested';
      }
      this.db
        .prepare('UPDATE runs SET cancel_requested = 1, cancel_requested_by = ?, cancel_requested_at = ? WHERE id = ? AND state = ?')
        .run(who, t, r.id, 'running');
      this.ev(r.id, 'cancel_requested', who, { from_state: 'running', ack_limit_ms: this.cfg.cancelAckMs }, t);
      return 'requested';
    }
    this.ev(r.id, 'cancel_after_final', who, { state: r.state }, t);
    return 'already_final';
  }

  /**
   * stop_new       — «새 호출 금지»: 이 스레드에 새 전달을 만들지 않고, 아직 안 나간 전달·시작 전 실행을 거둔다. 도는 실행은 둔다.
   * cancel_current — «현재 실행 취소»: 안 나간 전달은 거두고, 대기 중 실행은 즉시 취소, 실행 중인 것은 취소 요청(어댑터 확인/무응답 제한으로 판정, 정책 1).
   */
  stopThread(pr: Principal, threadId: string, mode: unknown) {
    this.requireMaster(pr, 'thread.stop', { target_type: 'thread', target_id: threadId, thread_id: threadId });
    const th = this.requireThread(threadId);
    let withdrawn = 0;
    this.sweep();
    const t = now();
    const who = pr.participant.id;
    const cancelled: string[] = [];
    const requested: string[] = [];
    this.db.transaction(() => {
      if (mode === 'stop_new') {
        this.db.prepare('UPDATE threads SET invoke_paused = 1, updated_at = ? WHERE id = ?').run(t, threadId);
        withdrawn = this.db
          .prepare("UPDATE deliveries SET status = 'cancelled', last_error = 'stop_new', lease_token_hash = NULL, updated_at = ? WHERE thread_id = ? AND status IN ('pending','leased')")
          .run(t, threadId).changes;
        const qs = this.db.prepare("SELECT * FROM runs WHERE thread_id = ? AND state = 'queued'").all(threadId) as Row[];
        for (const r of qs) {
          this.db
            .prepare(
              "UPDATE runs SET state = 'cancelled', cancel_requested = 1, cancel_requested_by = ?, cancel_requested_at = ?, ended_at = ?, finalized_at = ?, error = 'stop_new', lease_expires_at = NULL WHERE id = ?",
            )
            .run(who, t, t, t, r.id);
          this.ev(r.id, 'withdrawn', who, { mode: 'stop_new' }, t);
          this.ev(r.id, 'finalized', 'server', { state: 'cancelled', before_start: true }, t);
          cancelled.push(r.id);
        }
      } else if (mode === 'cancel_current') {
        // 아직 어댑터가 안 가져간 전달도 거둔다(마스터 #475 «보낸 메시지 취소» — 보낸 직후엔 실행이 아직 없다) · 호출 금지는 걸지 않는다
        withdrawn = this.db
          .prepare("UPDATE deliveries SET status = 'cancelled', last_error = 'cancel_current', lease_token_hash = NULL, updated_at = ? WHERE thread_id = ? AND status IN ('pending','leased')")
          .run(t, threadId).changes;
        const rs = this.db.prepare("SELECT * FROM runs WHERE thread_id = ? AND state IN ('queued','running')").all(threadId) as Row[];
        for (const r of rs) {
          const o = this.requestCancel(r, who, t, this.actorOf(pr));
          if (o === 'cancelled') cancelled.push(r.id);
          else if (o === 'requested' || o === 'already_requested') requested.push(r.id);
        }
      } else throw new ApiError(400, 'bad_mode', "mode: 'stop_new' | 'cancel_current'");
      this.audit({
        actor: this.actorOf(pr),
        action: 'thread.stop',
        target_type: 'thread',
        target_id: threadId,
        thread_id: threadId,
        result: 'ok',
        reason: String(mode),
        before: { invoke_paused: !!th.invoke_paused },
        after: { invoke_paused: mode === 'stop_new' ? true : !!th.invoke_paused, cancelled_runs: cancelled.length, cancel_requested_runs: requested.length, withdrawn_deliveries: withdrawn },
      });
    })();
    for (const id of cancelled) this.emit({ notice: { t: 'run', thread_id: threadId, run_id: id, state: 'cancelled' }, threadId });
    for (const id of requested) this.emit({ notice: { t: 'run', thread_id: threadId, run_id: id, state: 'running' }, threadId });
    this.emit({ notice: { t: 'thread', thread_id: threadId }, threadId });
    return { ok: true, cancelled_runs: cancelled, cancel_requested_runs: requested, withdrawn_deliveries: withdrawn };
  }

  resumeThread(pr: Principal, threadId: string) {
    this.requireMaster(pr, 'thread.resume', { target_type: 'thread', target_id: threadId, thread_id: threadId });
    const th = this.requireThread(threadId);
    this.db.transaction(() => {
      this.db.prepare('UPDATE threads SET invoke_paused = 0, updated_at = ? WHERE id = ?').run(now(), threadId);
      this.audit({
        actor: this.actorOf(pr),
        action: 'thread.resume',
        target_type: 'thread',
        target_id: threadId,
        thread_id: threadId,
        result: th.invoke_paused ? 'ok' : 'noop',
        reason: th.invoke_paused ? null : 'unchanged',
        before: { invoke_paused: !!th.invoke_paused },
        after: { invoke_paused: false },
      });
    })();
    this.emit({ notice: { t: 'thread', thread_id: threadId }, threadId });
    return { ok: true };
  }

  /** 스레드와 그 아래(분기의 분기까지) — 첫 원소가 자기 자신 */
  private subtree(threadId: string): string[] {
    return (
      this.db
        .prepare(
          `WITH RECURSIVE sub(id, d) AS (SELECT ?, 0 UNION SELECT t.id, sub.d + 1 FROM threads t JOIN sub ON t.parent_thread_id = sub.id)
           SELECT id FROM sub ORDER BY d`,
        )
        .all(threadId) as Row[]
    ).map((r) => r.id as string);
  }

  /**
   * 스레드 정리(마스터만 · 2026-10-11): 보관(읽기 전용)·숨김(목록에서만)·휴지통과 그 되돌리기.
   * 고른 스레드와 그 아래 분기 전부에 걸린다(폴더처럼). 메인 채팅방은 안 된다.
   * 보관·휴지통은 실행 중(queued·running)인 스레드가 묶음에 있으면 거절하고, 대기 중 전달은 거둔다.
   */
  setThreadState(pr: Principal, threadId: string, action: unknown) {
    const act = String(action);
    const audAct = `thread.${act}`;
    this.requireMaster(pr, audAct, { target_type: 'thread', target_id: threadId, thread_id: threadId });
    if (!THREAD_STATE_ACTIONS.includes(act as ThreadStateAction)) throw new ApiError(400, 'bad_action', THREAD_STATE_ACTIONS.join(' | '));
    const th = this.requireThread(threadId);
    if (th.kind === 'room') throw new ApiError(409, 'room_locked', '메인 채팅방은 보관·숨김·삭제할 수 없다', undefined, { key: 'err.room_locked.state' });
    if (th.deleted_at && act !== 'restore') throw new ApiError(409, 'thread_deleted', '휴지통에 있는 스레드는 복구만 된다', undefined, { key: 'err.thread_deleted.restore_only' });
    const ids = this.subtree(threadId);
    const inList = `(${ids.map(() => '?').join(',')})`;
    const t = now();
    if (act === 'archive' || act === 'trash') {
      const active = this.db.prepare(`SELECT id FROM runs WHERE thread_id IN ${inList} AND state IN ('queued','running')`).all(...ids) as Row[];
      if (active.length) throw new ApiError(409, 'runs_active', `실행 중인 run ${active.length}개 — 먼저 멈춘다`, undefined, { key: 'err.runs_active', vars: { n: active.length } });
    }
    const sql: Record<ThreadStateAction, [string, unknown[]]> = {
      archive: [`UPDATE threads SET status = 'archived', updated_at = ? WHERE id IN ${inList} AND status = 'open' AND deleted_at IS NULL`, [t]],
      unarchive: [`UPDATE threads SET status = 'open', updated_at = ? WHERE id IN ${inList} AND status = 'archived' AND deleted_at IS NULL`, [t]],
      hide: [`UPDATE threads SET hidden = 1 WHERE id IN ${inList} AND hidden = 0 AND deleted_at IS NULL`, []],
      unhide: [`UPDATE threads SET hidden = 0 WHERE id IN ${inList} AND hidden = 1 AND deleted_at IS NULL`, []],
      trash: [`UPDATE threads SET deleted_at = ?, deleted_by = ? WHERE id IN ${inList} AND deleted_at IS NULL`, [t, pr.participant.id]],
      restore: [`UPDATE threads SET deleted_at = NULL, deleted_by = NULL WHERE id IN ${inList} AND deleted_at IS NOT NULL`, []],
    };
    let changed = 0;
    let withdrawn = 0;
    this.db.transaction(() => {
      const [q, args] = sql[act as ThreadStateAction];
      changed = this.db.prepare(q).run(...args, ...ids).changes;
      if (act === 'archive' || act === 'trash')
        withdrawn = this.db
          .prepare(
            `UPDATE deliveries SET status = 'cancelled', last_error = ?, lease_token_hash = NULL, updated_at = ? WHERE thread_id IN ${inList} AND status IN ('pending','leased')`,
          )
          .run(act === 'archive' ? 'archived' : 'trashed', t, ...ids).changes;
      this.audit({
        actor: this.actorOf(pr),
        action: audAct,
        target_type: 'thread',
        target_id: threadId,
        thread_id: threadId,
        result: changed ? 'ok' : 'noop',
        reason: changed ? null : 'unchanged',
        before: { status: th.status, hidden: !!th.hidden, deleted: !!th.deleted_at },
        after: { affected: ids.length, changed, withdrawn_deliveries: withdrawn },
      });
    })();
    for (const id of ids) this.emit({ notice: { t: 'thread', thread_id: id }, threadId: id });
    return { ok: true, affected: ids, changed };
  }

  /**
   * 이름 바꾸기(마스터만 · 2026-10-13): 메인 채팅방·휴지통은 안 된다. 보관 중에는 된다.
   * 이름은 활동이 아니라 updated_at(목록 정렬)을 건드리지 않는다. 에이전트는 다음 턴 머리말에서 새 이름을 본다.
   */
  renameThread(pr: Principal, threadId: string, title: unknown) {
    this.requireMaster(pr, 'thread.rename', { target_type: 'thread', target_id: threadId, thread_id: threadId });
    const next = reqString(title, 'title', 200).trim();
    if (!next) throw new ApiError(400, 'bad_request', 'title required');
    const th = this.requireThread(threadId);
    if (th.kind === 'room') throw new ApiError(409, 'room_locked', '메인 채팅방은 이름을 바꿀 수 없다', undefined, { key: 'err.room_locked.rename' });
    if (th.deleted_at) throw new ApiError(409, 'thread_deleted', '휴지통에 있는 스레드는 복구만 된다', undefined, { key: 'err.thread_deleted.restore_only' });
    const changed = next !== th.title;
    this.db.transaction(() => {
      if (changed) this.db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(next, threadId);
      this.audit({
        actor: this.actorOf(pr),
        action: 'thread.rename',
        target_type: 'thread',
        target_id: threadId,
        thread_id: threadId,
        result: changed ? 'ok' : 'noop',
        reason: changed ? null : 'unchanged',
        before: { title: th.title },
        after: { title: next },
      });
    })();
    if (changed) this.emit({ notice: { t: 'thread', thread_id: threadId }, threadId });
    return { ok: true, changed, thread: toThread({ ...th, title: next }) };
  }

  /**
   * 영구 삭제(마스터만): 휴지통에 있고, 아래 분기도 전부 휴지통이고, confirm 이 제목과 같을 때만.
   * 메시지·첨부(파일 포함)·전달·실행·세션·멤버·맥락을 지운다. 감사 기록은 남는다(FK 없음).
   */
  purgeThread(pr: Principal, threadId: string, confirm: unknown) {
    this.requireMaster(pr, 'thread.purge', { target_type: 'thread', target_id: threadId, thread_id: threadId });
    const th = this.requireThread(threadId);
    if (th.kind === 'room') throw new ApiError(409, 'room_locked');
    if (!th.deleted_at) throw new ApiError(409, 'not_in_trash', '먼저 휴지통에 넣는다', undefined, { key: 'err.not_in_trash' });
    const ids = this.subtree(threadId);
    const inList = `(${ids.map(() => '?').join(',')})`;
    const live = (this.db.prepare(`SELECT COUNT(*) AS n FROM threads WHERE id IN ${inList} AND deleted_at IS NULL`).get(...ids) as Row).n;
    if (live) throw new ApiError(409, 'descendants_not_in_trash', `휴지통 밖의 아래 스레드 ${live}개`, undefined, { key: 'err.descendants_not_in_trash', vars: { n: live } });
    if (typeof confirm !== 'string' || confirm !== th.title) throw new ApiError(400, 'confirm_mismatch', 'confirm 에 스레드 제목을 그대로 적는다', undefined, { key: 'err.confirm_mismatch' });
    const msgs = `(SELECT seq FROM messages WHERE thread_id IN ${inList})`;
    // 합친 뒤 상위로 올라간 분기(#962)는 이 스레드 글을 분기 맥락으로 쥐고 있을 수 있다 — 그 분기부터 지운다(맥락을 몰래 걷지 않는다)
    const held = (this.db.prepare(`SELECT COUNT(DISTINCT thread_id) AS n FROM thread_context WHERE message_seq IN ${msgs} AND thread_id NOT IN ${inList}`).get(...ids, ...ids) as Row).n as number;
    if (held) throw new ApiError(409, 'context_in_use', `다른 스레드 ${held}개가 이 스레드 글을 분기 맥락으로 쓰고 있다 — 그 스레드부터 지운다`, undefined, { key: 'err.context_in_use', vars: { n: held } });
    const files = (this.db.prepare(`SELECT path FROM attachments WHERE message_seq IN ${msgs}`).all(...ids) as Row[]).map((r) => r.path as string);
    let messages = 0;
    this.db.transaction(() => {
      this.db.pragma('defer_foreign_keys = ON');
      const del = (q: string) => this.db.prepare(q).run(...ids).changes;
      del(`DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE thread_id IN ${inList})`);
      del(`DELETE FROM runs WHERE thread_id IN ${inList}`);
      del(`DELETE FROM context_snapshots WHERE thread_id IN ${inList}`);
      del(`DELETE FROM deliveries WHERE thread_id IN ${inList}`);
      del(`DELETE FROM attachments WHERE message_seq IN ${msgs}`);
      del(`DELETE FROM thread_context WHERE thread_id IN ${inList}`);
      del(`DELETE FROM thread_merges WHERE child_thread_id IN ${inList}`);
      del(`DELETE FROM thread_merges WHERE parent_thread_id IN ${inList}`);
      messages = del(`DELETE FROM messages WHERE thread_id IN ${inList}`);
      del(`DELETE FROM agent_sessions WHERE thread_id IN ${inList}`);
      del(`DELETE FROM thread_members WHERE thread_id IN ${inList}`);
      del(`DELETE FROM request_holds WHERE thread_id IN ${inList}`);
      del(`DELETE FROM threads WHERE id IN ${inList}`);
      this.audit({
        actor: this.actorOf(pr),
        action: 'thread.purge',
        target_type: 'thread',
        target_id: threadId,
        thread_id: threadId,
        result: 'ok',
        before: { title: th.title, deleted_at: th.deleted_at },
        after: { threads: ids.length, messages, attachments: files.length },
      });
    })();
    // 파일은 커밋 뒤에 — 지우다 실패해도 DB 는 이미 일관된다(남은 파일은 고아일 뿐)
    for (const f of files) fs.rmSync(path.join(this.cfg.dataDir, f), { force: true });
    for (const id of ids) this.emit({ notice: { t: 'thread', thread_id: id }, threadId: id });
    return { ok: true, purged: ids, messages, attachments: files.length };
  }

  /**
   * 실행 하나 취소 요청(마스터만). 결과(outcome):
   *   cancelled = 대기 중이라 즉시 취소 · requested = 중단 요청됨(어댑터 확인 대기) · already_requested = 이미 요청됨 ·
   *   already_final = 이미 끝난 실행 — 상태를 바꾸지 않았다(최종 상태를 안내한다)
   */
  cancelRun(pr: Principal, runId: string) {
    this.requireMaster(pr, 'run.cancel', { target_type: 'run', target_id: runId });
    this.sweep();
    const t = now();
    const out = this.db.transaction(() => {
      const r = this.runRow(runId);
      if (!r) throw new ApiError(404, 'no_run');
      return { r, outcome: this.requestCancel(r, pr.participant.id, t, this.actorOf(pr)) };
    })();
    const run = this.toRunOut(this.runRow(runId)!);
    if (out.outcome === 'cancelled' || out.outcome === 'requested')
      this.emit({ notice: { t: 'run', thread_id: run.thread_id, run_id: run.id, state: run.state }, threadId: run.thread_id });
    return { ok: true, outcome: out.outcome, state: run.state, run };
  }

  /** 전달 대기(실행이 아직 없는 전달) 거두기 — 마스터만. 실행이 이미 생겼으면 실행 취소를 쓴다(409 has_run) */
  cancelDelivery(pr: Principal, deliveryId: string) {
    this.requireMaster(pr, 'delivery.cancel', { target_type: 'delivery', target_id: deliveryId });
    const t = now();
    const res = this.db.transaction(() => {
      const d = this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId) as Row | undefined;
      if (!d) throw new ApiError(404, 'no_delivery');
      const base = { actor: this.actorOf(pr), action: 'delivery.cancel', target_type: 'delivery', target_id: d.id as string, thread_id: d.thread_id as string, before: { status: d.status, recipient_id: d.recipient_id, message_seq: d.message_seq } };
      const run = this.db.prepare('SELECT id FROM runs WHERE trigger_seq = ? AND agent_id = ? ORDER BY generation DESC LIMIT 1').get(d.message_seq, d.recipient_id) as
        | Row
        | undefined;
      if (run) return { d, outcome: 'has_run' as const, run: run.id as string, base };
      if (d.status !== 'pending' && d.status !== 'leased') {
        this.audit({ ...base, result: 'noop', reason: 'already_final' });
        return { d, outcome: 'already_final' as const };
      }
      this.db
        .prepare("UPDATE deliveries SET status = 'cancelled', last_error = 'cancelled_by_master', lease_token_hash = NULL, updated_at = ? WHERE id = ?")
        .run(t, d.id);
      this.audit({ ...base, result: 'ok', after: { status: 'cancelled' } });
      return { d, outcome: 'cancelled' as const };
    })();
    if (res.outcome === 'has_run') {
      // 트랜잭션 밖에서 남긴다(안에서 던지면 감사 행도 같이 되돌려진다)
      this.audit({ ...res.base!, result: 'failed', reason: 'has_run', after: { run_id: res.run } });
      throw new ApiError(409, 'has_run', `delivery already has run ${res.run} — cancel the run instead`);
    }
    if (res.outcome === 'cancelled') this.emit({ notice: { t: 'thread', thread_id: res.d.thread_id }, threadId: res.d.thread_id });
    const d = this.db.prepare('SELECT id, message_seq, thread_id, recipient_id, status, last_error FROM deliveries WHERE id = ?').get(deliveryId);
    return { ok: true, outcome: res.outcome, delivery: d };
  }

  serverSeq(): number {
    return ((this.db.prepare('SELECT MAX(seq) AS s FROM messages').get() as Row).s as number | null) ?? 0;
  }
}

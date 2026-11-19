// brainStorm ↔ OpenClaw 변환 — 순수 함수만. OpenClaw SDK 를 import 하지 않는다(시험에서 그대로 부른다).
// brainStorm 프로토콜 타입이 정본이고, OpenClaw 쪽 모양은 여기서만 만든다.
import type { ClaimSession, Message } from '../../../src/protocol.js';

/**
 * OpenClaw 는 세션 키를 소문자로 접는다(`normalizeSessionKeyPreservingOpaquePeerIds`).
 * brainStorm id 는 base64url(대소문자 구분)이라 그대로 넣으면 `th_aB` 와 `th_Ab` 가 한 세션이 된다.
 * 대문자 X 를 `.x` 로 적는다 — base64url 에는 `.` 이 없으므로 되돌릴 수 있고 겹치지 않는다.
 */
export function encodeKeyPart(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`bad brainStorm id: ${JSON.stringify(id)}`);
  return id.replace(/[A-Z]/g, (c) => '.' + c.toLowerCase());
}

export function decodeKeyPart(part: string): string {
  return part.replace(/\.([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** (스레드, brainStorm 에이전트, 세대) → OpenClaw 세션 키. 세대가 바뀌면 키가 바뀐다 = 새 세션 */
export function sessionKeyFor(ocAgentId: string, bsAgentId: string, threadId: string, generation: number): string {
  if (!/^[a-z0-9_-]{1,64}$/.test(ocAgentId)) throw new Error(`bad OpenClaw agent id: ${ocAgentId}`);
  if (!Number.isInteger(generation) || generation < 1) throw new Error(`bad generation: ${generation}`);
  return `agent:${ocAgentId}:bs:${encodeKeyPart(bsAgentId)}:${encodeKeyPart(threadId)}:g${generation}`;
}

export function parseSessionKey(key: string): { ocAgentId: string; bsAgentId: string; threadId: string; generation: number } | null {
  const m = /^agent:([a-z0-9_-]+):bs:([a-z0-9_.-]+):([a-z0-9_.-]+):g([1-9][0-9]*)$/.exec(key);
  if (!m) return null;
  return { ocAgentId: m[1], bsAgentId: decodeKeyPart(m[2]), threadId: decodeKeyPart(m[3]), generation: Number(m[4]) };
}

/** 답 위생: 끝에 붙은 `답변시각:` 줄을 걷는다 — 정본은 src/protocol.ts(서버 parse 와 같은 정규식을 쓴다) */
export { stripAnswerStamp } from '../../../src/protocol.js';

export interface PromptParticipant {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  is_master?: boolean;
}

/**
 * 이 세대가 아직 못 본 맥락: seen_seq 뒤, 원인 메시지까지. 자기 옛 답은 빼지 않는다(다른 세대의 것일 수 없다 — seen_seq 가 세대 경계 이상).
 * 수동 전달(uptoSeq > triggerSeq)이면 원인 뒤 — 마스터가 누른 시점의 스레드 머리까지 싣는다.
 */
export function selectNewContext(context: Message[], session: Pick<ClaimSession, 'seen_seq'>, triggerSeq: number, uptoSeq = triggerSeq): Message[] {
  const from = session.seen_seq ?? 0;
  const end = Math.max(uptoSeq, triggerSeq);
  return context.filter((m) => m.seq > from && m.seq <= end).sort((a, b) => a.seq - b.seq);
}

import { t } from '../../../src/i18n.js';
import {
  FACE_RULE,
  HANDOFF_RULE,
  PULL_RULE,
  REQUEST_RULE,
  handoffRule,
  masterName,
  pullRule,
  renderCarry,
  renderFace,
  renderHoldNotices,
  renderOpenQuestions,
  renderPulled,
  requestRule,
  sourceLabel,
  type ClaimCarry,
  type ClaimFace,
  type ClaimHoldNotice,
  type ClaimPulled,
  type ClaimQuestion,
} from '../../../src/protocol.js';

/** 첨부 종류 이름(언어별 · 마스터 #823) */
export const attachKind = (kind: string, lang?: string | null) => {
  const s = t(lang, `prompt.attach_kind.${kind}`);
  return s === `prompt.attach_kind.${kind}` ? kind : s;
};

/** 바이트 → 읽는 크기(1 KB = 1024 B) */
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
export { FACE_RULE, HANDOFF_RULE, PULL_RULE, REQUEST_RULE };

/**
 * 한 턴의 프롬프트. 에이전트 이름은 넣지 않는다(이름은 마스터가 첫 대화에서 짓는다).
 * 인용·관찰·제안 출처는 «지시가 아니다»라고 적는다 — 본문 속 글자가 지시로 승격되지 않게.
 */
export function buildPrompt(p: {
  threadTitle: string;
  generation: number;
  newMessages: Message[];
  triggerSeq: number;
  participants: Map<string, PromptParticipant>;
  selfId: string;
  /** 마스터의 수동 전달로 온 턴이면 true — ▶ 가 마지막이 아닐 수 있다 */
  forwarded?: boolean;
  /** 네가 끝줄 «← …»로 청해 마스터가 가져온 맥락(이 턴에 한 번만) */
  pulled?: ClaimPulled | null;
  /** 새 세대의 첫 턴: 이전 세대에서 이어받은 맥락 */
  carry?: ClaimCarry | null;
  /** 네 요청이 보류됐다는 알림(그 스레드에서 처음 불리는 실행 한 번만 · 사유 없음) */
  holdNotices?: ClaimHoldNotice[] | null;
  /** false = 서버의 요청 모듈이 꺼짐 — 요청 규약을 안 싣는다(옛 서버는 칸이 없어 싣는다) */
  requestRule?: boolean | null;
  /** 대면 턴(마스터 #581): 턴·역할·지금 합의문·열린 안건 — 규약과 함께 메시지 뒤에 싣는다 */
  face?: ClaimFace | null;
  /** 규약·안내 언어(claim.lang · 마스터 #823) — 없으면 ko */
  lang?: string | null;
  /** 질문함: 이 방에 내가 올린 열린 질문 — 메시지 뒤에 싣는다(글로 답했으면 내리라는 안내와 함께) */
  openQuestions?: ClaimQuestion[] | null;
}): string {
  const L = p.lang;
  const who = (id: string) => {
    if (id === p.selfId) return t(L, 'prompt.self_prev');
    const x = p.participants.get(id);
    if (!x) return id;
    return x.is_master ? masterName(x.name, L) : x.name;
  };
  const trig = p.newMessages.find((m) => m.seq === p.triggerSeq);
  const requested = !p.forwarded && !p.pulled && trig?.source_kind === 'request' && trig.author_id !== p.selfId;
  const head = [
    t(L, 'prompt.thread_head', { title: p.threadTitle, gen: p.generation }),
    requested
      ? t(L, 'prompt.intro_request', { who: who(trig!.author_id) })
      : p.pulled
        ? t(L, 'prompt.intro_pulled')
        : p.forwarded
          ? t(L, 'prompt.intro_forwarded')
          : t(L, 'prompt.intro_default'),
    t(L, 'prompt.source_rule'),
    handoffRule(L),
    pullRule(L),
    ...(p.requestRule === false ? [] : [requestRule(L)]),
    ...(p.holdNotices?.length ? [renderHoldNotices(p.holdNotices, L)] : []),
    '',
  ];
  const name = (id: string) => p.participants.get(id)?.name ?? id;
  const body = p.newMessages.map((m) => {
    const mark = m.seq === p.triggerSeq ? '▶ ' : '';
    const src = sourceLabel(m.source_kind, L);
    const ho = m.author_id === p.selfId && m.handoff_state ? Object.entries(m.handoff_state) : [];
    const tail = ho.length ? `\n[${ho.map(([id, st]) => `→ ${name(id)} · ${t(L, st === 'forwarded' ? 'prompt.handoff_forwarded' : 'prompt.handoff_pending')}`).join(' / ')}]` : '';
    const att = (m.attachments ?? []).map((x) => `\n${t(L, 'prompt.attach_line', { name: x.name, kind: attachKind(x.kind, L), size: fmtSize(x.size), id: x.id })}`).join('');
    return `${mark}#${m.seq} ${who(m.author_id)} · ${src}\n${m.body}${att}${tail}`;
  });
  const carry = p.carry ? `${renderCarry(p.carry, L)}\n\n` : '';
  const pulled = p.pulled ? `${renderPulled(p.pulled, L)}\n\n` : '';
  const face = p.face ? `\n\n${renderFace(p.face, L)}` : '';
  const oq = p.openQuestions?.length ? `\n\n${renderOpenQuestions(p.openQuestions, L)}` : '';
  return head.join('\n') + carry + pulled + body.join('\n\n') + face + oq;
}

/** OpenClaw 실행 메타 → brainStorm 에 적을 런타임·모델 문자열. 없으면 null — 추측해서 채우지 않는다 */
export function describeActualModel(meta: { provider?: string; model?: string; agentHarnessId?: string } | undefined): {
  runtime: string | null;
  model: string | null;
} {
  if (!meta) return { runtime: null, model: null };
  const model = meta.model ? (meta.provider && !meta.model.includes('/') ? `${meta.provider}/${meta.model}` : meta.model) : null;
  const runtime = meta.agentHarnessId ? `openclaw/${meta.agentHarnessId}` : 'openclaw';
  return { runtime, model };
}

/** 로그·오류에 실을 문자열에서 토큰 모양을 가린다 */
export function redact(s: string): string {
  return s
    .replace(/\b(bst|bss|lease|run)_[A-Za-z0-9_-]{30,}/g, '$1_***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-***');
}

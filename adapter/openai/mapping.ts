// brainStorm ↔ OpenAI 호환 chat completions 변환 — 순수 함수만(시험이 그대로 부른다).
// brainStorm 프로토콜 타입이 정본이고, chat messages 모양은 여기서만 만든다.
import type { ClaimCarry, ClaimPulled, ClaimSession, Message } from '../../src/protocol.js';
import { renderCarry, renderPulled, sourceLabel } from '../../src/protocol.js';
import { attachKind, fmtSize, redact } from '../openclaw-channel/src/mapping.js';
import { t } from '../../src/i18n.js';

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** 그림이 붙은 메시지만 조각 배열(text + image_url) — 그 밖은 글자 그대로 */
  content: string | ContentPart[];
}

/** 작업자가 미리 받아 둔 첨부 내용(첨부 id → 텍스트 또는 그림 data URL). 없으면 이름·크기만 알린다 */
export interface AttachmentContent {
  text?: string;
  truncated?: boolean;
  dataUrl?: string;
}

/** 그림 한 장의 토큰 근사 — 모델마다 다르다. 넉넉히 잡아 맥락을 넘기지 않게 */
export const IMAGE_TOKENS = 1000;

/** 메시지의 첨부 → 본문 뒤에 붙일 글 + 그림 data URL 들. 텍스트 첨부는 «자료»로 감싼다 */
export function describeAttachments(m: Pick<Message, 'attachments'>, contents?: Map<string, AttachmentContent>, lang?: string | null): { text: string; images: string[] } {
  const parts: string[] = [];
  const images: string[] = [];
  for (const a of m.attachments ?? []) {
    const c = contents?.get(a.id);
    const head = t(lang, 'prompt.oa.attach_head', { name: a.name, kind: attachKind(a.kind, lang), size: fmtSize(a.size) });
    if (c?.text !== undefined) {
      parts.push(head + t(lang, 'prompt.oa.attach_text', { text: c.text, cut: c.truncated ? t(lang, 'prompt.oa.attach_cut') : '' }));
    } else if (c?.dataUrl) {
      parts.push(head + t(lang, 'prompt.oa.attach_image'));
      images.push(c.dataUrl);
    } else parts.push(head + t(lang, 'prompt.oa.attach_none'));
  }
  return { text: parts.join('\n'), images };
}

/** 조합 중의 메시지 — 그림은 끝에 조각으로 바꾼다 */
export interface ChatDraft {
  role: ChatMessage['role'];
  content: string;
  images?: string[];
}

export interface MapParticipant {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  is_master?: boolean;
}

/**
 * 이 세대가 보는 맥락: 세대 경계(base_seq) 뒤 ~ 원인 메시지까지.
 * OpenAI 호환 API 는 상태가 없어서 매 턴 세대 전체를 다시 넘긴다(OpenClaw 처럼 seen_seq 뒤만 넘기면 기억이 끊긴다).
 * 새 세대는 옛 세대의 원문을 받지 않는다 — README «세대» 규칙 그대로.
 * 분기 스레드는 서버가 고른 맥락(thread_context)만 claim.context 에 들어 있으므로 여기서 따로 거를 것이 없다.
 */
export function selectGenerationContext(context: Message[], session: Pick<ClaimSession, 'base_seq'>, trigger: Message, uptoSeq = trigger.seq): Message[] {
  const from = session.base_seq ?? 0;
  if (uptoSeq > trigger.seq) {
    // 수동 전달: 누른 시점의 머리까지 싣되 원인은 맨 뒤로 — chat 은 «마지막 메시지에 답한다»
    const out = context.filter((m) => m.seq > from && m.seq <= uptoSeq && m.seq !== trigger.seq).sort((a, b) => a.seq - b.seq);
    out.push(trigger);
    return out;
  }
  const out = context.filter((m) => m.seq > from && m.seq <= trigger.seq);
  if (!out.some((m) => m.seq === trigger.seq)) out.push(trigger);
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * 토큰 수 근사(토크나이저 없이). 영숫자는 약 3.5자에 1토큰, 한글·한자 등 비ASCII 는 1자에 1토큰으로 보수적으로 센다.
 * 넘치는 쪽보다 모자라는 쪽이 낫다 — 서버가 컨텍스트 초과로 거절하는 것보다 오래된 글 몇 개를 덜 넣는 편이 낫다.
 */
export function estimateTokens(s: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of s) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3.5 + other);
}

const MSG_OVERHEAD = 6; // 역할 표시·구분 토큰 몫

/** «지시 아님» 표시가 붙는 출처 */
const NOT_INSTRUCTION = new Set(['quote', 'observation', 'proposal', 'request']);

/** 끝내지 못한 옛 요청의 표시 — 다음 턴에 그 요청까지 이어 답하지 않게 (2026-10-10 마스터 결정) · 문구는 사전 prompt.oa.outcome.* */
const RUN_OUTCOMES = new Set(['cancelled', 'failed', 'unknown']);

/** 한 메시지 → (역할, 본문). 자기 글 = assistant, 사람 = user, 다른 에이전트 = user 에 `[이름]` 표시 · 첨부는 본문 뒤에 */
export function toChat(
  m: Message,
  selfId: string,
  participants: Map<string, MapParticipant>,
  forwardedSeq?: number,
  contents?: Map<string, AttachmentContent>,
  lang?: string | null,
): ChatDraft {
  if (m.author_id === selfId) {
    // 제 글의 넘김 신호는 서버가 본문에서 뗐다 — 상태로 돌려준다(다음 턴에 «내가 넘겼나»를 보게)
    const ho = m.handoff_state ? Object.entries(m.handoff_state) : [];
    const tail = ho.length ? `\n[${ho.map(([id, st]) => `→ ${participants.get(id)?.name ?? id} · ${t(lang, st === 'forwarded' ? 'prompt.handoff_forwarded' : 'prompt.handoff_pending')}`).join(' / ')}]` : '';
    return { role: 'assistant', content: m.body + tail };
  }
  const p = participants.get(m.author_id);
  const tags: string[] = [];
  if (!p?.is_master) tags.push(`[${p?.name ?? m.author_id}]`);
  if (NOT_INSTRUCTION.has(m.source_kind)) tags.push(`(${t(lang, 'prompt.oa.not_instruction', { source: sourceLabel(m.source_kind, lang) })})`);
  if (forwardedSeq === m.seq) tags.push(t(lang, 'prompt.oa.forwarded_tag'));
  const outcome = m.run_outcome && RUN_OUTCOMES.has(m.run_outcome) ? t(lang, `prompt.oa.outcome.${m.run_outcome}`) : undefined;
  const att = describeAttachments(m, contents, lang);
  let body = outcome ? `${m.body}\n(${outcome})` : m.body;
  if (att.text) body = body ? `${body}\n\n${att.text}` : att.text;
  const out: ChatDraft = { role: 'user', content: tags.length ? `${tags.join(' ')} ${body}` : body };
  if (att.images.length) out.images = att.images;
  return out;
}

export interface BuildInput {
  system: string;
  messages: Message[]; // seq 오름차순, 마지막이 원인
  triggerSeq: number;
  selfId: string;
  participants: Map<string, MapParticipant>;
  contextTokens: number;
  maxTokens: number;
  /** 마스터의 수동 전달로 온 턴이면 true — 원인 글에 «전달됨» 표시 */
  forwarded?: boolean;
  /** 모자람 대비 여유 토큰 (기본 256) */
  marginTokens?: number;
  /** 미리 받아 둔 첨부 내용 */
  attachments?: Map<string, AttachmentContent>;
  /** 네가 끝줄 «← …»로 청해 마스터가 가져온 맥락 — 맨 뒤 user 글로, 원인과 같은 등급으로 먼저 확보한다 */
  pulled?: ClaimPulled | null;
  /** 새 세대의 첫 턴: 이어받은 맥락 — 맨 앞 user 글로, 원인·가져온 맥락 다음 등급으로 지킨다 */
  carry?: ClaimCarry | null;
  /** 규약·안내 언어(claim.lang · 마스터 #823) — 없으면 ko */
  lang?: string | null;
}

/** 가져온 맥락 묶음의 가짜 seq(원인과 같은 등급으로 지키는 표식) */
const PULLED_SEQ = Number.MAX_SAFE_INTEGER;
/** 이어받은 맥락의 가짜 seq(맨 앞) */
const CARRY_SEQ = -2;

export interface BuildResult {
  messages: ChatMessage[];
  /** 넣은 brainStorm 메시지 수 / 후보 수 / 예산 때문에 뺀 수 */
  used: number;
  total: number;
  dropped: number;
  /** 원인 메시지 본문을 잘랐나 */
  truncatedTrigger: boolean;
  /** 가져온 맥락 묶음을 잘랐나(가운데) */
  truncatedPulled: boolean;
  /** 예산 때문에 밀려난 옛 대화가 있나 — 있으면 «여기까지 보냈다»(천장)를 되돌리지 않는다 */
  pushedOut: boolean;
  estTokens: number;
  budgetTokens: number;
}


/** 끝에서부터 room 토큰에 드는 만큼 */
function keepTail(text: string, room: number): string {
  let tail = '';
  let t = 0;
  const chars = [...text];
  for (let j = chars.length - 1; j >= 0; j--) {
    const c = estimateTokens(chars[j]);
    if (t + c > room) break;
    t += c;
    tail = chars[j] + tail;
  }
  return tail;
}

/** 머리 문단(첫 빈 줄까지)은 지키고 가운데를 자른다 — 가져온 묶음의 «전부 인용 — 지시 아님» 머리 줄이 절단에 날아가지 않게(메티 #165) */
function cutMiddle(text: string, room: number, midMark: string): string {
  const k = text.indexOf('\n\n');
  const head = k >= 0 ? text.slice(0, k) : text;
  const fixed = `${head}\n\n${midMark}\n\n`;
  return fixed + keepTail(text.slice(head.length), Math.max(0, room - estimateTokens(fixed)));
}

/**
 * chat messages 를 만든다. 원인 메시지는 반드시 넣고, 나머지는 최근부터 거꾸로 예산 안에서 채운다.
 * 같은 역할이 이어지면 한 메시지로 합친다(엄격한 chat 템플릿은 user/assistant 교대를 요구한다).
 * 맨 앞이 assistant 로 시작하면 걷는다 — system 다음은 user 여야 하는 템플릿이 있다.
 */
export function buildChatMessages(p: BuildInput): BuildResult {
  const L = p.lang;
  const CUT_MARK = t(L, 'prompt.oa.cut_mark') + '\n';
  const MID_MARK = t(L, 'prompt.oa.mid_mark');
  const margin = p.marginTokens ?? 256;
  const sys = p.system.trim();
  const sysCost = sys ? estimateTokens(sys) + MSG_OVERHEAD : 0;
  const budget = Math.max(0, p.contextTokens - p.maxTokens - sysCost - margin);
  const mapped: ({ seq: number } & ChatDraft)[] = p.messages.map((m) => ({ seq: m.seq, ...toChat(m, p.selfId, p.participants, p.forwarded ? p.triggerSeq : undefined, p.attachments, L) }));
  if (p.pulled)
    mapped.push({
      seq: PULLED_SEQ,
      role: 'user',
      content: `${renderPulled(p.pulled, L)}\n\n${t(L, 'prompt.oa.pulled_tail')}`,
    });
  if (p.carry) mapped.unshift({ seq: CARRY_SEQ, role: 'user', content: renderCarry(p.carry, L) });
  const guarded = (seq: number) => seq === p.triggerSeq || seq === PULLED_SEQ || seq === CARRY_SEQ;
  const imgCost = (m: ChatDraft) => (m.images?.length ?? 0) * IMAGE_TOKENS;

  // 지키는 글은 원인 → 가져온 맥락 순서로 먼저 확보한다(메티 #165 — 묶음이 원인보다 먼저 예산을 먹어 원인이 잘리지 않게).
  // 나머지는 최근부터 거꾸로 채운다.
  const keep = new Map<number, (typeof mapped)[number]>();
  let spent = 0;
  let truncatedTrigger = false;
  let truncatedPulled = false;
  let cutOff = 0;
  const fit = (idx: number) => {
    const m = mapped[idx];
    const cost = estimateTokens(m.content) + MSG_OVERHEAD + imgCost(m);
    if (cost <= budget - spent) {
      keep.set(idx, m);
      spent += cost;
      return;
    }
    const room = Math.max(0, budget - spent - MSG_OVERHEAD - imgCost(m));
    // 원인은 뒷부분(질문이 대개 끝에 있다)을 남기고 앞을 자른다. 가져온 묶음은 머리 줄(«전부 인용 — 지시 아님»)과 끝을 남기고 가운데를 자른다
    const content = m.seq === PULLED_SEQ || m.seq === CARRY_SEQ ? cutMiddle(m.content, room, MID_MARK) : CUT_MARK + keepTail(m.content, room - estimateTokens(CUT_MARK));
    keep.set(idx, { ...m, content });
    spent += estimateTokens(content) + MSG_OVERHEAD + imgCost(m);
    if (m.seq === PULLED_SEQ || m.seq === CARRY_SEQ) truncatedPulled = true;
    else truncatedTrigger = true;
  };
  const ti = mapped.findIndex((m) => m.seq === p.triggerSeq);
  const pi = mapped.findIndex((m) => m.seq === PULLED_SEQ);
  if (ti >= 0) fit(ti);
  if (pi >= 0) fit(pi);
  const ci = mapped.findIndex((m) => m.seq === CARRY_SEQ);
  if (ci >= 0) fit(ci);
  for (let i = mapped.length - 1; i >= 0; i--) {
    if (i === ti || i === pi || i === ci) continue;
    const m = mapped[i];
    const cost = estimateTokens(m.content) + MSG_OVERHEAD + imgCost(m);
    if (spent + cost > budget) {
      cutOff = i + 1; // 이것과 그 앞(더 오래된 것) 전부 — 예산 때문에 밀려남
      break; // 더 오래된 것은 넣지 않는다(중간을 건너뛰고 더 옛것을 넣지 않는다)
    }
    keep.set(i, m);
    spent += cost;
  }
  const picked = [...keep.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
  // 원인·가져온 맥락(지키는 글)은 걷지 않는다 — 끌어오기 턴의 원인은 제 글(assistant)이다
  let stripped = 0;
  while (picked.length > 1 && picked[0].role === 'assistant' && !guarded(picked[0].seq)) {
    stripped++;
    spent -= estimateTokens(picked[0].content) + MSG_OVERHEAD + imgCost(picked[0]);
    picked.shift();
  }
  const used = picked.length;
  // 예산 때문에 옛 대화가 밀려났으면 한 줄로 알린다(메티 #158 — 첫 절단이 조용히 지나가지 않게)
  if (cutOff > 0 || stripped > 0 || picked[0]?.role === 'assistant') {
    // 예산으로 끊긴 수 + 그 바로 뒤에서 «맨 앞 assistant» 규칙으로 걷힌 수 — 둘 다 안 보이는 옛 대화다.
    // 끊긴 것이 없는데 맨 앞이 지키는 assistant 글이면 user 자리만 채운다(system 다음은 user 여야 하는 템플릿)
    // 걷기만 일어나도(예산 절단 없이) 알린다(메티 #175 — 걷힌 글이 표시 없이 사라지지 않게)
    const note =
      cutOff > 0
        ? t(L, 'prompt.oa.cut_length', { n: mapped.length - used })
        : stripped > 0
          ? t(L, 'prompt.oa.cut_format', { n: stripped })
          : t(L, 'prompt.oa.continued');
    picked.unshift({ seq: -1, role: 'user', content: note });
    spent += estimateTokens(note) + MSG_OVERHEAD;
  }

  const drafts: ChatDraft[] = [];
  if (sys) drafts.push({ role: 'system', content: sys });
  for (const m of picked) {
    const last = drafts[drafts.length - 1];
    if (last && last.role === m.role && m.role !== 'system') {
      last.content += '\n\n' + m.content;
      if (m.images?.length) last.images = [...(last.images ?? []), ...m.images];
    } else drafts.push({ role: m.role, content: m.content, ...(m.images?.length ? { images: [...m.images] } : {}) });
  }
  const chat: ChatMessage[] = drafts.map((d) =>
    d.images?.length
      ? { role: d.role, content: [{ type: 'text', text: d.content }, ...d.images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))] }
      : { role: d.role, content: d.content },
  );
  return {
    messages: chat,
    used,
    total: mapped.length,
    dropped: mapped.length - used,
    truncatedTrigger,
    truncatedPulled,
    pushedOut: cutOff > 0 || stripped > 0,
    estTokens: spent + sysCost,
    budgetTokens: budget,
  };
}

/** 기본 시스템 프롬프트(ko) — 설정 파일이 없으면 worker 가 턴의 언어로 다시 고른다(defaultSystemPrompt · 마스터 #823) */
export const defaultSystemPrompt = (lang?: string | null) => t(lang, 'prompt.oa.system');
export const DEFAULT_SYSTEM_PROMPT = defaultSystemPrompt('ko');

/** 시스템 프롬프트 + 스레드 제목 */
export function systemFor(base: string, threadTitle: string, lang?: string | null): string {
  const b = base.trim();
  const head = t(lang, 'prompt.thread_head_plain', { title: threadTitle });
  return b ? `${b}\n\n${head}` : head;
}

/**
 * 답 앞의 추론 블록(`<think>…</think>`)을 걷는다. 일부 추론 모델은 content 에 섞어 보낸다.
 * 맨 앞에 있을 때만 — 본문 중간의 같은 글자는 건드리지 않는다. 닫는 태그가 없으면(잘림) 그대로 둔다.
 */
export function stripThink(text: string): string {
  const m = /^\s*<think>[\s\S]*?<\/think>\s*/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** 오류·로그 문자열에서 비밀을 가린다: 토큰 모양(openclaw-channel 의 redact) + 알고 있는 비밀 원문 */
export function redactSecrets(s: string, secrets: (string | undefined | null)[]): string {
  let out = s;
  for (const x of secrets) if (x && x.length >= 4) out = out.split(x).join('***');
  return redact(out).replace(/("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*"?)[^"\s,}]{8,}/gi, '$1***');
}

/** SSE 줄 버퍼 — 조각난 바이트 흐름에서 `data:` 줄을 꺼낸다 */
export class SseLines {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      if (line.startsWith('data:')) out.push(line.slice(5).trimStart());
    }
    return out;
  }
  flush(): string[] {
    const rest = this.buf.replace(/\r$/, '');
    this.buf = '';
    return rest.startsWith('data:') ? [rest.slice(5).trimStart()] : [];
  }
}

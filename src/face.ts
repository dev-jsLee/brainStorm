// 대면 모드(2026-10-19 마스터 #579·#581 · 설계 vault Design/brainStorm-대면-모드.md) — 순수 계산만. DB·HTTP 는 store.ts.
//   가운데 합의문 하나를 백구(초안)·비전(검토)이 자기 턴에 직접 고친다. 턴은 서버가 기계적으로 넘긴다(진행자 LLM 없음).
//   합의 = 수정 턴(2턴부터)이 합의문을 한 글자도 안 바꿈. 쟁점 = 상대가 직전 턴에 «고친»(초안 아님) 줄을 다시 고침.
import { stripAnswerStamp } from './protocol.js';

/** 합의문 한 줄의 출처. draft = 1턴 초안에서 온 줄(검토가 고쳐도 쟁점 아님) · issue = 묶인 열린 안건 */
export interface LineOrigin {
  by: string;
  rev: number;
  draft?: boolean;
  issue?: string | null;
  /** 마스터가 안건을 정해 갈아 끼운 줄 */
  decided?: string;
}

/** 안건의 판 하나 — 각 쪽이 그 줄을 어떻게 썼나 */
export interface FaceIssueVersion {
  by: string;
  text: string;
  rev: number;
  /** 자기 옛 문장으로 되돌림(가장 센 이견 신호) */
  revert?: boolean;
  /** 그 판을 낸 턴의 글(«무엇을 왜 고쳤나» 해설) */
  seq?: number | null;
}

export type FaceIssueOp =
  | { op: 'new'; id: string; kind: 'contested' | 'limit'; versions: FaceIssueVersion[] }
  | { op: 'append'; id: string; version: FaceIssueVersion };

/** 문서 정규화: 줄바꿈 LF · 줄 끝 공백 · 앞뒤 빈 줄. 이것만 다르면 «안 바꿈»이다 */
export function normDoc(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

export const docLines = (s: string): string[] => (s === '' ? [] : s.split('\n'));

const QUESTION_RE = /^\s*[*_`]*\s*질문\s*[:：]\s*(.+?)\s*[*_`]*\s*$/;
const BLOCK_RE = /```+[ \t]*합의문[^\n]*\n([\s\S]*?)\n?```+/g;

/**
 * 대면 턴의 답 읽기. 끝줄(도장 뒤) `질문: …` 이 먼저 — 멈추고 마스터에게. 아니면 ```합의문 블록(여럿이면 마지막)이 합의문 전체,
 * 블록 밖이 해설. 블록이 없으면 none(그 턴은 무효 — 멈춤).
 */
export function parseFaceAnswer(body: string):
  | { kind: 'question'; question: string }
  | { kind: 'doc'; doc: string; note: string }
  | { kind: 'none' } {
  const text = stripAnswerStamp(body) || body;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  const q = i >= 0 ? QUESTION_RE.exec(lines[i]) : null;
  if (q && q[1].trim()) return { kind: 'question', question: q[1].trim().slice(0, 2000) };
  let last: RegExpExecArray | null = null;
  for (const m of text.matchAll(BLOCK_RE)) last = m as RegExpExecArray;
  if (!last) return { kind: 'none' };
  const note = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).replace(/\n{3,}/g, '\n\n').trim();
  return { kind: 'doc', doc: normDoc(last[1]), note };
}

/** 바뀐 덩어리: a[aStart,aEnd) 를 지우고 b[bStart,bEnd) 를 넣음 */
export interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/** LCS 줄 diff → 바뀐 덩어리 목록(같은 줄 사이마다 하나) */
export function diffLines(a: string[], b: string[]): Hunk[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const L = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let cur: Hunk | null = null;
  const flush = () => {
    if (cur && (cur.aEnd > cur.aStart || cur.bEnd > cur.bStart)) hunks.push(cur);
    cur = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i >= n || L[i * w + j + 1] >= L[(i + 1) * w + j])) {
      cur ??= { aStart: i, aEnd: i, bStart: j, bEnd: j };
      cur.bEnd = ++j;
    } else {
      cur ??= { aStart: i, aEnd: i, bStart: j, bEnd: j };
      cur.aEnd = ++i;
    }
  }
  flush();
  return hunks;
}

export interface TurnInput {
  /** 지금 합의문(1턴이면 null) */
  prevDoc: string | null;
  prevOrigins: LineOrigin[];
  newDoc: string;
  me: string;
  other: string;
  /** 이번에 생기는 판 번호 */
  rev: number;
  /** 이번 턴 번호(1 = 초안) */
  turn: number;
  /** 상대의 직전 턴이 만든 판(없으면 null) — 그 판에서 상대가 고친 줄을 다시 고치면 쟁점 */
  otherPrevRev: number | null;
  /** 직전 턴 상대 글 seq(안건 판의 해설) */
  otherSeq: number | null;
  mySeq: number | null;
  /** 열린 안건 id */
  openIssues: Set<string>;
  /** 내가 예전 판들에 쓴 줄(되돌림 판정) */
  myPastLines: Set<string>;
  /** 상한 턴: 이 턴에 바뀐 덩어리는 전부 안건으로 */
  limitTurn: boolean;
  newIssueId: () => string;
}

export interface TurnResult {
  origins: LineOrigin[];
  /** 바뀐 줄 수(지운 줄 + 넣은 줄) — 0 이면 «안 바꿈» */
  changed: number;
  issueOps: FaceIssueOp[];
}

/**
 * 한 턴 적용: 줄 출처를 옮기고(같은 줄은 그대로 · 새 줄은 이번 판) 덩어리마다 쟁점을 판정한다.
 *  - 지운 줄에 열린 안건 줄이 있으면 그 안건에 판 하나 더(새 줄도 그 안건에 묶임)
 *  - 아니면 지운 줄 중 «상대가 직전 턴에 고친(초안 아님)» 줄이 있으면 새 쟁점 안건(상대 판 · 내 판 · 되돌림 표시)
 *  - 상한 턴이면 남은 바뀐 덩어리도 안건(kind limit)
 */
export function applyTurn(x: TurnInput): TurnResult {
  const a = x.prevDoc === null ? [] : docLines(x.prevDoc);
  const b = docLines(x.newDoc);
  const fresh = (): LineOrigin => ({ by: x.me, rev: x.rev, ...(x.turn === 1 ? { draft: true } : {}) });
  if (x.prevDoc === null) return { origins: b.map(fresh), changed: b.length, issueOps: [] };
  const hunks = diffLines(a, b);
  const origins: LineOrigin[] = new Array(b.length);
  // 같은 줄은 출처 그대로 — 덩어리 밖을 순서대로 짝짓는다
  {
    let ai = 0;
    let bi = 0;
    for (const h of hunks) {
      while (ai < h.aStart) origins[bi++] = x.prevOrigins[ai++] ?? { by: x.other, rev: 0 };
      ai = h.aEnd;
      bi = h.bEnd;
    }
    while (ai < a.length) origins[bi++] = x.prevOrigins[ai++] ?? { by: x.other, rev: 0 };
  }
  const ops: FaceIssueOp[] = [];
  let changed = 0;
  for (const h of hunks) {
    const del = a.slice(h.aStart, h.aEnd);
    const delO = x.prevOrigins.slice(h.aStart, h.aEnd);
    const add = b.slice(h.bStart, h.bEnd);
    changed += del.length + add.length;
    const nonEmpty = add.filter((l) => l.trim());
    const revert = nonEmpty.length > 0 && nonEmpty.every((l) => x.myPastLines.has(l)) && !nonEmpty.every((l) => del.includes(l));
    const mine: FaceIssueVersion = { by: x.me, text: add.join('\n'), rev: x.rev, seq: x.mySeq, ...(revert ? { revert: true } : {}) };
    let issue: string | null = null;
    const open = delO.find((o) => o?.issue && x.openIssues.has(o.issue));
    if (open) {
      issue = open.issue!;
      ops.push({ op: 'append', id: issue, version: mine });
    } else {
      const contested = x.otherPrevRev !== null && delO.some((o) => o && o.by === x.other && o.rev === x.otherPrevRev && !o.draft);
      if (contested || x.limitTurn) {
        issue = x.newIssueId();
        const theirs: FaceIssueVersion = { by: x.other, text: del.join('\n'), rev: delO.find((o) => o?.by === x.other)?.rev ?? x.otherPrevRev ?? 0, seq: x.otherSeq };
        ops.push({ op: 'new', id: issue, kind: contested ? 'contested' : 'limit', versions: [theirs, mine] });
      }
    }
    for (let k = h.bStart; k < h.bEnd; k++) origins[k] = { ...fresh(), ...(issue ? { issue } : {}) };
  }
  return { origins, changed, issueOps: ops };
}

/**
 * 안건 결정: 그 안건에 묶인 줄을 마스터 글로 갈아 끼운다(묶인 줄이 여럿이면 첫 자리에 넣고 나머지는 지움 · 하나도 없으면 끝에 붙임).
 * 새 줄 출처 = 마스터 · 안건 묶음 없음.
 */
export function replaceIssueLines(doc: string, origins: LineOrigin[], issueId: string, text: string, by: string, rev: number): { doc: string; origins: LineOrigin[] } {
  const lines = docLines(doc);
  const idx = origins.map((o, i) => (o?.issue === issueId ? i : -1)).filter((i) => i >= 0);
  const repl = text === '' ? [] : normDoc(text) === '' ? [] : docLines(normDoc(text));
  const ro: LineOrigin[] = repl.map(() => ({ by, rev, decided: issueId }));
  const at = idx.length ? idx[0] : lines.length;
  const keep = (i: number) => !idx.includes(i);
  const outL: string[] = [];
  const outO: LineOrigin[] = [];
  for (let i = 0; i <= lines.length; i++) {
    if (i === at) {
      outL.push(...repl);
      outO.push(...ro);
    }
    if (i < lines.length && keep(i)) {
      outL.push(lines[i]);
      outO.push(origins[i]);
    }
  }
  return { doc: outL.join('\n'), origins: outO };
}

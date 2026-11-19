// 태그 보기 1단계 — 글에서 태그를 읽어 내는 순수 함수(마스터 #1471~#1481 · docs/태그-보기-사양-2026-11-03.md 2.1).
// 자리로 가른다: 사용자 글의 첫 줄 · 에이전트 답의 끝줄에 있는 «#A #B …»만의 줄이 주 태그, 본문 속 #C 는 인라인.
// 주 태그는 개수 제한이 없다(v0.34.0 · 마스터 #1674) — 순서로 이름이 갈린다: 첫째 메인 · 둘째 서브 · 셋째부터 참조. 차선(마이그레이션 20)은 메인 태그.
// 등록 안 된 이름은 태그로 안 친다(unknown 으로 돌려주고 글자로 남긴다). 코드 블록·URL 속 # 은 안 센다.


/** 태그 이름: 글자·숫자·_·- (한글 포함) · 1~40자. «#1234»처럼 숫자만이면 글 번호라 태그가 아니다 */
const NAME = '[\\p{L}\\p{N}_-]{1,40}';
const TAG_LINE = new RegExp(`^\\s*(?:#${NAME}\\s*)+$`, 'u');
const TAG = new RegExp(`(?<![\\p{L}\\p{N}_/&])#(${NAME})`, 'gu');

export interface ParsedTags {
  /** 주 태그 — 태그 줄(첫 줄 또는 끝줄)에서 순서대로 · 등록된 것만 */
  primary: string[];
  /** 인라인 — 본문 속 · 등록된 것만 · 주 태그와 겹치면 뺀다 */
  inline: string[];
  /** 태그 꼴이지만 등록 안 된 이름(화면에 «등록 안 된 태그» 표시용) */
  unknown: string[];
  /** 태그 줄의 자리 — 없으면 null */
  line: 'head' | 'tail' | null;
}

function namesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TAG)) if (!/^\p{N}+$/u.test(m[1])) out.push(m[1]);
  return out;
}

/** 코드 블록(```…```)과 인라인 코드(`…`)를 비운 본문 — 그 안의 # 은 태그가 아니다 */
function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/**
 * 글에서 태그를 읽는다. `known` 은 등록된 이름(원문 그대로 비교). `where` 는 태그 줄을 찾는 자리 —
 * 사용자 글은 머리(head), 에이전트 답은 꼬리(tail). 태그 줄은 «#A #B»만 있는 줄이어야 한다.
 */
export function parseTags(body: string, known: ReadonlySet<string>, where: 'head' | 'tail'): ParsedTags {
  const lines = stripCode(body).split('\n');
  let line: 'head' | 'tail' | null = null;
  let idx = -1;
  if (where === 'head') {
    idx = lines.findIndex((l) => l.trim() !== '');
  } else {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim() !== '') { idx = i; break; }
  }
  const primaryNames: string[] = [];
  if (idx >= 0 && TAG_LINE.test(lines[idx])) {
    line = where;
    for (const n of namesIn(lines[idx])) if (!primaryNames.includes(n)) primaryNames.push(n);
    lines.splice(idx, 1);
  }
  const unknown: string[] = [];
  const primary: string[] = [];
  for (const n of primaryNames) (known.has(n) ? primary : unknown).push(n);
  const inline: string[] = [];
  for (const n of namesIn(lines.join('\n'))) {
    if (primary.includes(n) || inline.includes(n)) continue;
    if (known.has(n)) inline.push(n);
    else if (!unknown.includes(n)) unknown.push(n);
  }
  return { primary, inline, unknown, line };
}


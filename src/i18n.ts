// 언어(마스터 #821·#823): 화면·서버 안내·에이전트 규약을 한 단어집으로 바꾼다.
//   사전은 저장소 뿌리 `i18n/<언어>.json`(평평한 키 → 문자열 · `{이름}` 자리표시). `ko.json` 이 원본이고 다른 언어는 같은 키를 가진다.
//   빠진 키는 ko 로, ko 에도 없으면 키 자체로 떨어진다(화면이 비지 않게). 새 언어를 더하는 법은 `i18n/README.md`.
//   빌드가 `dist/i18n/` 으로 복사하므로(scripts/copy-i18n.mjs) 어댑터 사본은 `dist` 만 옮겨도 사전이 따라간다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Dict = Record<string, string>;

export const DEFAULT_LANG = 'ko';

/** 이 모듈에서 위로 올라가며 `i18n/ko.json` 이 있는 첫 폴더(dist/i18n → 저장소 뿌리 i18n 순) */
function findDir(): string | null {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let k = 0; k < 6; k++) {
    const c = path.join(d, 'i18n');
    if (fs.existsSync(path.join(c, `${DEFAULT_LANG}.json`))) return c;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

let cache: Map<string, Dict> | null = null;

/** 모든 사전(언어 코드 → 사전). 처음 부를 때 한 번 읽는다 */
export function dictionaries(): Map<string, Dict> {
  if (cache) return cache;
  const out = new Map<string, Dict>();
  const dir = findDir();
  if (dir) {
    for (const f of fs.readdirSync(dir).sort()) {
      const m = /^([a-z]{2,3}(?:-[A-Za-z0-9]+)?)\.json$/.exec(f);
      if (!m) continue;
      out.set(m[1], JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Dict);
    }
  }
  if (!out.has(DEFAULT_LANG)) out.set(DEFAULT_LANG, {});
  cache = out;
  return out;
}

/** 지원 언어 목록: [{code, name}] — name 은 사전의 `_meta.name` */
export function languages(): { code: string; name: string }[] {
  return [...dictionaries()].map(([code, d]) => ({ code, name: d['_meta.name'] || code }));
}

/** 알려진 언어면 그 코드, 아니면 null. `en-US` 처럼 지역이 붙으면 앞만 본다 */
export function normLang(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const all = dictionaries();
  const s = v.trim();
  if (all.has(s)) return s;
  const base = s.split(/[-_]/)[0].toLowerCase();
  return all.has(base) ? base : null;
}

/** Accept-Language 머리에서 처음 맞는 언어 */
export function pickAcceptLanguage(h: string | undefined): string | null {
  if (!h) return null;
  for (const part of h.split(',')) {
    const l = normLang(part.split(';')[0]);
    if (l) return l;
  }
  return null;
}

function fill(s: string, vars?: Record<string, unknown>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (all, k: string) => (vars[k] === undefined || vars[k] === null ? all : String(vars[k])));
}

/** 번역 한 줄. 빠지면 ko → 키 */
export function t(lang: string | null | undefined, key: string, vars?: Record<string, unknown>): string {
  const all = dictionaries();
  const d = all.get(lang || DEFAULT_LANG);
  const s = d?.[key] ?? all.get(DEFAULT_LANG)![key] ?? key;
  return fill(s, vars);
}

/** 키가 그 언어(또는 ko)에 있나 */
export function has(lang: string | null | undefined, key: string): boolean {
  const all = dictionaries();
  return key in (all.get(lang || DEFAULT_LANG) ?? {}) || key in all.get(DEFAULT_LANG)!;
}

/**
 * 끝줄 신호 낱말(요청→ · 보류: · 질문: · ```합의문)은 언어마다 다르다. 파서는 **모든 언어의 낱말을 함께** 받는다 —
 * 언어를 바꾼 뒤에도 옛 규약으로 답한 에이전트의 신호가 떨어지지 않게. 정규식 조각(이스케이프됨 · 대소문자 무시는 부르는 쪽)
 */
export function protocolWords(key: 'proto.request' | 'proto.hold' | 'proto.question' | 'proto.agreement'): string {
  const words = new Set<string>();
  for (const d of dictionaries().values()) if (d[key]) words.add(d[key]);
  if (!words.size) words.add(key);
  return [...words]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'))
    .join('|');
}

/** 화면용 묶음: `window.BS_I18N = {langs, dicts}` — 서버가 /i18n.js 로 낸다 */
export function clientBundle(): string {
  const dicts: Record<string, Dict> = {};
  for (const [k, v] of dictionaries()) dicts[k] = v;
  return `window.BS_I18N=${JSON.stringify({ default: DEFAULT_LANG, langs: languages(), dicts })};\n`;
}

/** 시험용: 사전 캐시를 비운다 */
export function _resetI18nCache() {
  cache = null;
}

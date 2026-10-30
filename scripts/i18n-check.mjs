// 사전 검사(마스터 #823 · i18n/README.md «새 언어 더하기» 5단계). 어긋나면 이유를 찍고 1로 끝난다.
//   1. 모든 언어가 ko 와 같은 키를 가진다(빠진 키 · 남는 키)
//   2. 키마다 {자리표시} 이름이 ko 와 같다
//   3. 단어집(glossary.json)의 모든 항목에 모든 언어 칸이 있다
//   4. 규약 낱말(proto.*)이 언어끼리 겹치지 않는다(한 낱말이 두 신호로 읽히지 않게)
//   5. 코드가 글자 그대로 부르는 키(t('…') · data-i18n)가 ko 에 있다
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const dir = path.join(root, 'i18n');
const langs = fs
  .readdirSync(dir)
  .map((f) => /^([a-z]{2,3}(?:-[A-Za-z0-9]+)?)\.json$/.exec(f)?.[1])
  .filter(Boolean)
  .sort();
const dicts = Object.fromEntries(langs.map((l) => [l, JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), 'utf8'))]));
const ko = dicts.ko;
const problems = [];
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

if (!ko) problems.push('ko.json 이 없다');
for (const l of langs) {
  if (l === 'ko') continue;
  const d = dicts[l];
  for (const k of Object.keys(ko)) {
    if (!(k in d)) problems.push(`${l}: 빠진 키 ${k}`);
    else if (ph(ko[k]) !== ph(d[k])) problems.push(`${l}: 자리표시 다름 ${k} — ko {${ph(ko[k])}} · ${l} {${ph(d[k])}}`);
  }
  for (const k of Object.keys(d)) if (!(k in ko)) problems.push(`${l}: ko 에 없는 키 ${k}`);
  for (const k of ['_meta.name', '_meta.locale']) if (!d[k]) problems.push(`${l}: ${k} 가 비었다`);
}

const glossary = JSON.parse(fs.readFileSync(path.join(dir, 'glossary.json'), 'utf8'));
for (const term of glossary.terms ?? []) for (const l of langs) if (!term[l]) problems.push(`단어집: «${term.id}» 에 ${l} 칸이 없다`);

const seen = new Map();
for (const key of ['proto.request', 'proto.hold', 'proto.question', 'proto.agreement'])
  for (const l of langs) {
    const w = String(dicts[l][key] ?? '').toLowerCase();
    if (!w) {
      problems.push(`${l}: ${key} 가 비었다`);
      continue;
    }
    const prev = seen.get(w);
    if (prev && prev !== key) problems.push(`규약 낱말 겹침: «${w}» 가 ${prev} 와 ${key} 둘에 쓰인다`);
    seen.set(w, key);
  }

const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'fonts'].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|js|html)$/.test(e.name)) files.push(p);
  }
};
for (const d of ['src', 'adapter', 'public']) walk(path.join(root, d));
const used = new Set();
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/\bt[r]?\(\s*(?:[\w.?]+\s*,\s*)?'([a-z_]+\.[\w.]+)'/g)) used.add(m[1]);
  for (const m of s.matchAll(/data-i18n="([\w.]+)"/g)) used.add(m[1]);
  for (const m of s.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const pair of m[1].split(';')) used.add(pair.split(':')[1]?.trim());
}
for (const k of used) if (k && /^[a-z_]+\.[\w.]+$/.test(k) && !(k in ko)) problems.push(`코드가 부르는 키가 ko 에 없다: ${k}`);

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n✗ ${problems.length}건 (언어 ${langs.join(', ')} · ko 키 ${Object.keys(ko ?? {}).length})`);
  process.exit(1);
}
console.log(`✓ 언어 ${langs.join(', ')} · 키 ${Object.keys(ko).length} · 코드가 부르는 키 ${used.size} · 단어집 ${glossary.terms.length}`);

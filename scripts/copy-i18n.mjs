// 빌드 뒤 i18n/*.json 을 dist/i18n/ 으로 복사한다 — 어댑터 사본(dist 만 옮김)도 사전을 갖게(src/i18n.ts 가 위로 올라가며 찾는다)
import fs from 'node:fs';

const src = new URL('../i18n/', import.meta.url);
const out = new URL('../dist/i18n/', import.meta.url);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(src)) if (f.endsWith('.json')) fs.copyFileSync(new URL(f, src), new URL(f, out));

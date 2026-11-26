// 화면 스모크 — core 만(선택 모듈 전부 꺼짐 · docs/MODULES.md). 꺼진 모듈의 단추·탭이 없고, 그 경로를 부르다 터지지 않는지 본다.
// 전부 켠 쪽은 ui-smoke.mjs 가 본다.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import WS from 'ws';
import { setup, MASTER_PASS, newThread, post } from '../dist/test/helpers.js';

const ctx = await setup();
const base = ctx.base;
const errors = [];
const seen404 = [];
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]*><\/script>/, '');
const dom = new JSDOM(html, { url: base + '/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
let cookie = '';
w.fetch = async (u, o = {}) => {
  const headers = { ...(o.headers || {}), Origin: base };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(new URL(u, base), { ...o, headers });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  if (r.status === 404) seen404.push(String(u));
  return r;
};
w.WebSocket = class extends WS {
  constructor(u) {
    super(u, { headers: { Cookie: cookie, Origin: base } });
  }
};
w.alert = (m) => errors.push('alert: ' + m);
w.HTMLFormElement.prototype.requestSubmit = function () {
  this.dispatchEvent(new w.Event('submit', { cancelable: true }));
};
w.Element.prototype.scrollIntoView = () => {};
w.addEventListener('error', (e) => errors.push('error: ' + e.message));
w.localStorage.setItem('bs.lang', 'ko');
w.localStorage.setItem('bs.aux-tab', 'claims'); // 전에 선점 탭을 보던 사람 — 꺼지면 실행 탭으로 돌아가야 한다
const src = (f) => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
w.eval(
  (await (await fetch(new URL('/i18n-dict.js', base))).text()) +
    '\n' + ['i18n.js', 'runs.js', 'admin.js', 'claims.js', 'face.js', 'questions.js', 'app.js'].map(src).join('\n') +
    '\nwindow.__S = S; window.__openThread = openThread; window.__fetchNew = fetchNew;',
);
const $ = (id) => w.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what) => {
  const e = Date.now() + 6000;
  while (!f()) {
    if (Date.now() > e) throw new Error('timeout: ' + what);
    await sleep(40);
  }
};
const ok = (c, what) => {
  if (!c) throw new Error('실패: ' + what);
  console.log('  ✓ ' + what);
};
await until(() => !$('login-view').hidden, '로그인 화면');
$('login-pass').value = MASTER_PASS;
$('login-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
await until(() => !$('app-view').hidden, '앱 화면');

ok(w.__S.modules.size === 0, '/api/me.modules 가 비어 있다');
ok(w.document.querySelector('.menu-item[data-menu="claims"]').hidden, '메뉴에 «선점» 없음');
ok($('tabbtn-claims').hidden, '보조 패널에 선점 탭 없음');
ok(w.__S.tab === 'runs', '저장된 선점 탭은 실행 탭으로 돌아감');

const th = await newThread(ctx, 'core 스레드', null, ['alpha']);
await post(ctx, th, 'core 글');
const seq = (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages.at(-1).seq;
const kid = (await ctx.master('POST', `/api/threads/${th}/fork`, { from_seq: seq, title: 'core 하위' })).json.thread.id;
await w.__openThread(kid);
await until(() => w.__S.detail?.thread?.id === kid, '하위 스레드 열림');
await sleep(100);
ok($('t-face').hidden, '«대면 모드» 단추 없음');
ok($('t-merge').hidden, '«상위로 합치기» 단추 없음');
ok(w.__S.detail.request_holds === undefined, '보류 목록 칸 없음');
ok(seen404.length === 0, `꺼진 모듈 경로를 안 부른다${seen404.length ? ': ' + seen404.join(', ') : ''}`);
// 단계 카드(마스터 #2035) — ```steps 2/3 → 카드 · «완료» → 그 글에 «✓ …» 답장 · 다시 그리면 «완료됨»
await post(ctx, th, 'x\n```steps 2/3\n앱 정보 넣기\n1. **시작** 누름\n2. 이름 넣기\n```');
const sseq = (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages.at(-1).seq;
await w.__openThread(th);
await until(() => $(`m${sseq}`)?.querySelector('.steps-card'), '단계 카드 그려짐');
const card = $(`m${sseq}`).querySelector('.steps-card');
ok(card.querySelector('.steps-head').textContent.includes('2') && card.querySelector('.steps-title').textContent === '앱 정보 넣기', '카드 머리 2/3 · 제목');
ok(card.querySelectorAll('.steps-body ol li').length === 2, '단계 목록 2줄');
card.querySelector('.steps-actions button').click();
for (let k = 0; ; k++) {
  if ((await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages.some((m) => m.reply_to_seq === sseq && m.body.startsWith('✓ '))) break;
  if (k > 100) throw new Error('timeout: «완료» 답장 저장');
  await sleep(60);
}
ok(true, '«완료» 답장 저장');
// 원문 → 답 묶어 보이기(마스터 #2039) — 원문1·원문2 뒤에 원문1의 답이 오면 화면에는 원문1 > 답 > 원문2
const i1 = (await post(ctx, th, '원문1')).message.seq;
const i2 = (await post(ctx, th, '원문2')).message.seq;
const ar = await ctx.agent('alpha', 'POST', `/api/threads/${th}/messages`, { client_key: 'k-ans1-' + Date.now(), body: '원문1의 답', reply_to_seq: i1 });
if (ar.status !== 201) throw new Error('에이전트 답 ' + ar.status + ' ' + JSON.stringify(ar.json));
const a1 = ar.json.message.seq;
await w.__fetchNew?.();
await until(() => $(`m${a1}`), '답 그려짐');
await sleep(50);
const ids = [...$('messages').querySelectorAll(':scope > .msg')].map((n) => n.id);
ok(ids.indexOf(`m${i1}`) + 1 === ids.indexOf(`m${a1}`) && ids.indexOf(`m${a1}`) + 1 === ids.indexOf(`m${i2}`), `화면 순서 원문1 > 답 > 원문2 (${ids.slice(-3).join(' ')})`);
ok(!$('placed-note')?.hidden, '위에 들어간 답 알림');
await until(() => $(`m${sseq}`)?.querySelector('.steps-done'), '«완료됨» 표시');
console.log('errors:', errors);
if (errors.length) throw new Error('화면 오류');
console.log('core 화면 스모크 통과');
w.close();
await ctx.close();
process.exit(0);

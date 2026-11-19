// 화면 스모크 — 질문함(모듈 questions · 2026-11-19). jsdom 으로 public/app.js 를 실제 서버에 붙여
// 에이전트가 올린 질문이 메뉴 열린 수 · 방의 축소 카드 · 질문함 카드(추천안 첫 자리 «(추천)»)로 보이고,
// 나중에 · 빠진 답 안내 · 보내기(지시 글이 그 방에) · 닫힌 목록 · 에이전트가 글로 답함으로 내린 것 · 다시 열기가 도는지 본다.
// 실행: node scripts/ui-smoke-questions.mjs (빌드 뒤)
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import WS from 'ws';
import { setup, MASTER_PASS } from '../dist/test/helpers.js';

const ctx = await setup({ modules: ['questions'] });
const base = ctx.base;
const errors = [];
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
const src = (f) => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
w.eval(
  (await (await fetch(new URL('/i18n-dict.js', base))).text()) +
    '\n' + ['i18n.js', 'runs.js', 'admin.js', 'claims.js', 'face.js', 'questions.js', 'app.js'].map(src).join('\n') +
    '\nwindow.__S = S; window.__route = route;',
);
const $ = (id) => w.document.getElementById(id);
const $$ = (sel) => [...w.document.querySelectorAll(sel)];
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
const go = async (hash) => {
  w.location.hash = hash;
  await w.__route();
};
const menu = () => w.document.querySelector('.menu-item[data-menu="questions"]');
const card = (id) => w.document.querySelector(`#q-list [data-qid="${id}"]`);

await until(() => !$('login-view').hidden, '로그인 화면');
$('login-pass').value = MASTER_PASS;
$('login-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
await until(() => !$('app-view').hidden, '앱 화면');
await until(() => w.__S.wsOpen, 'WS 연결');
ok(!menu().hidden, '모듈이 켜지면 메뉴에 «질문함»');
ok($('q-count').hidden, '열린 질문이 없으면 수 숨김');

const room = (await ctx.master('GET', '/api/threads')).json.threads.find((t) => t.kind === 'room');
const ask = async (items, who = 'alpha') => {
  const r = await ctx.agent(who, 'POST', '/api/questions', { thread_id: room.id, items });
  if (r.status !== 201) throw new Error(`ask ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.question;
};
const q1 = await ask([{ header: '배포', question: '언제 올릴까?', options: [{ label: '지금', description: '시험 통과' }, { label: '내일' }], recommended: 1 }]);
await until(() => !$('q-count').hidden && $('q-count').textContent === '1', 'WS 알림 → 메뉴 열린 수 1');

// 방: 질문 글에 축소 카드
await go(room.id);
await until(() => $(`m${q1.message_seq}`)?.querySelector('.q-mini'), '질문 글에 축소 카드');
const mini = $(`m${q1.message_seq}`).querySelector('.q-mini');
ok(mini.textContent.includes('질문 1문항') && mini.textContent.includes('열림'), '축소 카드 — 문항 수 · 상태');
mini.querySelector('button').click();
await until(() => w.__S.mode === 'questions', '«질문함에서 열기» → 질문함 화면');
await w.__route();
await until(() => card(q1.id), '질문 카드');
const c1 = card(q1.id);
ok(c1.classList.contains('focus'), '짚은 질문 카드 강조');
const labels = [...c1.querySelectorAll('.q-opt .q-lbl')].map((x) => x.textContent);
ok(labels[0] === '내일 (추천)' && labels[1] === '지금', '추천안이 첫 자리 · 끝에 «(추천)»');
ok(c1.querySelector('.q-desc')?.textContent === '시험 통과', '선택지 설명');
ok(c1.querySelector('.q-own .q-text'), '직접 입력 칸');
ok(menu().classList.contains('active'), '메뉴 «질문함» 켜짐');

// 나중에 → 상태·수 · 다시 올리기
[...c1.querySelectorAll('.q-actions button')].find((b) => b.textContent === '나중에').click();
await until(() => card(q1.id)?.classList.contains('st-snoozed'), '나중에 → 카드 «나중에»');
await until(() => $('q-count').hidden, '나중에는 열린 수에서 빠짐');
[...card(q1.id).querySelectorAll('.q-actions button')].find((b) => b.textContent === '다시 올리기').click();
await until(() => card(q1.id)?.classList.contains('st-open'), '다시 올리기 → 열림');

// 빠진 답 → 안내 (다른 에이전트 — 같은 에이전트의 새 질문은 앞 질문을 대체한다)
const q2 = await ask([{ question: '둘 중?', options: ['가', '나'] }, { question: '여럿?', options: ['ㄱ', 'ㄴ', 'ㄷ'], multi: true, allow_text: false }], 'beta');
await until(() => card(q2.id), '새 질문 카드(WS 로 목록 갱신)');
const c2 = card(q2.id);
ok(c2.querySelectorAll('input[type=checkbox]').length === 3 && !c2.querySelectorAll('.q-text')[1], '여럿 고르기 = 체크 · 직접 입력 안 받는 문항은 칸 없음');
ok([...c2.querySelectorAll('.q-actions button')].find((b) => b.textContent === '추천대로').disabled, '추천안 없으면 «추천대로» 꺼짐');
c2.querySelector('input[type=radio]').click();
c2.querySelector('.q-actions button.primary').click();
await until(() => !$('confirm').hidden, '빠진 답 안내');
ok($('confirm-text').textContent.includes('2번 문항'), '몇 번 문항이 빠졌는지');
$('confirm-ok').click();

// 보내기 → 지시 글
const c1b = card(q1.id);
c1b.querySelectorAll('input[type=radio]')[1].click();
c1b.querySelector('.q-note').value = '주말은 피할 것';
c1b.querySelector('.q-actions button.primary').click();
await until(() => card(q1.id)?.classList.contains('st-answered'), '답한 질문 — 짚은 카드는 «답함»으로 남아 결과를 보여 줌');
ok(!card(q1.id).querySelector('.q-actions') && card(q1.id).querySelector('.q-closed'), '닫힌 카드는 답 단추 대신 닫힌 줄');
const ms = (await ctx.master('GET', `/api/threads/${room.id}/messages`)).json.messages;
const ans = ms.find((m) => m.body.startsWith(`[질문 #${q1.message_seq} 답]`));
ok(ans && ans.recipients[0] === 'alpha' && ans.body.includes('2안 «지금»') && ans.body.includes('덧붙임: 주말은 피할 것'), '답 → 그 방에 지시 글(받는 이 = 물은 에이전트)');

// 에이전트가 글로 답함으로 내림 → 닫힌 목록
const p = (await ctx.master('POST', `/api/threads/${room.id}/messages`, { client_key: 'smk-q', body: '가로 하고 ㄴ·ㄷ' })).json.message;
await ctx.agent('beta', 'POST', `/api/questions/${q2.id}/close`, { answer: '가 · ㄴ·ㄷ', by_msg_seq: p.seq });
$('q-tab-closed').click();
await until(() => card(q2.id)?.querySelector('.q-closed') && card(q1.id), '닫힌 목록에 둘');
const c2c = card(q2.id);
ok(c2c.querySelector('.q-closed').textContent.includes(`BETA이(가) #${p.seq} 를 «가 · ㄴ·ㄷ»(으)로 읽고 닫음`), '글로 답함 — 누가 · 근거 글 · 읽은 답');
ok(card(q1.id).textContent.includes('→ 지금'), '답한 질문 — 고른 답');
[...c2c.querySelectorAll('.q-closed button')].find((b) => b.textContent === '다시 열기').click();
await until(() => !card(q2.id), '다시 열기 → 닫힌 목록에서 빠짐');
await until(() => $('q-count').textContent === '1' && !$('q-count').hidden, '다시 열면 열린 수 1');
const ms2 = (await ctx.master('GET', `/api/threads/${room.id}/messages`)).json.messages;
ok(ms2.some((m) => m.body.includes(`[질문 #${q2.message_seq}] 다시 열림`)), '에이전트가 닫은 것을 다시 열면 «다시 열림» 지시 글');

// 방으로 돌아가면 축소 카드 상태가 갱신돼 있다
await go(room.id);
await until(() => $(`m${q1.message_seq}`)?.querySelector('.q-mini.st-answered'), '방의 축소 카드 — 답함');

console.log('errors:', errors);
if (errors.length) throw new Error('화면 오류');
console.log('질문함 화면 스모크 통과');
await ctx.close();
process.exit(0);

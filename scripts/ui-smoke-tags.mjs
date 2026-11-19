// 화면 스모크 — 태그 보기 1단계(마이그레이션 19 · 마스터 #1475·#1481). jsdom 으로 public/app.js 를 실제 서버에 붙여
// 마스터가 «+ 새 태그»로 태그를 만들고 → 사이드바 목록 → #tag/<id> 페이지 → 글쓰기 칸으로 글을 보내 루트에 들어가며
// 태그 칩이 붙는지 · 담당자·대표 에이전트 · 보관하면 읽기 전용(칸 없음·안내)인지 본다. 실행: node scripts/ui-smoke-tags.mjs (빌드 뒤)
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import WS from 'ws';
import { setup, MASTER_PASS } from '../dist/test/helpers.js';

const ctx = await setup();
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
    '\n' + ['i18n.js', 'runs.js', 'admin.js', 'claims.js', 'face.js', 'app.js'].map(src).join('\n') +
    '\nwindow.__S = S; window.__route = route; window.__loadTags = loadTags;',
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
const go = async (hash) => {
  w.location.hash = hash;
  await w.__route();
};
await until(() => !$('login-view').hidden, '로그인 화면');
$('login-pass').value = MASTER_PASS;
$('login-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
await until(() => !$('app-view').hidden, '앱 화면');
await until(() => w.__S.tags !== undefined && !$('tag-new').hidden, '태그 절 · 마스터에게 «+ 새 태그»');
ok($('tag-list').textContent.includes('태그가 아직 없습니다'), '빈 태그 목록 안내');

// 새 태그(대화상자) → 목록 → 페이지로 이동
$('tag-new').click();
await until(() => !$('confirm').hidden, '새 태그 대화상자');
$('confirm-extra').querySelector('input').value = '#인프라';
$('confirm-ok').click();
await until(() => w.__S.tags.length === 1, '태그 1개');
const tg = w.__S.tags[0];
ok(tg.name === '인프라', '앞의 # 는 뗀다');
await until(() => w.__S.mode === 'tag' && w.__S.tagCur === tg.id, '만든 뒤 태그 페이지로');
ok($('tg-h').textContent === '#인프라', '페이지 머리 #인프라');
ok($('tag-list').querySelectorAll('.conv-item').length === 1, '사이드바 태그 1줄');
ok($('tag-list').querySelector('.conv-item').classList.contains('active'), '사이드바 현재 태그 강조');
ok(!$('tg-empty').hidden, '글 없음 안내');
ok(!$('tg-compose').hidden, '글쓰기 칸 있음');
ok($('tg-to').value === '', '대표 없음 → 수신자 비움');

// 대표 에이전트 → 담당자 비운 태그의 수신자가 따른다
$('tag-default-agent').value = 'alpha';
$('tag-default-agent').dispatchEvent(new w.Event('change'));
await until(() => w.__S.defaultAgent === 'alpha', '대표 alpha');
await until(() => $('tg-to').value === 'alpha', '글쓰기 수신 기본 = 대표 alpha');
ok($('tag-list').querySelector('.l2').textContent.includes('(대표)'), '목록에 «(대표)»');
// 담당자 덮어쓰기
$('tg-owner').value = 'beta';
$('tg-owner').dispatchEvent(new w.Event('change'));
await until(() => w.__S.tags[0].owner_id === 'beta', '담당자 beta');
ok(w.__S.tags[0].recipient_id === 'beta', '수신자 = 담당자 beta');

// 글쓰기 → 루트에 들어가고 주 태그가 붙는다 · 페이지와 루트 모두에 칩
ok($('tg-reply').hidden, '글 없는 태그 방 → 답장 줄 없음');
$('tg-body').value = '첫 태그 글 · 본문 속 #인프라 언급은 주 태그와 겹쳐도 한 번만';
$('tg-to').value = '';
$('tg-compose').requestSubmit();
await until(() => $('tg-send-st').textContent.startsWith('보냈음'), '보냄 표시');
await until(() => $('tg-msgs').querySelectorAll('.msg').length === 1, '태그 페이지에 글 1');
ok($('tg-msgs').querySelector('.tag-chip').textContent === '#인프라', '글에 태그 칩 #인프라');
ok($('tg-msgs').querySelectorAll('.tag-chip').length === 1, '주 태그와 인라인이 겹치면 칩 하나');
ok(!$('tg-msgs').querySelector('.actions button') || [...$('tg-msgs').querySelectorAll('.actions button')].every((b) => b.textContent === '복사'), '답장·분기 단추 없음(복사만)');
// 스크롤(마스터 #1594): 다시 읽어도 맨 위로 튀지 않는다 — 바닥 근처면 바닥, 위로 굴려 읽던 중이면 그 자리 · 보내면 바닥
{
  const pg = $('tag-page');
  Object.defineProperty(pg, 'scrollHeight', { configurable: true, get: () => 2000 });
  Object.defineProperty(pg, 'clientHeight', { configurable: true, get: () => 500 });
  pg.scrollTop = 300;
  $('tg-reload').click();
  await sleep(300);
  ok(pg.scrollTop === 300, '위로 굴려 읽던 중 새로 읽으면 자리 그대로');
  pg.scrollTop = 1450;
  $('tg-reload').click();
  await sleep(300);
  ok(pg.scrollTop === 2000, '바닥 근처에서 새로 읽으면 바닥');
  pg.scrollTop = 100;
  $('tg-body').value = '스크롤 시험 글';
  $('tg-compose').requestSubmit();
  await until(() => $('tg-msgs').querySelectorAll('.msg').length === 2, '태그 페이지에 글 2');
  await sleep(200);
  ok(pg.scrollTop === 2000, '글을 보내면 바닥');
  delete pg.scrollHeight;
  delete pg.clientHeight;
}
// 답장 기본(마스터 #1791): 태그 방 글은 방 안 직전 글에 답장 · «답장 안 함»으로 끄면 새 글 · 직전 글이 바뀌면 다시 켜짐
{
  const last = () => [...$('tg-msgs').querySelectorAll('.msg')].at(-1).dataset.tagSeq;
  ok(!$('tg-reply').hidden && $('tg-reply').textContent.includes(`#${last()}`), '답장 줄 = 직전 글');
  $('tg-reply').querySelector('button').click();
  ok($('tg-reply').textContent.includes('답장 없이'), '«답장 안 함» → 새 글 안내');
  $('tg-body').value = '답장 아닌 글';
  $('tg-compose').requestSubmit();
  await until(() => $('tg-msgs').querySelectorAll('.msg').length === 3, '태그 페이지에 글 3');
  ok(!$('tg-reply').textContent.includes('답장 없이') && $('tg-reply').textContent.includes(`#${last()}`), '새 직전 글이 생기면 답장 기본으로 돌아감');
}
const roomId = w.__S.threads.find((t) => t.kind === 'room').id;
const rm = (await ctx.master('GET', `/api/threads/${roomId}/messages`)).json.messages;
ok(rm[0].reply_to_seq == null && rm[1].reply_to_seq === rm[0].seq && rm[2].reply_to_seq == null, '첫 글은 답장 없음 · 둘째는 첫 글에 답장 · «답장 안 함» 글은 답장 없음');
ok(rm.length === 3 && rm[0].tags.primary[0].name === '인프라', '루트 채팅방에 글이 들어가고 주 태그 저장');
await go(roomId);
await until(() => w.__S.cur === roomId && w.__S.messages.length === 3, '루트 열림');
ok(w.document.querySelector('#messages .tag-chip')?.getAttribute('href') === `#tag/${encodeURIComponent(tg.id)}`, '루트 글의 칩이 태그 페이지로 간다');

// # 자동완성(마스터 #1523): 글쓰기 칸에서 # 을 치면 등록된 태그 목록 · Enter 는 보내지 않고 넣는다
{
  const ta = $('body');
  const box = w.document.querySelector('.tag-suggest');
  const typeIn = (v) => {
    ta.value = v;
    ta.setSelectionRange(v.length, v.length);
    ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  };
  const key = (k) => ta.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  typeIn('전력 얘기 #인');
  ok(!box.hidden && box.querySelector('.opt')?.textContent.startsWith('#인프라'), '#인 → 목록에 #인프라');
  const before = w.__S.messages.length;
  key('Enter');
  ok(ta.value === '전력 얘기 #인프라 ' && box.hidden, 'Enter 로 #인프라 넣고 닫힘');
  await sleep(200);
  ok(w.__S.messages.length === before && w.__S.outbox.length === 0, '목록이 열린 동안 Enter 는 안 보냄');
  typeIn('글 #12');
  ok(box.hidden, '#숫자(글 번호)는 안 띄움');
  typeIn('#전력소모량');
  ok(!box.hidden && box.textContent.includes('새 태그 #전력소모량'), '맞는 태그 없음 → 마스터에게 «새 태그» 줄');
  key('Escape');
  ok(box.hidden, 'Esc 로 닫힘');
  ta.value = '';
}

// 보관 → 읽기 전용
await go(`tag/${encodeURIComponent(tg.id)}`);
await until(() => w.__S.mode === 'tag' && !$('tg-admin').hidden, '태그 페이지 다시');
// 태그 방 사이드바(마스터 #1700): 태그 방에서도 사이드바를 남기고 채팅방·태그 절만 — 검색·스레드 절은 CSS(.mode-tag)로 숨김 · 대화로 돌아가면 풂
ok($('app-view').classList.contains('mode-tag') && w.document.body.classList.contains('mode-tag'), '태그 방이면 .mode-tag');
ok($('room-list').querySelectorAll('a, .conv-item').length >= 1 && $('tag-list').querySelectorAll('.conv-item').length >= 1, '사이드바에 메인 채팅방·태그 목록');
ok(!!w.document.querySelector('#sidebar .side-threads #thread-list'), '스레드 절은 .side-threads(태그 방에서 숨김 대상)');
ok($('to-bottom').hidden, '바닥이면 «가장 아래로» 안 뜸');
$('tg-archive').click();
await until(() => !$('confirm').hidden, '보관 확인창');
$('confirm-ok').click();
await until(() => !!w.__S.tags[0].archived_at, '보관됨');
await until(() => !$('tg-readonly').hidden, '«읽기만» 안내');
ok($('tg-compose').hidden, '보관 태그는 글쓰기 칸 없음');
ok($('tg-archive').textContent === '되살리기', '단추가 «되살리기»');
ok($('tg-msgs').querySelectorAll('.msg').length === 3, '보관해도 글은 읽힌다');
ok($('tag-list').querySelectorAll('.conv-item').length === 0 && $('tag-list').textContent.includes('태그가 아직'), '목록에서 빠짐(보관 포함 꺼짐)');
$('tag-show-archived').checked = true;
$('tag-show-archived').dispatchEvent(new w.Event('change'));
ok($('tag-list').querySelector('details summary')?.textContent === '보관 1', '«보관 1» 접힘 절');
// 태그 고르개(마스터 #1529): 수신 대상 위 칩 줄 · 누르면 첫 줄 태그 줄에 넣고 빼고 · 둘까지 · 보관 태그는 안 나옴
{
  for (const name of ['전력', 'NAS', '장애']) await w.fetch('/api/tags', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  await w.__loadTags();
  const ta = $('body');
  const pick = $('tag-pick');
  const chip = (n) => pick.querySelector(`[data-tag="${n}"]`);
  ok(!pick.hidden && !!chip('전력') && pick.nextElementSibling?.id === 'recipients', '수신 대상 위에 태그 칩 줄');
  ok(!chip('인프라'), '보관 태그는 칩에 없음');
  ta.value = '전력 얘기';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  chip('전력').click();
  ok(ta.value === '#전력\n전력 얘기' && chip('전력').classList.contains('on'), '누르면 첫 줄에 #전력 · 칩 켜짐');
  chip('전력').click();
  ok(ta.value === '전력 얘기' && !chip('전력').classList.contains('on'), '다시 누르면 빠짐 · 본문 그대로');
  chip('전력').click();
  chip('NAS').click();
  ok(ta.value === '#전력 #NAS\n전력 얘기', '둘째 태그는 같은 줄에');
  chip('장애').click();
  ok(ta.value === '#전력 #NAS #장애\n전력 얘기' && $('confirm').hidden, '셋째도 같은 줄에 들어감(개수 제한 없음 · 마스터 #1674)');
  chip('NAS').click();
  ok(ta.value === '#전력 #장애\n전력 얘기', '가운데를 빼면 순서는 그대로 당겨짐');
  ta.value = '';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  ok(!pick.querySelector('.chip.on'), '칸을 비우면 칩이 다 꺼짐');
  // 첫 줄은 태그만(마스터 #1531): «#전력 ␣» 뒤에 글자를 치면 # 이 붙는다 · 앞에 태그가 없거나 등록 안 된 #이면 그대로
  const typeCh = (v, ch) => {
    ta.value = v + ch;
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  };
  typeCh('#전력 ', '가');
  ok(ta.value === '#전력 #가', '#전력 ␣ 뒤 글자 → #가 (첫 줄 태그만)');
  chip('NAS').click();
  ok(ta.value.split('\n')[0].startsWith('#전력') , '그 뒤 칩을 눌러도 #전력 은 첫 줄에 남음');
  typeCh('#전력\n본문 ', '가');
  ok(ta.value === '#전력\n본문 가', '둘째 줄부터는 그대로');
  typeCh('그냥 ', '가');
  ok(ta.value === '그냥 가', '앞에 태그가 없으면 그대로');
  typeCh('#1523 ', '참');
  ok(ta.value === '#1523 참', '#숫자(글 번호) 뒤는 그대로');
  typeCh('#1537 #전력 ', '가');
  ok(ta.value === '#1537 #전력 #가', '#글번호 + 태그 줄 뒤 글자 → #가 (마스터 #1539)');
  typeCh('#전력 #1537 ', '가');
  ok(ta.value === '#전력 #1537 #가', '태그 + #글번호 순서도 같음');
  ta.value = '';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  // 답장하면 원글의 주 태그를 첫 줄로 들고 온다(마스터 #1671) · 보관 태그 뺌 · 이미 태그 줄이 있으면 그대로 · 손 안 댄 채 취소하면 걷힘
  const tg = (n) => w.__S.tags.find((x) => x.name === n);
  const reply = (seq, names) => w.eval('setReply')({ seq, author_id: null, tags: { primary: names.map((n) => ({ id: tg(n).id, name: n })), inline: [] } });
  reply(901, ['전력', 'NAS']);
  ok(ta.value === '#전력 #NAS\n' && chip('전력').classList.contains('on') && chip('NAS').classList.contains('on'), '답장 → 원글 주 태그 둘이 첫 줄에');
  reply(902, ['장애']);
  ok(ta.value === '#장애\n', '손 안 댄 채 다른 글에 답장 → 그 글의 태그로 갈아 낌');
  w.eval('clearReply')();
  ok(ta.value === '', '손 안 댄 채 답장 취소 → 넣은 줄도 걷힘');
  reply(907, ['장애', '전력', 'NAS']);
  ok(ta.value === '#장애 #전력 #NAS\n', '셋도 순서 그대로 들고 옴');
  w.eval('clearReply')();
  // 메인·서브·참조 이름표(마스터 #1674): 주 태그 둘 이상일 때만
  const chips = (names) => w.eval('tagChips')({ tags: { primary: names.map((n) => ({ id: tg(n).id, name: n })), inline: [] } });
  const three = chips(['장애', '전력', 'NAS']);
  ok([...three.querySelectorAll('.tag-chip')].map((c) => c.querySelector('.faint')?.textContent).join(',') === '메인,서브,참조' && three.querySelector('.rank-ref'), '셋이면 메인·서브·참조 이름표');
  ok(!chips(['장애']).querySelector('.faint'), '하나면 이름표 없음');
  reply(903, ['인프라', '전력']);
  ok(ta.value === '#전력\n', '보관 태그(#인프라)는 안 들고 옴');
  ta.value = '#전력\n쓰던 글';
  w.eval('clearReply')();
  ok(ta.value === '#전력\n쓰던 글', '쓰기 시작했으면 취소해도 글은 그대로');
  ta.value = '#NAS\n내 글';
  reply(904, ['장애']);
  ok(ta.value === '#NAS\n내 글', '이미 태그 줄이 있으면 사용자 것을 지킴');
  w.eval('clearReply')();
  ta.value = '본문만';
  reply(905, ['장애']);
  ok(ta.value === '#장애\n본문만', '태그 없는 글에는 앞에 태그 줄을 얹음');
  w.eval('clearReply')();
  ok(ta.value === '본문만', '손 안 댄 채 취소 → 얹기 전 글로 되돌림');
  reply(906, []);
  ok(ta.value === '본문만', '태그 없는 원글이면 그대로');
  w.eval('clearReply')();
  ta.value = '';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
}
console.log('errors:', errors);
if (errors.length) throw new Error('화면 오류');
console.log('태그 화면 스모크 통과');
process.exit(0);

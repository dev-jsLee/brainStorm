// UI 스모크: jsdom 으로 public/app.js 를 실제 서버(임시 데이터)에 붙여 돌린다. 브라우저 없이
// 로그인·메인 채팅방·수신 칩·렌더 이스케이프·전송 상태 4종(응답 유실 → 미확인 → 재확인 → 완료)·실행 상태(메시지 행·보조 패널)·
// 메시지 행 실행 취소·재접속/대량 복구 띠·스레드 생성 2단계(범위 프리셋·응답 유실 재시도 → 스레드 하나)·대화 전환 뒤 작성 대상·
// 빈 스레드 안내·새 호출 금지/재개·세션·참여자 탭, 그리고 2단계 실행 화면(목록·필터·상세·취소 결과 변형 —
// 중단 요청됨 → 중단 완료 · 무응답 → 상태 미확인 + 상태 새로 확인 · 완료 우선 확정 · 이미 완료된 실행 · 전달 대기 취소 · 좁은 화면 카드),
// 3단계 관리 화면(에이전트 연결 — 상태·폐기 · 멤버 권한 — 토글·빼기 · 감사 기록 — 필터·펼치기·쪽·대화 범위·비밀 없음 · 좁은 화면 카드),
// 스레드 정리(분기 트리 접기·모두 접기 · 보관·숨김·휴지통 필터 · 영구 삭제 제목 확인),
// 첨부(끌어다 놓기·붙여넣기·빼기·한도 · 먼저 올리고 묶기 · 그림 미리보기 · 첨부만 보내기),
// 선점 레인(위임 대장 · 색 일관 · 대기 쌓임 · 진입 · done 흰색 · 막힘 테두리), 요청 창구(요청 배지 · 보류 경고 · 확인함),
// 대면 모드(세 열 · 합의문 판·턴 · 바뀐 줄 · ⚑ 안건 카드 → 이 판으로 · 결론 카드 승인 · 질문 카드 · 좁은 화면 탭 · 끄기)를 본다.
// 실행: npm run test:ui  (빌드 포함)
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import WS from 'ws';
import { setup, MASTER_PASS } from '../dist/test/helpers.js';

const ACK_MS = 900; // 시험용 무응답 제한(운영 기본 30초)
const ctx = await setup({ cancelAckMs: ACK_MS, faceDrafter: 'alpha', faceReviewer: 'beta' });
const base = ctx.base;
const errors = [];
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]*><\/script>/, '');
const dom = new JSDOM(html, { url: base + '/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
let cookie = '';
// 응답 유실 흉내: 요청은 서버에 닿게 두고, 응답만 버린다
let dropNext = null;
w.fetch = async (u, o = {}) => {
  if (o.body instanceof w.Blob) {
    // jsdom 의 Blob 에는 arrayBuffer() 가 없다 — FileReader 로 바이트를 꺼낸다
    const blob = o.body;
    const buf = await new Promise((res, rej) => {
      const fr = new w.FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error);
      fr.readAsArrayBuffer(blob);
    });
    o = { ...o, body: new Uint8Array(buf) };
  }
  const headers = { ...(o.headers || {}), Origin: base };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(new URL(u, base), { ...o, headers });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  if (dropNext && dropNext(String(u), o)) {
    dropNext = null;
    await r.text();
    throw new w.TypeError('Failed to fetch');
  }
  return r;
};
w.WebSocket = class extends WS {
  constructor(u) {
    super(u, { headers: { Cookie: cookie, Origin: base } });
  }
};
w.alert = (m) => errors.push('alert: ' + m);
w.confirm = (m) => (errors.push('confirm: ' + m), true);
w.prompt = (m) => (errors.push('prompt: ' + m), null);
w.HTMLFormElement.prototype.requestSubmit = function () {
  this.dispatchEvent(new w.Event('submit', { cancelable: true }));
};
w.Element.prototype.scrollIntoView = () => {};
w.addEventListener('error', (e) => errors.push('error: ' + e.message));
// 브라우저는 runs.js → app.js 순서로 같은 전역에서 읽는다. eval 은 const 를 나눠 갖지 않으므로 한 덩어리로
w.eval(
  fs.readFileSync(new URL('../public/runs.js', import.meta.url), 'utf8') +
    '\n' +
    fs.readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8') +
    '\n' +
    fs.readFileSync(new URL('../public/claims.js', import.meta.url), 'utf8') +
    '\n' +
    fs.readFileSync(new URL('../public/face.js', import.meta.url), 'utf8') +
    '\n' +
    fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8') +
    '\nwindow.__S = S; window.__cancelRunAsk = cancelRunAsk; window.__openThread = openThread; window.__applyPrefill = applyPrefill; window.__renderRecipients = renderRecipients; window.__claimColor = claimColor; window.__claimScene = claimScene; window.__renderBody = renderBody;',
);
const $ = (id) => w.document.getElementById(id);
const $$ = (sel) => [...w.document.querySelectorAll(sel)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 조건이 아직 안 그려진 요소를 짚어 던지면 «아직»으로 친다(빠른 기계에서 그리기보다 먼저 묻는 일이 있다)
const until = async (f, ms = 6000, what = '') => {
  const e = Date.now() + ms;
  const t = () => {
    try {
      return f();
    } catch {
      return false;
    }
  };
  while (!t()) {
    if (Date.now() > e) throw new Error('timeout: ' + (what || f));
    await sleep(40);
  }
};
const ok = (cond, what) => {
  if (!cond) throw new Error('검사 실패: ' + what);
  console.log('  ✓', what);
};
const submit = (id) => $(id).dispatchEvent(new w.Event('submit', { cancelable: true }));
const msgs = () => $$('#messages .msg');
const tok = ctx.tokens.alpha.token;
const A = (p, b) =>
  fetch(base + p, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then((r) => r.json());
const M = (method, p, b) =>
  fetch(base + p, { method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const pick = (box, value) => {
  const i = $(box).querySelector(`input[value="${value}"]`);
  i.checked = !i.checked;
  i.dispatchEvent(new w.Event('change'));
};

// ── 로그인 → 메인 채팅방이 기본으로 열림
await until(() => !$('login-view').hidden);
$('login-pass').value = MASTER_PASS;
submit('login-form');
await until(() => !$('app-view').hidden, 6000, 'app view');
await until(() => $('conn').textContent === '연결됨', 6000, 'ws');
await until(() => !$('thread').hidden && $('t-title').textContent === '메인 채팅방', 6000, 'room opens');
ok($('t-kind').textContent === '채팅방', '머리에 «채팅방» 구분');
ok($('c-target').textContent.includes('채팅방') && $('c-target').textContent.includes('메인 채팅방'), '작성란 «현재 대화 대상: 채팅방 메인 채팅방»');
ok($('room-list').textContent.includes('메인 채팅방') && $('room-list').textContent.includes('에이전트 2개'), '목록 «채팅방» 섹션 — 에이전트 2개');
await until(() => !$('empty-thread').hidden, 4000, 'empty notice');
ok($('empty-thread').textContent.includes('아직 메시지가 없습니다'), '빈 대화 안내 «아직 메시지가 없습니다»');
ok($('conn').getAttribute('aria-live') === 'polite', '연결 상태 aria-live');
const roomId = w.__S.cur;

// ── 수신 칩: «전체» = 멤버 에이전트 전부
pick('recipients', '*all');
ok($$('#recipients input[data-agent]:checked').length === 2, '«전체» 칩 → 에이전트 둘 다');
pick('recipients', '*all');
pick('recipients', 'alpha');
ok($$('#recipients input:checked').map((i) => i.value).join() === 'alpha', '에이전트 하나만 고름');

// ── 렌더 이스케이프 + 전송 완료
$('body').value = '<script>alert(1)</script> **굵게** `code`';
submit('composer');
await until(() => msgs().length === 1, 6000, 'first msg');
const bodyHtml = $('messages').querySelector('.msg .body').innerHTML;
ok(!bodyHtml.includes('<script') && bodyHtml.includes('<strong>굵게</strong>'), '렌더 이스케이프 유지');
await until(() => msgs()[0].textContent.includes('전송 완료'), 4000, 'sent mark');
ok($('pending').children.length === 0, '전송 완료 뒤 내보낸 칸 비움');
ok($('empty-thread').hidden, '메시지가 생기면 빈 대화 안내 숨김');

// ── 실행 상태: 메시지 행 «전달 대기» → «응답 생성 중» → 답
await until(() => msgs()[0].querySelector('.runlines').textContent.includes('전달 대기'), 4000, 'delivery waiting');
ok(true, '원인 메시지 아래 «전달 대기»');
const c = (await A('/api/adapter/claim', {})).claim;
// 진짜 어댑터처럼 받았음을 알린다 — 안 알리면 이 전달이 «임대 중»으로 남아 아래 claim 이 옛 실행을 다시 받을 수 있다(10-21 NAS VM 에서 매번 재현)
await A(`/api/adapter/deliveries/${c.delivery.id}/ack`, { lease_token: c.delivery.lease_token });
await A(`/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token });
await until(() => msgs()[0].querySelector('.runlines').textContent.includes('응답 생성 중'), 4000, 'running line');
ok(!$('wait-banner').hidden && $('wait-banner').textContent.includes('응답 대기 중'), '대기 띠 «ALPHA 응답 대기 중 — N초 경과»');
$('aux-btn').click();
$('tabbtn-runs').click();
ok(!$('aux').hidden && $('runs').textContent.includes('실행 중'), '보조 패널 실행 탭');
ok($('runs-all').getAttribute('href').startsWith('#runs?thread='), '실행 탭 «실행 목록 보기» → 이 대화로 거른 실행 목록');
await A(`/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: 'agent reply' });
await until(() => msgs().length === 2 && $('runs').textContent.includes('완료'), 4000, 'reply');
ok(msgs()[0].querySelector('.runlines').textContent === '', '완료된 실행은 메시지 행에 반복 안 함');
ok($('wait-banner').hidden, '대기 띠 사라짐');

// ── 답장 ≠ 전달: 원글 에이전트가 수신 대상에 없으면 작게 경고
const alphaChip = () => w.document.querySelector('#recipients input[value="alpha"]');
const alphaWas = alphaChip().checked;
const setAlpha = (v) => {
  alphaChip().checked = v;
  alphaChip().dispatchEvent(new w.Event('change'));
};
setAlpha(false);
[...msgs()[1].querySelectorAll('button')].find((b) => b.textContent === '답장').click();
ok(alphaChip().checked && !$('reply-info').hidden && !$('reply-info').querySelector('.reply-warn'), '에이전트 글에 답장 → 그 에이전트(ALPHA)가 받는 쪽으로 켜짐(마스터 #271)');
ok(!$('reply-info').textContent.includes('null'), '답장 줄에 «null» 없음(마스터 #325)');
setAlpha(false);
ok($('reply-info').querySelector('.reply-warn')?.textContent.includes('답장만으로는 ALPHA에게 전달되지 않습니다'), '손으로 빼면 «답장만으로는 ALPHA에게 전달되지 않습니다»');
setAlpha(true);
ok(!$('reply-info').querySelector('.reply-warn'), '다시 고르면 경고 사라짐');
setAlpha(false);
$('reply-info').querySelector('button.link').click();
ok($('reply-info').hidden, '답장 취소 → 줄 숨김');
setAlpha(alphaWas);
setAlpha(true); // 아래 «second» 는 알파에게 가야 한다 — 답이 온 뒤 칩이 꺼져 있을 수 있다(10-21 NAS VM 실측: alphaWas=false 면 전송이 안 나가 멈춤)

// ── 메시지 행 [실행 취소] → 확인 상자 → 취소됨 강조
$('body').value = 'second';
submit('composer');
await until(() => msgs().length === 3, 4000, 'second');
const c2 = (await A('/api/adapter/claim', {})).claim;
await A(`/api/adapter/runs/${c2.run.id}/start`, { run_token: c2.run.run_token });
await until(() => !!msgs()[2].querySelector('.runline button'), 4000, 'cancel button on message row');
msgs()[2].querySelector('.runline button').click();
await until(() => !$('confirm').hidden);
ok($('confirm-h').textContent === '에이전트 실행 취소' && $('confirm-text').textContent.includes('완료된 실행은 되돌릴 수 없습니다'), '실행 취소 확인 상자(시안 문구)');
$('confirm-ok').click();
await until(() => msgs()[2].querySelector('.runline.cancel')?.textContent.includes('중단 요청됨'), 4000, 'requested line');
ok(msgs()[2].querySelector('.runline.cancel').textContent.includes('어댑터 중단 확인 대기'), '실행 중 취소 → 메시지 행 «중단 요청됨 — 어댑터 중단 확인 대기 · 남은 N초»');
ok(!msgs()[2].querySelector('.runline button') && !!msgs()[2].querySelector('.runline a.look'), '중단 요청 뒤에는 취소 버튼 대신 «상세»');
await A(`/api/adapter/runs/${c2.run.id}/heartbeat`, { run_token: c2.run.run_token });
await A(`/api/adapter/runs/${c2.run.id}/cancelled`, { run_token: c2.run.run_token });
await until(() => msgs()[2].querySelector('.runline.cancel')?.textContent.includes('취소됨'), 4000, 'cancelled line');
ok(msgs()[2].querySelector('.runline.cancel').textContent.includes('중단 완료'), '어댑터 확인 → 메시지 행 «취소됨 — 중단 완료»');
ok($('runs').textContent.includes('중단 결과: 중단 완료'), '보조 패널에 중단 결과');

// ── 응답 유실 → 미확인 → 다시 확인 → 완료(메시지 하나)
dropNext = (u, o) => o.method === 'POST' && /\/messages$/.test(u);
$('body').value = '응답이 끊긴 글';
submit('composer');
await until(() => $('pending').textContent.includes('전송 결과 미확인'), 4000, 'unknown state');
ok(true, '응답 유실 → «전송 결과 미확인»');
await until(() => msgs().some((m) => m.textContent.includes('응답이 끊긴 글')), 4000, 'stored msg via ws');
ok($('pending').textContent.includes('전송 결과 미확인'), 'WS 로 글이 보여도 미확인 표시는 확인 전까지 남음');
$('pending').querySelector('button.retry').click();
await until(() => $('pending').children.length === 0, 4000, 'retry settles');
ok(msgs().filter((m) => m.textContent.includes('응답이 끊긴 글')).length === 1, '같은 요청 식별자로 재확인 → 메시지 하나');
const lost = (await M('GET', `/api/threads/${roomId}/messages`)).messages.filter((m) => m.body === '응답이 끊긴 글');
ok(lost.length === 1, '서버에도 한 건');
await until(() => msgs().find((m) => m.textContent.includes('응답이 끊긴 글')).textContent.includes('전송 완료'), 3000, 'sent mark after retry');
ok(true, '재확인 뒤 «전송 완료»');

// ── 수신자가 예산보다 많으면 예산을 올린다
pick('recipients', 'alpha');
pick('recipients', 'beta');
$('budget').value = '1';
pick('recipients', 'alpha'); // 둘 → 예산 자동 상향
ok($('budget').value === '2', '«전체/여럿» 고르면 호출 예산을 수신자 수로 올림');
pick('recipients', 'alpha');
pick('recipients', 'beta');

// ── 재접속: 끊긴 동안 글 → 띠 «재접속 중» → «복구 완료»
const before = msgs().length;
w.__S.ws.close();
await until(() => $('banner').dataset.state === 'reconnect' && !$('banner').hidden, 3000, 'reconnect banner');
ok($('banner').textContent.includes('재접속 중'), '상단 띠 «재접속 중»');
await M('POST', `/api/threads/${roomId}/messages`, { client_key: 'x-off', body: 'while offline', recipients: [] });
await until(() => msgs().length === before + 1, 8000, 'recovered');
await until(() => $('banner').dataset.state === 'done', 4000, 'done banner');
ok($('banner').textContent.includes('복구 완료'), '상단 띠 «복구 완료»');

// ── 대량 복구: 끊긴 동안 250건 → «대량 메시지 복구 중» → 순서·중복 검사
// 재접속은 250건을 다 쓴 뒤 «지금 다시 연결»로 — 저절로 붙는 1초 안에 글쓰기가 덜 끝나면 조금씩 따라잡아 대량 복구가 안 뜬다(빠른 기계에서 실측)
w.__S.wsBackoff = 60000;
w.__S.ws.close();
await until(() => $('banner').dataset.state === 'reconnect', 3000);
let sawBulk = false;
const watch = setInterval(() => {
  if ($('banner').dataset.state === 'bulk') sawBulk = true;
}, 5);
for (let i = 0; i < 250; i++) await M('POST', `/api/threads/${roomId}/messages`, { client_key: `bulk-${i}`, body: `bulk ${i}`, recipients: [] });
$('banner').querySelector('button').click();
await until(() => msgs().length === before + 251, 15000, 'bulk recovered');
clearInterval(watch);
ok(sawBulk, '상단 띠 «대량 메시지 복구 중»(진행률)');
const seqs = msgs().map((m) => Number(m.id.slice(1)));
ok(seqs.every((s, i) => i === 0 || seqs[i - 1] < s) && new Set(seqs).size === seqs.length, '복구 뒤 seq 오름차순·중복 없음');
await until(() => $('banner').dataset.state === 'done', 4000);

// ── 스레드 생성 2단계 (작성란 [스레드 생성])
const firstSeq = Number(msgs()[0].id.slice(1));
const secondSeq = Number(msgs()[1].id.slice(1));
$('fork-btn').click();
await until(() => !$('fork-modal').hidden);
ok($('fork-stepno').textContent === '1 / 2' && !$('fork-step1').hidden, '1단계 «1 / 2 · 스레드 생성»');
ok($('fork-next').disabled, '제목 없으면 다음 단계 비활성');
$('fork-title').value = '아키텍처 검토';
$('fork-title').dispatchEvent(new w.Event('input'));
const radio = $('fork-points').querySelector(`input[value="${secondSeq}"]`);
radio.checked = true;
radio.dispatchEvent(new w.Event('change'));
$('fork-next').click();
ok(!$('fork-step2').hidden && $('fork-stepno').textContent === '2 / 2', '2단계로');
ok($('fork-count').textContent.includes('총 2개'), '«총 2개 메시지가 이 스레드에 포함됩니다»');
ok($('fork-summary').textContent.includes('메인 채팅방') && $('fork-summary').textContent.includes(`#${secondSeq}`), '요약: 부모·분기 시점');
const recent = w.document.querySelector('input[name=fork-preset][value=recent]');
$('fork-recent-n').value = '1';
recent.checked = true;
recent.dispatchEvent(new w.Event('change'));
ok($('fork-count').textContent.includes('총 1개'), '범위 «최근 1개» → 즉시 1개');
ok($('fork-include').querySelector(`input[value="${secondSeq}"]`).disabled, '분기 시점 메시지는 항상 포함(해제 불가)');
const cb = $('fork-include').querySelector(`input[value="${firstSeq}"]`);
cb.checked = true;
cb.dispatchEvent(new w.Event('change'));
ok($('fork-count').textContent.includes('총 2개') && w.document.querySelector('input[name=fork-preset][value=pick]').checked, '직접 선택 → 2개, 프리셋 «직접 선택»');
// 응답 유실 → 실패 안내 → 다시 시도 → 스레드는 하나
const nThreads = (await M('GET', '/api/threads')).threads.length;
dropNext = (u, o) => o.method === 'POST' && /\/fork$/.test(u);
$('fork-go').click();
await until(() => !$('fork-error').hidden, 4000, 'fork error');
ok($('fork-error').textContent.includes('스레드 생성 실패') && $('fork-error').textContent.includes('두 번 생기지 않습니다'), '생성 실패 안내 + 다시 시도');
$('fork-retry').click();
await until(() => $('fork-modal').hidden && $('t-title').textContent === '아키텍처 검토', 5000, 'fork opened');
ok((await M('GET', '/api/threads')).threads.length === nThreads + 1, '응답 유실 뒤 재시도해도 스레드 하나');
ok($('t-kind').textContent === '스레드', '새 스레드 열림 — 머리 «스레드»');
ok($('c-target').textContent.includes('메인 채팅방 › 아키텍처 검토'), '작성란 대상 «메인 채팅방 › 아키텍처 검토»');
ok($('t-path').textContent.includes(`#${secondSeq}에서 분기`), '대화 정보에 «메인 채팅 #N에서 분기»');
ok(!!$('t-path').closest('#aux') && !!$('t-summary').closest('#aux') && !$('t-path').closest('.convo-head'), '분기·요약 정보는 머리가 아니라 보조 패널에(마스터 #325)');
await until(() => !$('context-box').hidden);
ok($('context').querySelectorAll('.msg').length === 2, '분기 때 가져온 맥락 2개');
{
  // 마스터 #448: 마지막 맥락은 접힌 채로 보이고, 펼치면 숨는다 · 펼친 목록은 제 안에서 스크롤
  const lastC = [...$('context').querySelectorAll('.msg')].pop();
  ok(!$('context-box').open && !$('context-last').hidden && $('context-last').querySelectorAll('.msg').length === 1, '접힌 맥락 — 마지막 글 미리보기 하나');
  ok($('context-last').textContent.includes(lastC.querySelector('.body').textContent), '미리보기 = 맥락의 마지막 글');
  ok(!$('context-last').querySelector('[id]') || !$('context-last').querySelector(`#${lastC.id}`), '미리보기는 맥락 목록과 id 가 안 겹침');
  $('context-box').open = true;
  $('context-box').dispatchEvent(new w.Event('toggle'));
  ok($('context-last').hidden, '펼치면 미리보기 숨김 — 마지막 글이 두 번 안 보임');
  $('context-box').open = false;
  $('context-box').dispatchEvent(new w.Event('toggle'));
  ok(!$('context-last').hidden, '다시 접으면 미리보기');
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  ok(/#context \{[^}]*max-height:[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain/.test(css), '펼친 맥락 — 높이 상한 · 내부 스크롤 · 스크롤 가둠');
  ok(/\n#context \{ max-height: 33vh;/.test(css), '펼친 맥락 높이 33vh — 모든 폭(마스터 #751)');
  ok(/\n\.context-last \{[^}]*max-height: 4\.2em; overflow: hidden;/.test(css), '미리보기 세 줄로 접힘 — 모든 폭(마스터 #751)');
  $('context-last').click();
  ok($('context-box').open && $('context-last').hidden, '미리보기 누르면 맥락 펼침 · 미리보기 숨김(넓은 화면도)');
  $('context-box').open = false;
  $('context-box').dispatchEvent(new w.Event('toggle'));
}
await until(() => !$('empty-thread').hidden, 4000, 'empty fork notice');
ok($('first-msg-btn').textContent === '첫 메시지 작성', '빈 스레드 안내 + «첫 메시지 작성»');
ok($('thread-list').textContent.includes('아키텍처 검토') && $('thread-list').textContent.includes('열림'), '목록 «스레드» 섹션에 상태 배지');
const forkId = w.__S.cur;

// ── 대화 전환 → 작성 대상이 바뀌고, 스레드 글은 방에 안 나옴
$('body').value = '스레드 안의 글';
submit('composer');
await sleep(150);
ok(msgs().length === 0 && $('body').value === '스레드 안의 글' && $('rcpt-note').classList.contains('rcpt-warn') && $('rcpt-note').textContent.includes('받는 쪽을 고르지 않았습니다'), '에이전트도 «메모»도 안 고르고 보내면 막고 경고(마스터 #271)');
ok(!!$('recipients').querySelector('input[data-memo]') && $('recipients').querySelector('label.chip').textContent === '메모', '«메모» 칩이 «전체» 왼쪽');
pick('recipients', '*memo');
ok($('rcpt-note').textContent.includes('아무도 부르지 않음') && !$('rcpt-note').classList.contains('rcpt-warn'), '«메모» → «아무도 부르지 않음»');
submit('composer');
await until(() => msgs().length === 1 && msgs()[0].textContent.includes('스레드 안의 글'), 4000, 'fork msg');
w.location.hash = roomId;
await until(() => $('t-title').textContent === '메인 채팅방' && w.__S.messages.length > 0, 5000, 'back to room');
ok($('c-target').textContent.includes('메인 채팅방') && !$('c-target').textContent.includes('›'), '전환 뒤 작성 대상 «메인 채팅방»');
ok(!msgs().some((m) => m.textContent.includes('스레드 안의 글')), '스레드 글은 메인 채팅방에 안 보임');
await until(() => $('sr').textContent.includes('메인 채팅방') && $('sr').textContent.includes('작성 대상'), 3000, 'sr announce');
ok(true, '대화 전환을 화면 읽기 도구에 알림');
// 메시지 «여기서 분기» → 그 메시지가 기본 분기 시점
msgs()[0].querySelector('.actions button:last-child').click();
await until(() => !$('fork-modal').hidden);
ok($('fork-points').querySelector(`input[value="${firstSeq}"]`).checked, '«여기서 분기» → 그 메시지가 분기 시점');
$('fork-cancel').click();
ok($('fork-modal').hidden, '취소로 닫힘');

// ── 검색
$('search').value = '아키';
$('search').dispatchEvent(new w.Event('input'));
ok($$('#thread-list .conv-item').length === 1 && $$('#room-list .conv-item').length === 0, '검색: 제목 필터');
$('search').value = '';
$('search').dispatchEvent(new w.Event('input'));

// ── 새 호출 금지 / 재개 (보조 패널 실행 탭)
w.location.hash = forkId;
await until(() => $('t-title').textContent === '아키텍처 검토');
$('btn-stop-new').click();
await until(() => !$('confirm').hidden);
$('confirm-ok').click();
await until(() => !$('btn-resume').hidden && !$('paused-note').hidden, 4000, 'paused');
ok($('t-summary').textContent.includes('새 호출 금지 중'), '대화 정보에 «새 호출 금지 중»');
ok(!$('t-alert').hidden && $('t-alert').textContent.includes('새 호출 금지 중'), '머리 경고줄에도 «새 호출 금지 중»');
$('btn-resume').click();
await until(() => !$('btn-stop-new').hidden, 4000, 'resumed');
ok(true, '새 호출 금지/재개');

// ── 세션 탭 · 참여자 탭
w.location.hash = roomId;
await until(() => $('t-title').textContent === '메인 채팅방');
w.document.querySelector('.menu-item[data-menu="sessions"]').click();
await until(() => $('sessions').textContent.includes('ALPHA'));
ok($('sessions').textContent.includes('1세대') && $('sessions').textContent.includes('설정 버전'), '세션 탭: 세대·설정 버전 칸');
w.document.querySelector('.menu-item[data-menu="people"]').click();
await until(() => $('people').textContent.includes('마지막 접속'), 4000, 'people');
ok($('people').textContent.includes('ALPHA') && $('sync-info').textContent.includes('연결됨'), '참여자 탭: 에이전트 마지막 접속·연결 상태');
ok(w.document.querySelector('.menu-item.active').dataset.menu === 'people', '메뉴 강조가 탭을 따름');
$('aux-close').click();
ok($('aux').hidden && w.document.querySelector('.menu-item.active').dataset.menu === 'convo', '보조 패널 닫기');

// ── 2단계: 실행 화면 ─────────────────────────────────────────
async function startRun(body) {
  await M('POST', `/api/threads/${roomId}/messages`, { client_key: `run-${body}-${Date.now()}`, body, recipients: ['alpha'] });
  // 앞 단계에서 ACK 하지 않은 옛 전달이 다시 나오면(중복 — run_token 없음) ACK 만 하고 넘긴다
  for (let i = 0; i < 10; i++) {
    const cl = (await A('/api/adapter/claim', {})).claim;
    if (!cl) throw new Error('no claim for ' + body);
    await A(`/api/adapter/deliveries/${cl.delivery.id}/ack`, { lease_token: cl.delivery.lease_token });
    if (cl.trigger.body !== body || !cl.run.run_token) continue;
    await A(`/api/adapter/runs/${cl.run.id}/start`, { run_token: cl.run.run_token });
    return cl.run;
  }
  throw new Error('claim loop');
}
const card = () => w.document.querySelector('#rp-result .result-card');

// 목록(n43): 메뉴 «실행 상태» → 대화 영역 대신 실행 목록
w.document.querySelector('.menu-item[data-menu="runs"]').click();
await until(() => !$('runs-page').hidden && !$('rp-list').hidden && $$('#rp-table tbody tr').length > 0, 5000, 'runs list');
ok($('app-view').classList.contains('mode-runs') && w.document.querySelector('.menu-item.active').dataset.menu === 'runs', '메뉴 «실행 상태» → 실행 목록 화면(메뉴 강조)');
ok($$('#rp-table th').map((t) => t.textContent).join('|') === '실행 ID|상태|대상 에이전트|대화|시작 시각|소요 시간|중단 결과|상세', '표 머리: 실행 ID · 상태 · 대상 에이전트 · 대화 · 시작 시각 · 소요 시간 · 중단 결과 · 상세');
ok($('rp-total').textContent.startsWith('총 3건 (전달 대기 1)'), '«총 N건»(실행 2 + 전달 대기 1 — 응답 유실 글의 ALPHA 앞 전달)');
ok($('rp-table').textContent.includes('중단 완료') && $$('#rp-table tr.bad').length === 1, '취소된 실행은 강조 + 중단 결과 «중단 완료»');
ok(/\d{2}:\d{2}:\d{2}/.test(w.document.querySelector('#rp-table tbody tr:not(.waiting) .c-start').textContent), '시작 시각 HH:MM:SS');
$('rf-state').value = 'succeeded';
$('rf-state').dispatchEvent(new w.Event('change'));
await until(() => $$('#rp-table tbody tr').length === 1 && $('rp-table').textContent.includes('완료'), 4000, 'filter');
ok(w.location.hash.includes('state=succeeded'), '상태 필터 → 1건, 주소에 남음');
$('rf-state').value = '';
$('rf-state').dispatchEvent(new w.Event('change'));

// 전달 대기 행 + [전달 취소]
await M('POST', `/api/threads/${roomId}/messages`, { client_key: 'to-beta-wait', body: 'beta 대기', recipients: ['beta'] });
await until(() => $$('#rp-table tr.waiting').length === 2, 4000, 'waiting row');
ok($$('#rp-table tr.waiting').some((tr) => tr.textContent.includes('BETA')), '전달만 있고 실행이 없는 것 → «전달 대기» 행');
for (let i = 0; i < 2; i++) {
  w.document.querySelector('#rp-table tr.waiting button').click();
  await until(() => !$('confirm').hidden);
  $('confirm-ok').click();
  await until(() => $$('#rp-table tr.waiting').length === 1 - i, 4000, 'waiting cancelled');
}
ok(true, '[전달 취소] → 확인 상자 → 행 사라짐');

// 상세(n46) → 실행 취소 요청 → 결과 «중단 요청됨» → 어댑터 확인 → «실행 취소 요청 완료»
const r1 = await startRun('상세 취소');
await until(() => $('rp-table').textContent.includes('실행 중'), 4000, 'running row');
w.document.querySelector(`#rp-table a[href="#run/${r1.id}"]`).click();
await until(() => !$('rp-detail').hidden && $('rp-detail').textContent.includes('취소 처리 상태'), 4000, 'detail');
const dt = $('rp-detail').textContent;
ok(['기본 정보', '실행 입력', '실행 출력', '이벤트 로그', '전달된 맥락 세대', '새 호출 차단'].every((x) => dt.includes(x)), '상세: 기본 정보·입력·출력·취소 처리 단계·이벤트 로그');
ok(dt.includes('해당 없음') && dt.includes('에이전트 간 호출이 꺼져'), '«새 호출 차단 — 해당 없음(에이전트 간 호출 꺼짐)»(시안 «적용됨» 대신 사실)');
ok(!$('rd-cancel').disabled, '실행 중 → [실행 취소 요청] 켜짐');
$('rd-cancel').click();
await until(() => !$('confirm').hidden);
$('confirm-ok').click();
await until(() => !$('rp-result').hidden && card()?.dataset.outcome === 'requested', 4000, 'requested result');
ok(card().textContent.includes('중단 요청됨') && /남은 \d+초/.test(card().textContent), '취소 결과 «중단 요청됨» + 남은 시간');
await A(`/api/adapter/runs/${r1.id}/heartbeat`, { run_token: r1.run_token });
await A(`/api/adapter/runs/${r1.id}/cancelled`, { run_token: r1.run_token });
await until(() => card()?.dataset.outcome === 'acked', 4000, 'acked result');
ok(card().textContent.includes('실행 취소 요청 완료') && card().textContent.includes('에이전트 작업이 안전하게 종료되었습니다'), '어댑터 확인 → «실행 취소 요청 완료»(시안 n50 문구)');
ok(card().textContent.includes('취소 처리 시간') && card().textContent.includes('영향받은 에이전트'), '결과: 취소 처리 시간·영향받은 에이전트');
w.document.querySelector('#rp-result a.btnlike.primary').click();
await until(() => !$('rp-detail').hidden && $('rp-detail').textContent.includes('확인됨'), 4000, 'detail after ack');
ok($('rp-detail').textContent.includes('어댑터 중단 확인') && $('rd-cancel').disabled, '상세: «어댑터 중단 확인 — 확인됨», 취소 버튼 꺼짐');
ok(['취소 요청', '중단 명령 전달', '어댑터 중단 확인', '최종 상태 확정'].every((x) => w.document.querySelector('#rp-detail .evlog').textContent.includes(x)), '이벤트 로그: 요청 → 명령 전달 → 확인 → 확정');

// 무응답 → «실행 상태 미확인 · 자동 재실행되지 않음» + [상태 새로 확인]
const r2 = await startRun('무응답');
w.location.hash = `run/${r2.id}`;
await until(() => !$('rp-detail').hidden && !$('rd-cancel').disabled && $('rp-detail').textContent.includes(r2.id), 4000, 'detail r2');
$('rd-cancel').click();
await until(() => !$('confirm').hidden);
$('confirm-ok').click();
await until(() => card()?.dataset.outcome === 'requested', 4000);
await until(() => card()?.dataset.outcome === 'no_ack', ACK_MS + 5000, 'no_ack result');
ok(card().textContent.includes('실행 상태 미확인') && card().textContent.includes('자동 재실행되지 않았습니다'), '무응답 → «실행 상태 미확인 — 자동 재실행되지 않았습니다»');
ok(card().textContent.includes('마지막 상태 확인') && card().textContent.includes('판정 시각'), '마지막 상태 확인 시각(아직 안 눌렀으면 판정 시각)');
$('rr-refresh').click();
await until(() => !card().textContent.includes('판정 시각'), 4000, 'refreshed');
await until(() => $('sr').textContent !== '', 2000, 'announce'); // announce 는 30ms 뒤에 글을 넣는다
ok(card().dataset.outcome === 'no_ack', '[상태 새로 확인] → 상태 그대로, 마지막 확인 시각 갱신');
const r2d = await M('GET', `/api/runs/${r2.id}`);
ok(r2d.run.state === 'unknown' && r2d.run.last_checked_at > 0, '서버도 unknown 그대로 + last_checked_at');

// 완료 우선 확정: 취소 요청 → (확인 전) 완료
const r3 = await startRun('완료 우선');
await M('POST', `/api/runs/${r3.id}/cancel`, {});
await A(`/api/adapter/runs/${r3.id}/complete`, { run_token: r3.run_token, body: '이미 답했음' });
w.location.hash = `run/${r3.id}/cancel`;
await until(() => card()?.dataset.outcome === 'completed_first', 4000, 'completed_first');
ok(card().textContent.includes('완료 우선 확정') && card().textContent.includes('답 메시지는 대화에 그대로 남습니다'), '취소 결과 «완료 우선 확정»');

// 이미 완료된 실행: 낡은 화면에서 취소를 누른 경우(그 사이 완료됨)
const r4 = await startRun('이미 완료');
await A(`/api/adapter/runs/${r4.id}/complete`, { run_token: r4.run_token, body: '끝' });
w.location.hash = `run/${r4.id}`;
await until(() => !$('rp-detail').hidden && $('rp-detail').textContent.includes(r4.id), 4000);
w.__cancelRunAsk({ id: r4.id, agent_id: 'alpha', trigger_seq: r4.trigger_seq, state: 'running' }, { from: 'detail' });
await until(() => !$('confirm').hidden);
$('confirm-ok').click();
await until(() => card()?.dataset.outcome === 'already_final', 4000, 'already_final');
ok(card().textContent.includes('이미 완료된 실행') && card().textContent.includes('상태를 바꾸지 않았습니다'), '취소 결과 «이미 완료된 실행 — 상태를 바꾸지 않았습니다»');

// 좁은 화면: 목록은 한 줄 요약 카드 + «상태 보기», 메시지 행에는 취소 버튼 없음
const realMM = w.matchMedia;
w.matchMedia = (q) => ({ matches: /max-width: (760|999)px/.test(q), addEventListener() {} });
w.location.hash = 'runs';
await until(() => !$('rp-list').hidden && !!w.document.querySelector('#rp-table .rcards'), 4000, 'narrow cards');
ok($$('#rp-table .rcard').length >= 5 && w.document.querySelector('#rp-table .rcard:not(.waiting) .rc3 a').textContent === '상태 보기', '좁은 화면: 한 줄 요약 카드 + «상태 보기»');
const r5 = await startRun('좁은 화면');
w.document.querySelector('.menu-item[data-menu="convo"]').click();
await until(() => w.__S.mode === 'convo' && !$('thread').hidden && msgs().some((m) => m.textContent.includes('좁은 화면')), 5000, 'back to convo');
const rowMsg = msgs().find((m) => m.textContent.includes('좁은 화면') && m.querySelector('.runline'));
await until(() => rowMsg.querySelector('.runline')?.textContent.includes('응답 생성 중'), 4000);
ok(!rowMsg.querySelector('.runline button') && rowMsg.querySelector('.runline a.look').textContent === '상태 보기', '좁은 화면 메시지 행: 취소 버튼 없이 «상태 보기»(중단은 상세에서만)');
w.matchMedia = realMM;
await M('POST', `/api/runs/${r5.id}/cancel`, {});
await A(`/api/adapter/runs/${r5.id}/cancelled`, { run_token: r5.run_token });
ok(!$('app-view').classList.contains('mode-runs') && $('t-title').textContent === '메인 채팅방', '메뉴 «대화 작업» → 대화 화면으로 돌아옴');

// ── 3단계: 에이전트 연결 · 멤버 권한 · 감사 기록 ─────────────────
const B = (p) => fetch(base + p, { headers: { Authorization: 'Bearer ' + ctx.tokens.beta.token } });
const agCard = (id) => w.document.querySelector(`#ag-list [data-agent="${id}"]`);
// 에이전트 연결(기획서 2.1 → «에이전트 연결 상태»): 메뉴 → 카드
ok((await B('/api/me')).status === 200, 'BETA 토큰 살아 있음(준비)');
w.document.querySelector('.menu-item[data-menu="agents"]').click();
await until(() => !$('agents-page').hidden && !!agCard('alpha') && !!agCard('beta'), 5000, 'agents page');
ok($('app-view').classList.contains('mode-page') && w.document.querySelector('.menu-item.active').dataset.menu === 'agents', '메뉴 «에이전트 연결» → 연결 화면(메뉴 강조)');
ok(agCard('alpha').querySelector('.pill').textContent === '연결됨' && agCard('alpha').textContent.includes('초 전'), 'ALPHA «연결됨 — 마지막 접속 N초 전»');
ok(agCard('alpha').textContent.includes('test') && agCard('alpha').querySelector('.badge.cr-active')?.textContent === '유효', '자격 증명 줄: 라벨·상태 «유효»');
ok($('agents-page').textContent.includes('토큰 발급은 이 화면에 없습니다') && !$$('#agents-page button').some((b) => b.textContent.includes('발급')), '발급 버튼 없음 — CT 안 CLI 안내(마스터 결정 2)');
ok(!$('agents-page').textContent.includes(ctx.tokens.alpha.token) && !$('agents-page').textContent.includes(ctx.tokens.beta.token), '연결 화면에 토큰 값 없음');
// [폐기] → 확인 → 폐기됨
agCard('beta').querySelector('button.danger').click();
await until(() => !$('confirm').hidden);
ok($('confirm-h').textContent === '토큰 폐기' && $('confirm-text').textContent.includes('되돌릴 수 없습니다'), '폐기 확인 상자(되돌릴 수 없음 안내)');
$('confirm-ok').click();
// 폐기된 에이전트 숨기기(기본 켜짐): 유효 토큰이 없어진 BETA 는 목록에서 빠지고 «N개 숨김 · 보기»
await until(() => !agCard('beta') && $('ag-list').textContent.includes('폐기된 에이전트 1개 숨김'), 4000, 'beta hidden');
ok($('ag-hide-revoked').checked && !!agCard('alpha') && $('ag-list').textContent.includes('BETA'), '폐기 → BETA 숨김(기본) · «폐기된 에이전트 1개 숨김(BETA)» · ALPHA 그대로');
w.document.querySelector('#ag-list .ag-hidden-note button').click();
await until(() => !!agCard('beta'), 4000, 'show revoked');
ok(!$('ag-hide-revoked').checked && w.localStorage.getItem('bs.agents.hideRevoked') === '0', '«보기» → 토글 꺼짐 · 이 브라우저에 기억');
$('ag-hide-revoked').checked = true;
$('ag-hide-revoked').dispatchEvent(new w.Event('change'));
ok(!agCard('beta'), '토글 다시 켬 → 다시 숨김');
$('ag-hide-revoked').checked = false;
$('ag-hide-revoked').dispatchEvent(new w.Event('change'));
await until(() => agCard('beta')?.querySelector('.pill')?.textContent === '폐기됨', 4000, 'beta revoked');
ok(agCard('beta').querySelector('.badge.cr-revoked')?.textContent === '폐기됨' && !agCard('beta').querySelector('button.danger'), 'BETA «폐기됨» · 폐기 버튼 사라짐');
ok((await B('/api/me')).status === 401, '폐기한 토큰 → 401');
$('ag-reload').click();
await until(() => agCard('beta')?.textContent.includes('폐기된 토큰으로 접속 시도'), 4000, 'last denied');
ok(true, '«서버가 거절한 마지막 연결: 폐기된 토큰으로 접속 시도 · 방금»');

// 멤버 권한: 메뉴 → 현재 대화(메인 채팅방) → BETA 게시 끔 → 빼기
w.document.querySelector('.menu-item[data-menu="members"]').click();
await until(() => !$('members-page').hidden && !!w.document.querySelector('#mb-table tr.mb-row[data-pid="beta"]'), 5000, 'members page');
ok($('mb-thread').value === roomId && w.location.hash.includes('members'), '멤버 권한 — 지금 대화(메인 채팅방)로 열림');
ok($$('#mb-table th').map((t) => t.textContent).join('|') === '참여자|멤버|읽기|게시|호출', '표 머리: 참여자 · 멤버 · 읽기 · 게시 · 호출');
ok(w.document.querySelector('#mb-table tr.master').querySelectorAll('input:disabled').length === 3, '마스터 줄은 고정(항상 멤버)');
const mbBox = (pid, k) => w.document.querySelector(`#mb-table tr[data-pid="${pid}"] input[data-k="${k}"]`);
mbBox('beta', 'post').checked = false;
mbBox('beta', 'post').dispatchEvent(new w.Event('change'));
await until(() => $('mb-status').textContent.includes('게시 끔'), 4000, 'post off');
ok($('mb-status').textContent.includes('감사 기록에 남았습니다'), 'BETA 게시 끔 → 바로 적용 + «감사 기록에 남았습니다»');
const roomD = await M('GET', `/api/threads/${roomId}`);
ok(roomD.members.find((m) => m.participant_id === 'beta').can_post === false, '서버에도 게시 끔');
mbBox('beta', 'member').checked = false;
mbBox('beta', 'member').dispatchEvent(new w.Event('change'));
await until(() => !$('confirm').hidden);
ok($('confirm-h').textContent === '멤버에서 빼기', '빼기는 확인 상자');
$('confirm-ok').click();
await until(() => w.document.querySelector('#mb-table tr[data-pid="beta"]')?.classList.contains('dim'), 4000, 'beta removed');
ok(mbBox('beta', 'read').disabled && mbBox('beta', 'post').disabled, '멤버 아니면 읽기·게시 칸 꺼짐');
ok(!(await M('GET', `/api/threads/${roomId}`)).members.some((m) => m.participant_id === 'beta'), '서버에서도 방 멤버 아님');
w.location.hash = 'agents';
await until(() => !$('agents-page').hidden && agCard('beta')?.textContent.includes('멤버 아님'), 5000, 'beta not room member');
ok(true, '연결 화면 BETA «메인 채팅방: 멤버 아님(방에서 빠짐)» — 운영의 oc-main 꼴');

// 감사 기록(n76)
for (let i = 0; i < 30; i++) await M('POST', `/api/threads/${roomId}/members`, { participant_id: 'alpha', can_read: true, can_post: i % 2 === 0 });
w.document.querySelector('.menu-item[data-menu="audit"]').click();
await until(() => !$('audit-page').hidden && $$('#au-table tbody tr').length > 0, 5000, 'audit page');
ok(w.document.querySelector('.menu-item.active').dataset.menu === 'audit', '메뉴 «감사 기록» → 감사 화면');
ok($$('#au-table th').map((t) => t.textContent).join('|') === '타임스탬프|이벤트 유형|수행자|대상·범위|결과|상세', '표 머리: 타임스탬프 · 이벤트 유형 · 수행자 · 대상·범위 · 결과 · 상세');
ok(/^총 \d+건$/.test($('au-total').textContent) && $('af-since').value === 'today', '«총 N건» · 기간 기본 «오늘»');
ok($('au-table').textContent.includes('감사 기록 조회'), '감사 조회 자체가 목록에 있음');
ok($('au-pages').textContent.includes('다음') && !!$('au-pages').querySelector('button.cur'), '쪽 나누기(이전 1 2 … 다음)');
$$('#au-pages button').find((b) => b.textContent === '다음').click();
await until(() => $('au-pages').querySelector('button.cur')?.textContent === '2', 4000, 'page 2');
ok(w.location.hash.includes('page=2'), '2쪽 — 주소에 남음');
// 결과 «거부»
$('af-result').value = 'denied';
$('af-result').dispatchEvent(new w.Event('change'));
await until(() => w.__S.auData?.entries.length > 0 && w.__S.auData.entries.every((e) => e.result === 'denied') && $$('#au-table tbody tr').length > 0, 4000, 'denied filter');
ok($('au-table').textContent.includes('토큰 인증') && $('au-table').textContent.includes('폐기된 토큰'), '결과 «거부»: 토큰 인증 — 폐기된 토큰(수행자 BETA)');
ok($$('#au-table tbody tr.au-row-denied').length === $$('#au-table tbody tr').length && w.__S.au.page === 1, '거부 줄 강조 · 필터 바꾸면 1쪽부터');
const denyRow = $$('#au-table tbody tr').find((tr) => tr.textContent.includes('토큰 인증'));
denyRow.querySelector('button.au-more').click();
await until(() => !!w.document.querySelector('#au-table tr.au-open'), 3000, 'detail open');
const det = w.document.querySelector('#au-table tr.au-open').textContent;
ok(['감사 식별자', '요청 시각', '처리 시각', '이전 상태', '결과 상태', '연결된 기록 보기'].every((x) => det.includes(x)), '상세 펼치기: 감사 식별자·요청/처리 시각·이전/결과 상태');
// 이벤트 유형 «멤버 권한 부여·회수»
$('af-result').value = '';
$('af-action').value = 'member.*';
$('af-action').dispatchEvent(new w.Event('change'));
await until(() => w.__S.auData?.entries.length > 0 && w.__S.auData.entries.every((e) => e.action.startsWith('member.')) && $('au-table').textContent.includes('멤버 회수'), 4000, 'member filter');
ok($('au-table').textContent.includes('멤버 권한 부여·변경'), '이벤트 유형 «멤버 권한 부여·회수» → 부여·회수 줄');
const rmRow = $$('#au-table tbody tr').find((tr) => tr.textContent.includes('멤버 회수'));
rmRow.querySelector('button.au-more').click();
await until(() => w.document.querySelector('#au-table tr.au-open')?.textContent.includes('멤버 예'), 3000, 'remove detail');
ok(w.document.querySelector('#au-table tr.au-open').textContent.includes('멤버 아니오'), '회수 상세: 이전 상태 «멤버 예 · 읽기 예 · 게시 아니오» → 결과 «멤버 아니오»');
// 검색
$('af-action').value = '';
$('af-q').value = 'cli:root';
$('af-q').dispatchEvent(new w.Event('input'));
await until(() => w.__S.au.q === 'cli:root' && w.__S.au.action === '' && w.__S.auData?.entries.length > 0 && w.__S.auData.entries.every((e) => e.actor_id === 'cli:root'), 4000, 'search');
ok($('au-table').textContent.includes('관리 CLI (root)') && $('au-table').textContent.includes('토큰 발급'), '검색 «cli:root» → 관리 CLI 의 토큰 발급(시험 준비)');
// 비밀 없음
const auText = $('audit-page').textContent + JSON.stringify(w.__S.auData);
ok(![ctx.tokens.alpha.token, ctx.tokens.beta.token, MASTER_PASS, '응답이 끊긴 글', 'agent reply'].some((x) => auText.includes(x)), '감사 화면에 토큰·패스프레이즈·본문 없음');
// 대화 머리 «감사 기록» 링크 → 대화 범위 칩
$('af-q').value = '';
w.location.hash = roomId;
await until(() => w.__S.mode === 'convo' && $('t-title').textContent === '메인 채팅방', 5000, 'room again');
ok($('t-audit').getAttribute('href').startsWith(`#audit?thread=${roomId}`), '대화 머리 «감사 기록» 링크(시안 n14)');
w.location.hash = $('t-audit').getAttribute('href');
await until(() => w.__S.mode === 'audit' && $('af-chips').textContent.includes('대화: 메인 채팅방') && w.__S.au.q === '', 5000, 'thread scope');
await until(() => w.__S.auData?.entries.length > 0 && w.__S.auData.entries.every((e) => e.thread_id === roomId), 4000, 'scoped entries');
ok(true, '대화 범위로 거른 감사 기록 + «대화: 메인 채팅방» 칩');
// 좁은 화면: 카드
w.matchMedia = (q) => ({ matches: /max-width: (760|999)px/.test(q), addEventListener() {} });
w.location.hash = 'audit?since=';
await until(() => w.__S.mode === 'audit' && !!w.document.querySelector('#au-table .rcards .rcard'), 5000, 'narrow audit');
ok(!w.document.querySelector('#au-table table'), '좁은 화면 감사 기록: 카드');
w.location.hash = `members?thread=${roomId}`;
await until(() => w.__S.mode === 'members' && !!w.document.querySelector('#mb-table .rcards .mb-toggles'), 5000, 'narrow members');
ok(w.document.querySelectorAll('#mb-table .mb-toggles').length === 2, '좁은 화면 멤버 권한: 에이전트마다 토글 카드');
w.matchMedia = realMM;
w.location.hash = roomId;
await until(() => w.__S.mode === 'convo' && !$('app-view').classList.contains('mode-page'), 5000, 'back');
ok(true, '대화 화면으로 돌아옴');

// ── 수신 대상 기본값: 참여자가 마스터와 에이전트 하나뿐이면 그 에이전트를 기본 체크
const chipsOn = () => $$('#recipients input[data-agent]:checked').map((i) => i.value).join();
const solo = (await M('POST', '/api/threads', { title: '혼자 에이전트', members: ['alpha'] })).thread.id;
w.location.hash = solo;
await until(() => $('t-title').textContent === '혼자 에이전트' && !!w.document.querySelector('#recipients input[value="alpha"]'), 5000, 'open solo');
ok(chipsOn() === 'alpha' && w.document.querySelector('#recipients input[data-all]').checked, '마스터 + 에이전트 하나 → 그 에이전트 기본 체크(«전체»도 켜짐)');
const duo = (await M('POST', '/api/threads', { title: '둘 에이전트', members: ['alpha', 'beta'] })).thread.id;
w.location.hash = duo;
await until(() => $('t-title').textContent === '둘 에이전트' && !!w.document.querySelector('#recipients input[value="beta"]'), 5000, 'open duo');
ok(chipsOn() === '', '에이전트 둘이면 기본 체크 없음(그대로)');
w.location.hash = roomId;
await until(() => w.__S.cur === roomId && w.__S.detail?.thread.id === roomId, 5000, 'back to room'); // 머리까지 다 그린 뒤(S.cur 만 보면 머리가 아직 앞 스레드일 수 있다 — 10-21 실측)

// ── 스레드 정리(2026-10-11): 분기 트리 접기 · 보관 · 숨김 · 휴지통 · 영구 삭제
ok($('t-menu').hidden, '메인 채팅방에는 «정리» 메뉴 없음');
const P = (await M('POST', '/api/threads', { title: '정리 부모' })).thread.id;
const pm = (await M('POST', `/api/threads/${P}/messages`, { client_key: 'cl-p', body: '부모 글' })).message.seq;
const C = (await M('POST', `/api/threads/${P}/fork`, { from_seq: pm, title: '정리 자식', client_key: 'cl-c' })).thread.id;
const cm = (await M('POST', `/api/threads/${C}/messages`, { client_key: 'cl-c1', body: '자식 글' })).message.seq;
await M('POST', `/api/threads/${C}/fork`, { from_seq: cm, title: '정리 손자', client_key: 'cl-g' });
w.location.hash = P;
await until(() => $('t-title').textContent === '정리 부모', 5000, 'open P');
await until(() => $('thread-list').textContent.includes('정리 손자'), 5000, 'tree has grandchild');
const rowOf = (title) => $$('#thread-list .conv-row').find((r) => r.querySelector('.ttl')?.textContent === title);
ok(rowOf('정리 자식').classList.contains('depth1') && rowOf('정리 손자').classList.contains('depth2'), '분기 트리 깊이(자식 1 · 손자 2)');
rowOf('정리 부모').querySelector('.twisty').click();
ok(!$('thread-list').textContent.includes('정리 자식') && rowOf('정리 부모').textContent.includes('+2'), '부모 접기 → 자식·손자 숨고 «+2»');
ok(JSON.parse(w.localStorage.getItem('bs.collapsed')).includes(P), '접힘 상태는 브라우저에 저장');
ok(rowOf('정리 부모').querySelector('.twisty').getAttribute('aria-expanded') === 'false', '접기 버튼 aria-expanded=false');
rowOf('정리 부모').querySelector('.twisty').click();
ok($('thread-list').textContent.includes('정리 손자'), '다시 펼침');
$('tree-toggle-all').click();
ok(!$('thread-list').textContent.includes('정리 자식') && $('tree-toggle-all').textContent === '모두 펼치기', '«모두 접기»');
$('tree-toggle-all').click();
ok($('thread-list').textContent.includes('정리 손자'), '«모두 펼치기»');

// 보관: 확인 → 읽기 전용 · 진행 중 필터에서 빠짐 · «보관 포함»에서 배지
ok(!$('t-menu').hidden && !$('st-archive').hidden && $('st-unarchive').hidden && $('st-restore').hidden, '정리 메뉴: 열린 스레드는 보관·숨김·휴지통');
$('st-archive').click();
await until(() => !$('confirm').hidden);
ok($('confirm-text').textContent.includes('아래 분기 2개'), '확인창에 묶음 개수(아래 분기 2개)');
$('confirm-ok').click();
await until(() => w.__S.detail?.thread.status === 'archived', 5000, 'archived');
await until(() => !$('t-state-note').hidden);
ok($('t-state-note').textContent.includes('보관된 대화') && $('send-btn').disabled, '보관 → 안내 + 전송 막힘');
ok(!$('thread-list').textContent.includes('정리 부모'), '«진행 중» 필터에서 빠짐');
$('thread-filter').value = 'all';
$('thread-filter').dispatchEvent(new w.Event('change'));
ok(rowOf('정리 손자')?.querySelector('.pill').textContent === '보관', '«보관 포함»에서 자식까지 보관 배지');
$('st-unarchive').click();
await until(() => w.__S.detail?.thread.status === 'open' && $('t-state-note').hidden, 5000, 'unarchived');
ok(!$('send-btn').disabled, '보관 해제 → 다시 쓸 수 있음');

// 숨김
$('st-hide').click();
await until(() => !$('confirm').hidden);
$('confirm-ok').click();
await until(() => w.__S.detail?.thread.hidden === true, 5000, 'hidden');
ok(!$('thread-list').textContent.includes('정리 부모') && $('t-state-note').textContent.includes('숨긴 대화'), '숨김 → 목록에서 빠지고 안내');
$('thread-filter').value = 'hidden';
$('thread-filter').dispatchEvent(new w.Event('change'));
ok(rowOf('정리 부모')?.querySelector('.pill').textContent === '숨김', '«숨김» 필터에서 보임');
$('st-unhide').click();
await until(() => w.__S.detail?.thread.hidden === false, 5000, 'unhidden');

// 이름 바꾸기: 확인 버튼 · Enter · 같은 이름이면 아무 일 없음
$('thread-filter').value = 'all';
$('thread-filter').dispatchEvent(new w.Event('change'));
ok(!$('st-rename').hidden, '정리 메뉴에 «이름 바꾸기…»');
$('st-rename').click();
await until(() => !$('confirm').hidden && !!$('rename-input'));
ok($('rename-input').value === '정리 부모' && w.document.activeElement === $('rename-input'), '이름 칸에 지금 이름 · 초점');
$('rename-input').value = '  정리 부모(새)  ';
$('confirm-ok').click();
await until(() => w.__S.detail?.thread.title === '정리 부모(새)', 5000, 'renamed');
await until(() => $('t-title').textContent === '정리 부모(새)' && !!rowOf('정리 부모(새)'));
ok(true, '이름 바꾸기 → 제목·목록 갱신(앞뒤 공백 정리)');
$('st-rename').click();
await until(() => !$('confirm').hidden && !!$('rename-input'));
$('rename-input').value = '정리 부모';
$('rename-input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await until(() => w.__S.detail?.thread.title === '정리 부모', 5000, 'renamed back');
ok($('confirm').hidden, 'Enter 로 바꾸기');

// 휴지통 → 영구 삭제(제목 확인)
$('st-trash').click();
await until(() => !$('confirm').hidden);
ok($('confirm-ok').className.includes('danger-fill'), '휴지통 확인 버튼은 위험 색');
$('confirm-ok').click();
await until(() => !!w.__S.detail?.thread.deleted_at, 5000, 'trashed');
ok($('send-btn').disabled && !$('st-restore').hidden && !$('st-purge').hidden && $('st-archive').hidden, '휴지통: 전송 막힘 · 복구·영구 삭제만');
$('thread-filter').value = 'trash';
$('thread-filter').dispatchEvent(new w.Event('change'));
ok(rowOf('정리 손자')?.querySelector('.pill').textContent === '휴지통', '«휴지통» 필터에 자식까지');
$('st-purge').click();
await until(() => !$('confirm').hidden && !!$('purge-confirm'));
$('purge-confirm').value = '틀림';
$('confirm-ok').click();
await until(() => !$('confirm').hidden && $('confirm-h').textContent === '실패', 4000, 'mismatch');
ok($('confirm-text').textContent.includes('제목이 맞지 않습니다'), '제목이 틀리면 지우지 않음');
$('confirm-ok').click();
$('st-purge').click();
await until(() => !$('confirm').hidden && !!$('purge-confirm'));
$('purge-confirm').value = '정리 부모';
$('confirm-ok').click();
await until(() => $('t-title').textContent === '메인 채팅방' && !w.__S.threads.some((t) => t.id === P), 5000, 'purged');
ok(!$('thread-list').textContent.includes('정리'), '영구 삭제 → 목록에서 사라지고 메인 채팅방으로');
$('thread-filter').value = 'open';
$('thread-filter').dispatchEvent(new w.Event('change'));

// ── 수동 전달(2026-10-12 마스터 #62·#70) · 수신 대상 단축키
const FT = (await M('POST', '/api/threads', { title: '전달 시험', members: ['alpha', 'beta'] })).thread.id;
await w.__openThread(FT);
await until(() => $('t-title').textContent === '전달 시험' && $$('#recipients input[data-agent]').length === 2, 5000, 'fwd thread');
const chips = () => $$('#recipients input[data-agent]');
const key = (d) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: d, code: `Digit${d}`, altKey: true, bubbles: true, cancelable: true }));
const c0 = chips().map((i) => i.checked);
key('1');
ok(chips()[0].checked === !c0[0] && chips()[1].checked === c0[1], 'Alt+1 → 첫 수신 칩만 켜고 끄기');
key('2');
ok(chips()[1].checked === !c0[1], 'Alt+2 → 둘째 수신 칩');
ok(w.document.activeElement !== $('messages'), 'Alt+2 는 더는 메시지 칸으로 이동하지 않음');
for (const i of chips()) if (i.checked) key(String(chips().indexOf(i) + 1));
key('0');
ok(chips().every((i) => i.checked), 'Alt+0 → 전체');
key('0');
ok(chips().every((i) => !i.checked), 'Alt+0 다시 → 전체 해제');
key('9');
ok(chips().every((i) => !i.checked) && errors.length === 0, '없는 칩 번호(Alt+9)는 아무 일 없음');
ok(!!w.document.querySelector('#recipients label.chip[title="단축키 Alt+1"]') && $('thread').textContent.length > 0, '칩에 «단축키 Alt+1» 표시');
ok(w.document.body.innerHTML.includes('Alt+1~9 수신 대상'), '단축키 안내 문구 바뀜');
await M('POST', `/api/threads/${FT}/messages`, { client_key: 'fwd-q', body: '알파에게', recipients: ['alpha'] });
const fc = (await A('/api/adapter/claim', {})).claim;
await A(`/api/adapter/runs/${fc.run.id}/start`, { run_token: fc.run.run_token });
await A(`/api/adapter/runs/${fc.run.id}/complete`, { run_token: fc.run.run_token, body: '알파 답\n→ BETA' });
const fwdBtn = () => msgs()[1]?.querySelector('.fwdbar button.fwd.primary-soft');
await until(() => msgs().length === 2 && !!fwdBtn(), 5000, 'fwd button');
ok(fwdBtn().textContent === 'BETA에게 전달', '끝줄 «→ BETA» → 글 아래 «BETA에게 전달» 버튼');
ok(!msgs()[1].querySelector('.body').textContent.includes('→ BETA'), '신호 줄은 본문에서 사라짐');
ok(!msgs()[0].querySelector('.fwdbar'), '마스터 글에는 전달 버튼 없음');
fwdBtn().click();
await until(() => !$('confirm').hidden && !!$('fwd-note'), 3000, 'fwd dialog');
ok($('fwd-note').tagName === 'TEXTAREA' && $('fwd-note').value === '' && w.document.activeElement === $('fwd-note'), '전달 누름 → 확인 창 + 여러 줄 메모 칸(선택 · 비어 있음 · 초점)(마스터 #740)');
$('confirm-no').click();
await new Promise((r) => setTimeout(r, 300));
ok(!!fwdBtn() && !w.__S.deliveries.some((x) => x.message_seq === Number(msgs()[1].id.slice(1))), '확인 창 «취소» → 전달 안 됨');
fwdBtn().click();
await until(() => !$('confirm').hidden && !!$('fwd-note'), 3000, 'fwd dialog 2');
$('fwd-note').value = '  이 부분만 봐 줘\n둘째 줄 ';
$('confirm-ok').click();
await until(() => msgs()[1].querySelector('.runlines').textContent.includes('전달 대기'), 5000, 'fwd waiting');
ok(msgs()[1].querySelector('.fwd-note-line')?.textContent === ' · 메모: 이 부분만 봐 줘 둘째 줄' && w.__S.deliveries.some((x) => x.forward_note === '이 부분만 봐 줘\n둘째 줄'), '메모 → 서버에 다듬어 저장 · 전달 대기 줄에 «메모:» 한 줄');
ok(!fwdBtn() && !!msgs()[1].querySelector('.runline button.danger'), '누르면 «전달 대기» + «전달 취소» · 버튼은 사라짐');
ok(msgs().length === 2, '전달은 새 메시지를 만들지 않음');
msgs()[1].querySelector('.runline button.danger').click();
await until(() => !!fwdBtn(), 5000, 'fwd cancelled');
ok(msgs()[1].querySelector('.runlines').textContent.includes('전달 거둠'), '전달 취소 → «전달 거둠» · 버튼 되살아남');
fwdBtn().click();
await until(() => !$('confirm').hidden && !!$('fwd-note'), 3000, 'fwd dialog 3');
$('confirm-ok').click(); // 메모 비움 = 옛 전달
await until(() => msgs()[1].querySelector('.runlines').textContent.includes('전달 대기'), 5000, 'fwd again');
ok(!msgs()[1].querySelector('.fwd-note-line'), '메모 비우고 다시 전달 → 메모 없음(되살린 전달이 옛 메모를 안 끌고 옴)');
const btok = ctx.app.store.createToken('beta', { label: 'fwd-ui' }).token; // 앞 단계(연결 화면)가 베타 토큰을 폐기했다
const BA = (p, b) => fetch(base + p, { method: 'POST', headers: { Authorization: 'Bearer ' + btok, 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then((r) => r.json());
let bc = (await BA('/api/adapter/claim', {})).claim;
while (bc && bc.trigger.thread_id !== FT) {
  // 앞 단계가 남긴 베타 전달(메인 채팅방)은 여기서 마저 끝낸다
  await BA(`/api/adapter/runs/${bc.run.id}/start`, { run_token: bc.run.run_token });
  await BA(`/api/adapter/runs/${bc.run.id}/complete`, { run_token: bc.run.run_token, body: 'beta 정리' });
  bc = (await BA('/api/adapter/claim', {})).claim;
}
ok(bc.forward?.by === 'master' && bc.trigger.seq === Number(msgs()[1].id.slice(1)), '베타 claim: 원인 = 알파 글 · forward 표시');
await BA(`/api/adapter/runs/${bc.run.id}/start`, { run_token: bc.run.run_token });
await BA(`/api/adapter/runs/${bc.run.id}/complete`, { run_token: bc.run.run_token, body: '베타 답', context_upto_seq: bc.forward.context_upto_seq });
await until(() => msgs().length === 3 && msgs()[1].querySelector('.fwd-done'), 5000, 'fwd done');
ok(msgs()[1].querySelector('.fwd-done').textContent.startsWith('→ BETA에게 전달됨 · 답 #'), '끝난 전달 «→ BETA에게 전달됨 · 답 #N»');
ok(msgs()[2].textContent.includes(`↩ #${msgs()[1].id.slice(1)}`), '베타 답은 알파 글에 대한 답(↩)');
ok(!!msgs()[2].querySelector('.fwdbar button.fwd.ghost'), '신호 없는 에이전트 글에도 «전달…» 메뉴');
{
  const mb = msgs()[2].querySelector('.msgbar');
  const labels = [...(mb?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
  ok(labels.includes('전달…') && labels.includes('답장') && labels.includes('복사') && labels.includes('여기서 분기') && !msgs()[2].querySelector('.head .actions'), '답장·복사·여기서 분기가 머리가 아니라 «전달…» 과 같은 줄에(마스터 #327)');
}
await M('POST', `/api/threads/${FT}/stop`, { mode: 'stop_new' });
await until(() => !!w.__S.detail?.thread.invoke_paused && msgs()[2].querySelector('.fwdbar button.fwd.ghost')?.disabled, 5000, 'paused');
ok(msgs()[2].querySelector('.fwdbar').textContent.includes('새 호출 금지 중'), '새 호출 금지 중 → 전달 버튼 꺼짐 + 안내');
await M('POST', `/api/threads/${FT}/resume`, {}); // 빈 몸이면 JSON 400 — 전엔 조용히 안 풀렸다
{
  // 마스터 #475: Esc — 닫을 게 없고 대기·실행 중인 실행이 있으면 «현재 실행 취소» 확인 창
  const pend = () => w.__S.deliveries.some((x) => x.status === 'pending' || x.status === 'leased');
  const esc = () => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await until(() => !w.__S.runs.some((r) => r.state === 'queued' || r.state === 'running') && !pend(), 5000, 'no active');
  esc();
  ok($('confirm').hidden, 'Esc — 도는 실행이 없으면 아무 일 없음');
  await M('POST', `/api/threads/${FT}/messages`, { client_key: 'esc-q', body: '알파 취소 시험', recipients: ['alpha'] });
  await until(pend, 5000, 'esc pending');
  esc();
  await until(() => !$('confirm').hidden, 3000, 'esc confirm');
  ok($('confirm-h').textContent === '현재 실행 취소' && w.document.activeElement === $('confirm-ok'), 'Esc → «현재 실행 취소» 확인 창 · 초점은 확인(Enter)');
  esc();
  await until(() => $('confirm').hidden, 3000, 'esc dismiss');
  ok(pend(), '확인 창에서 Esc → 그만(전달 그대로)');
  esc();
  await until(() => !$('confirm').hidden, 3000, 'esc confirm 2');
  $('confirm-ok').click();
  await until(() => !pend(), 5000, 'esc cancelled');
  ok(!w.__S.detail.thread.invoke_paused, 'Esc → 확인 → 안 나간 전달 거둠 · 호출 금지는 안 걸림');
}

// ── 첨부(2026-10-13 마스터 «이미지·문서 첨부»)
const AT = (await M('POST', '/api/threads', { title: '첨부 시험', members: [] })).thread.id;
await w.__openThread(AT);
await until(() => $('t-title').textContent === '첨부 시험', 5000, 'att thread');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a0f10000000049454e44ae426082', 'hex');
const drop = (files) => {
  const e = new w.Event('drop', { bubbles: true, cancelable: true });
  e.dataTransfer = { files, types: ['Files'] };
  $('composer').dispatchEvent(e);
};
ok(!!$('attach-btn') && $('att-list').hidden, '전송창에 «📎 첨부» 버튼 · 첨부 칸은 비어 숨김');
drop([new w.File([PNG], 'dot.png', { type: 'image/png' }), new w.File(['# 메모\n호두'], '메모.md', { type: 'text/markdown' })]);
ok($$('#att-list .att-chip').length === 2 && $('att-list').textContent.includes('메모.md'), '끌어다 놓기 → 첨부 칩 둘');
$$('#att-list .att-x')[1].click();
ok($$('#att-list .att-chip').length === 1, '✕ → 칩 빠짐');
drop([{ name: 'big.bin', size: 25 * 1024 * 1024, type: '' }]);
await until(() => !$('confirm').hidden, 3000, 'too big notice');
ok($('confirm-text').textContent.includes('20MB 초과') && $$('#att-list .att-chip').length === 1, '20MB 넘는 파일은 안 붙이고 알림');
$('confirm-ok').click();
const pe = new w.Event('paste', { bubbles: true, cancelable: true });
pe.clipboardData = { files: [new w.File(['# 메모\n호두'], 'image.png', { type: 'text/plain' })] };
$('body').dispatchEvent(pe);
ok($$('#att-list .att-chip').length === 2 && /붙여넣기-\d{8}-\d{6}\.png/.test($('att-list').textContent), '붙여넣기 → 칩 · 캡처 이름은 시각으로');
$('body').value = '그림과 문서';
submit('composer');
await until(() => msgs().length === 1 && msgs()[0].querySelector('.att-imgs img'), 6000, 'att msg');
const img = msgs()[0].querySelector('.att-imgs img');
ok(img.getAttribute('src').endsWith('?inline=1') && img.getAttribute('alt') === 'dot.png', '그림은 미리보기(inline)로 보임');
ok(msgs()[0].querySelector('.att-file')?.textContent.includes('📄 붙여넣기-'), '문서는 내려받기 칩(📄 이름 · 크기)');
ok($('att-list').hidden && $$('#att-list .att-chip').length === 0, '보낸 뒤 첨부 칸 비움');
const sv = (await M('GET', `/api/threads/${AT}/messages`)).messages[0];
ok(sv.attachments.map((a) => a.kind).join() === 'image,text', '서버: 메시지 하나에 첨부 둘(그림·텍스트)이 묶임');
drop([new w.File([PNG], 'only.png', { type: 'image/png' })]);
$('body').value = '';
submit('composer');
await until(() => msgs().length === 2, 6000, 'att only');
ok(msgs()[1].querySelector('.att-imgs img')?.getAttribute('alt') === 'only.png', '본문 없이 첨부만 보내기');

// ── 복사(2026-10-13 마스터): 대화 전체 마크다운 · 메시지 하나 · http 대비 execCommand
let copied = null;
Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => void (copied = t) } });
$('t-copy').click();
await until(() => copied !== null, 4000, 'thread copied');
ok(copied.startsWith('# 첨부 시험 (스레드) — 2개 메시지'), '«대화 복사» → 제목·메시지 수 머리');
ok(copied.includes('**마스터(마스터)** · ') && copied.includes('그림과 문서') && copied.includes('📎 dot.png (') && copied.includes('\n\n---\n\n'), '작성자·본문·첨부·구분선이 들어간 마크다운');
await until(() => $('t-copy').textContent === '✓ 2개 복사됨', 2000, 'copy mark');
ok(true, '버튼에 «✓ 2개 복사됨» 잠깐 표시');
copied = null;
[...msgs()[0].querySelectorAll('.actions button')].find((b) => b.textContent === '복사').click();
await until(() => copied !== null, 2000, 'msg copied');
ok(copied.startsWith('그림과 문서\n📎 dot.png'), '메시지 «복사» → 본문 + 첨부 이름');
Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: undefined });
let execCopied = null;
w.document.execCommand = (cmd) => {
  execCopied = cmd === 'copy' ? w.document.activeElement?.value ?? null : null;
  return true;
};
[...msgs()[1].querySelectorAll('.actions button')].find((b) => b.textContent === '복사').click();
await until(() => execCopied !== null, 2000, 'exec copy');
ok(execCopied.startsWith('📎 only.png') && !w.document.querySelector('textarea[aria-hidden]'), 'clipboard 가 없는 http 에서도 복사(숨은 textarea 는 치움)');

// ── 읽음·경과(2026-10-13 마스터 «읽었다는 반응») — 메시지 행 «✓ 읽음 · 작업 중» · «최근: …»
const RT = (await M('POST', '/api/threads', { title: '읽음 시험', members: ['alpha'] })).thread.id;
await w.__openThread(RT);
await until(() => $('t-title').textContent === '읽음 시험', 5000, 'ack thread');
await M('POST', `/api/threads/${RT}/messages`, { client_key: 'ack-q', body: '오래 걸리는 일', recipients: ['alpha'] });
let ac = (await A('/api/adapter/claim', {})).claim;
while (ac && ac.trigger.thread_id !== RT) {
  await A(`/api/adapter/runs/${ac.run.id}/start`, { run_token: ac.run.run_token });
  await A(`/api/adapter/runs/${ac.run.id}/complete`, { run_token: ac.run.run_token, body: 'alpha 정리' });
  ac = (await A('/api/adapter/claim', {})).claim;
}
await A(`/api/adapter/runs/${ac.run.id}/start`, { run_token: ac.run.run_token });
await until(() => msgs()[0]?.querySelector('.runlines').textContent.includes('응답 생성 중'), 5000, 'running no ack');
ok(true, '박동 전에는 «응답 생성 중…»');
await A(`/api/adapter/runs/${ac.run.id}/heartbeat`, { run_token: ac.run.run_token, progress: '읽었음 — 작업 시작' });
await until(() => msgs()[0].querySelector('.runlines').textContent.includes('✓ 읽음 · 작업 중'), 5000, 'ack');
ok(!msgs()[0].querySelector('.runlines').textContent.includes('최근:'), '첫 기계적 반응 → «✓ 읽음 · 작업 중»(경과 줄은 아직 없음)');
await A(`/api/adapter/runs/${ac.run.id}/heartbeat`, { run_token: ac.run.run_token, progress: '도구 Bash — 목록 보기' });
await until(() => msgs()[0].querySelector('.runlines').textContent.includes('최근: 도구 Bash — 목록 보기'), 5000, 'progress');
ok(/최근: 도구 Bash — 목록 보기 \(\d+초 전\)/.test(msgs()[0].querySelector('.runlines').textContent), '경과가 바뀌면 «최근: 도구 Bash — 목록 보기 (n초 전)»');
ok($('wait-banner').textContent.includes('✓ 읽음 · 작업 중'), '머리 띠에도 «✓ 읽음 · 작업 중»');
await A(`/api/adapter/runs/${ac.run.id}/complete`, { run_token: ac.run.run_token, body: '다 했음' });
await until(() => msgs().length === 2, 5000, 'ack done');
ok(!msgs()[0].querySelector('.runlines').textContent.includes('읽음'), '끝나면 실행 줄은 걷히고 답 글만');

// ── 맥락 끌어오기(2026-10-13 마스터 #162) — 끝줄 «← 스레드» → «맥락 가져오기» 버튼 → (예산 모름) 확인 → 카드
const PS = (await M('POST', '/api/threads', { title: '끌어올 원본', members: ['alpha'] })).thread.id;
await M('POST', `/api/threads/${PS}/messages`, { client_key: 'pull-src-1', body: '원본의 결론' });
const PR = (await M('POST', '/api/threads', { title: '끌어오기 시험', members: ['alpha', 'beta'] })).thread.id;
await w.__openThread(PR);
await until(() => $('t-title').textContent === '끌어오기 시험', 5000, 'pull room');
const atok = ctx.app.store.createToken('alpha', { label: 'pull-ui' }).token;
const AA = (p, b) => fetch(base + p, { method: 'POST', headers: { Authorization: 'Bearer ' + atok, 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then((r) => r.json());
const drain = async (who, until) => {
  for (;;) {
    const c = (await who('/api/adapter/claim', {})).claim;
    if (!c) return null;
    await who(`/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token });
    if (until(c)) return c;
    await who(`/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: '정리' });
  }
};
await M('POST', `/api/threads/${PR}/messages`, { client_key: 'pull-q', body: '원본 보고 답해', recipients: ['alpha'] });
const pc = await drain(AA, (c) => c.thread.id === PR);
await AA(`/api/adapter/runs/${pc.run.id}/complete`, { run_token: pc.run.run_token, body: '원본을 봐야 함\n← 끌어올 원본' });
const pullBtn = () => msgs()[1]?.querySelector('.fwdbar button.pull');
await until(() => msgs().length === 2 && !!pullBtn(), 5000, 'pull button');
ok(pullBtn().textContent === '«끌어올 원본» 맥락 가져오기', '끝줄 «← 끌어올 원본» → ««끌어올 원본» 맥락 가져오기» 버튼');
ok(!msgs()[1].querySelector('.body').textContent.includes('← 끌어올 원본'), '끌어오기 신호 줄은 본문에서 사라짐');
pullBtn().click();
await until(() => !$('confirm').hidden && $('confirm-h').textContent === '맥락 가져오기', 5000, 'pull confirm');
ok($('confirm-text').textContent.includes('예산을 서버가 모릅니다'), '예산 신고가 없으면 «예산 모름» 확인');
$('confirm-ok').click();
await until(() => !!msgs()[1].querySelector('.pullcard'), 5000, 'pull card');
ok(msgs()[1].querySelector('.pullcard').textContent.includes('가져온 맥락 — «끌어올 원본»') && msgs()[1].querySelector('.pullcard').textContent.includes('1개 → ALPHA'), '카드 «📥 가져온 맥락 — «끌어올 원본» #n~#n · 1개 → ALPHA»');
ok(msgs().length === 2, '끌어오기는 새 메시지를 만들지 않음');
const pc2 = await drain(AA, (c) => c.thread.id === PR);
ok(pc2.pulled?.messages?.[0]?.body === '원본의 결론', '알파 claim 에 원문 사본(pulled)');
await AA(`/api/adapter/runs/${pc2.run.id}/complete`, { run_token: pc2.run.run_token, body: '가져온 것 보고 답함' });
await until(() => msgs().length === 3, 5000, 'pull reply');

// ── 보내기 키 · 메모/에이전트 배타(마스터 #271)
const ET = (await M('POST', '/api/threads', { title: '엔터 시험', members: ['alpha', 'beta'] })).thread.id;
await w.__openThread(ET);
await until(() => $('t-title').textContent === '엔터 시험' && $$('#recipients input[data-agent]').length === 2, 5000, 'enter thread');
const memoBox = () => $('recipients').querySelector('input[data-memo]');
pick('recipients', 'alpha');
pick('recipients', '*memo');
ok(memoBox().checked && $$('#recipients input[data-agent]:checked').length === 0, '«메모»를 켜면 에이전트가 꺼짐');
pick('recipients', 'beta');
ok(!memoBox().checked, '에이전트를 켜면 «메모»가 꺼짐');
pick('recipients', 'beta');
pick('recipients', '*memo');
const kd = (o) => $('body').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...o }));
$('body').value = '줄바꿈만';
ok(kd({ shiftKey: true }) === true && msgs().length === 0, 'Shift+Enter 는 보내지 않음(줄바꿈)');
ok(kd({ isComposing: true }) === true && msgs().length === 0, '한글 조합 중 Enter 는 보내지 않음');
$('body').value = '엔터로 보냄';
ok(kd({}) === false, 'Enter → 보내기(기본 동작 막음)');
await until(() => msgs().length === 1 && msgs()[0].textContent.includes('엔터로 보냄'), 5000, 'enter send');
$('body').value = '컨트롤 엔터로 보냄';
kd({ ctrlKey: true });
await until(() => msgs().length === 2, 5000, 'ctrl enter send');
ok(true, 'Ctrl+Enter → 보내기');

// ── 세션 크기 표시 · 손 교체 이어받기(마스터 #283 C)
const ST = (await M('POST', '/api/threads', { title: '세션 크기', members: ['alpha'] })).thread.id;
await w.__openThread(ST);
await until(() => $('t-title').textContent === '세션 크기', 5000, 'size thread');
await M('POST', `/api/threads/${ST}/messages`, { client_key: 'size-q', body: '크기 재기', recipients: ['alpha'] });
const sc = await drain(AA, (c) => c.thread.id === ST);
await AA(`/api/adapter/runs/${sc.run.id}/complete`, { run_token: sc.run.run_token, body: '답', usage: { 'claude-cli': { num_turns: 1 }, tokens: { input: 0, cache_read: 20000, cache_write: 0, output: 1 } } });
await until(() => msgs().length === 2, 5000, 'size reply');
await w.__openThread(ST);
if ($('aux').hidden) $('aux-btn').click();
$('tabbtn-sessions').click();
await until(() => $('sessions').textContent.includes('맥락 사용량'), 5000, 'sessions tab');
ok($('sessions').textContent.includes('약 2.0만 토큰 · 답 1개 — 자동 교체 기준 15만 토큰 또는 답 10개'), '세션 탭 «맥락 사용량: 약 2.0만 토큰 · 답 1개 — 자동 교체 기준 15만 토큰 또는 답 10개»');
ok($('t-summary').textContent.includes('1세대 · 2.0만 토큰'), '머리 요약에 «ALPHA 1세대 · 2.0만 토큰»');
[...$('sessions').querySelectorAll('button')].find((b) => b.textContent === '세션 교체').click();
await until(() => !$('confirm').hidden && !!$('rotate-carry'), 5000, 'rotate dialog');
ok($('rotate-carry').checked && $('rotate-kind').value === '포화', '교체 상자: 사유 «맥락 포화» · 이어받기 켜짐');
$('rotate-kind').value = '오류';
$('rotate-kind').dispatchEvent(new w.Event('change'));
ok(!$('rotate-carry').checked, '사유를 «세션 오류»로 바꾸면 이어받기 꺼짐');
$('confirm-no').click();

// ── 주소 미리 채우기 ?new=제목 — 새 주제 창이 제목을 채워 열리고, 만들면 새 스레드 글쓰기 칸이 채워진다(#287·#291)
await w.__openThread(roomId);
await until(() => w.__S.cur === roomId && !!w.__S.detail, 5000, 'room for prefill');
w.__applyPrefill(new URLSearchParams('new=' + encodeURIComponent('새 주제 시험') + '&to=alpha&compose=' + encodeURIComponent('새 주제로 맡길 일')));
await until(() => !$('fork-modal').hidden, 5000, 'prefill fork');
ok($('fork-title').value === '새 주제 시험' && !$('fork-next').disabled, '?new= → 새 주제 창 · 제목 채움');
$('fork-next').click();
$('fork-go').click();
await until(() => $('fork-modal').hidden && $('t-title').textContent === '새 주제 시험', 5000, 'prefill fork opened');
await until(() => $('body').value === '새 주제로 맡길 일', 5000, 'prefill compose in new thread');
ok(w.__S.cur !== roomId && $('body').value === '새 주제로 맡길 일', '만든 새 스레드의 글쓰기 칸에 맡길 글');
ok($('recipients').querySelector('input[data-agent][value="alpha"]')?.checked, '받는 칩 alpha 켜짐');
$('body').value = '';
// 취소하면 맡길 글은 지금 대화로
await w.__openThread(roomId);
await until(() => w.__S.cur === roomId && $('t-kind').textContent !== '스레드', 5000, 'room again');
w.__applyPrefill(new URLSearchParams('new=x&compose=' + encodeURIComponent('취소된 새 주제의 글')));
await until(() => !$('fork-modal').hidden, 5000, 'prefill fork 2');
$('fork-cancel').click();
ok(w.__S.cur === roomId && $('body').value === '취소된 새 주제의 글', '새 주제 창 취소 → 지금 대화 글쓰기 칸으로');
$('body').value = '';
// ?to= 로 고른 칩은 채운 뒤 칩이 다시 그려져도(실시간 연결 복구 등) 남는다 — 사람이 만지면 놓는다(마스터 #323)
w.__applyPrefill(new URLSearchParams('to=alpha&compose=' + encodeURIComponent('대상 유지')));
const aChip = () => $('recipients').querySelector('input[data-agent][value="alpha"]');
ok(aChip()?.checked && !$('recipients').querySelector('input[data-all]')?.checked, '?to=alpha → alpha 칩 켜짐');
w.__renderRecipients();
ok(aChip()?.checked, '칩을 다시 그려도 alpha 켜짐 유지');
aChip().click();
w.__renderRecipients();
ok(!w.__S.prefillTo, '칩을 만지면 주소 대상은 놓음');
$('body').value = '';

// ── 선점 레인(마스터 #345 · 위임 대장 schema 13): 흰 노트블록 · 백수 색 · 대기 쌓임 · 진입 · done 흰색 · 막힘
{
  const P = (scope) => ({ kind: 'path', repo: 'ui-repo', scope });
  const cell = (lane, key) => $(`claims-lanes`).querySelector(`[data-lane="${lane}"] .cl-cell[data-key="${key}"]`);
  const color = (e) => e?.style.getPropertyValue('--c');
  const d1 = (await A('/api/delegations', { assignee: 'baeksu-a', title: '레인 일 1', spec: '첫 줄 명세\n둘째 줄', claims: [P('src/'), P('README.md'), { kind: 'resource', repo: 'deploy', scope: 'CTX' }] })).delegation;
  await A(`/api/delegations/${d1.id}/status`, { status: 'running' });
  $('tabbtn-claims').click();
  await until(() => cell('path:ui-repo', 'src/')?.classList.contains('held'), 5000, 'claims lane');
  ok(!$('tab-claims').hidden && $('tabbtn-claims').getAttribute('aria-selected') === 'true', '보조 패널 «선점» 탭 열림');
  ok($$('#claims-lanes .cl-lane h4').map((h) => h.firstChild.textContent).join() === 'ui-repo,자원', '저장소 레인 + 자원 한 줄');
  const ca = w.__claimColor('baeksu-a');
  ok(color(cell('path:ui-repo', 'src/')) === ca && color(cell('path:ui-repo', 'README.md')) === ca && color(cell('resource:', 'deploy/CTX')) === ca, '같은 백수 = 같은 색(경로·자원 블록 모두)');
  ok(w.__claimColor('baeksu-a') === ca && w.__claimColor('baeksu-b') !== ca, '색은 assignee 에서 결정적');
  // 겹치는 위임을 queue:true 로 → 레인 위에 쌓인다(대기 블록 · 노트블록보다 위 줄)
  const d2 = (await A('/api/delegations', { assignee: 'baeksu-b', title: '레인 일 2', spec: '대기할 일', queue: true, claims: [P('src/app.js'), P('docs/')] })).delegation;
  await until(() => $$(`#claims-lanes .cl-q[data-dlg="${d2.id}"]`).length === 2, 5000, 'queued stack');
  const q = $$(`#claims-lanes .cl-q[data-dlg="${d2.id}"]`);
  ok(q.every((b) => Number(b.style.gridRow) < Number(cell('path:ui-repo', 'docs/').style.gridRow)), 'queued 블록은 노트블록 위에 쌓임');
  ok(q.every((b) => b.classList.contains('fall')), '새 대기 행은 위에서 떨어지는 연출(fall)');
  ok(!cell('path:ui-repo', 'docs/').classList.contains('held') && cell('path:ui-repo', 'src/app.js').classList.contains('held') && color(cell('path:ui-repo', 'src/app.js')) === ca, '대기 줄은 물들지 않음 · 덮인 블록은 잡은 백수 색');
  q[0].click();
  await until(() => $('claims-detail').textContent.includes('레인 일 2'), 3000, 'detail');
  ok($('claims-detail').textContent.includes('baeksu-b') && $('claims-detail').textContent.includes('대기') && !!$('cl-admit'), '블록을 누르면 제목·백수·상태 · 마스터에게 «진입»');
  $('cl-admit').click();
  await until(() => $('cl-msg')?.textContent.includes('아직 겹칩니다'), 3000, 'admit 409');
  ok($('cl-msg').textContent.includes('baeksu-a'), '아직 겹치면 진입 거절 — 누가 쥐었나');
  // done → 하얘진다(그 색에서 흰색으로)
  await A(`/api/delegations/${d1.id}/status`, { status: 'done', result: '끝' });
  await until(() => !cell('path:ui-repo', 'src/')?.classList.contains('held'), 5000, 'done whiten');
  ok(cell('path:ui-repo', 'src/').classList.contains('whiten') && !cell('resource:', 'deploy/CTX').classList.contains('held'), 'done → 블록이 하얘짐(whiten 연출) · 끝난 범위는 흰 블록으로 남음');
  $('cl-admit').click();
  await until(() => cell('path:ui-repo', 'docs/')?.classList.contains('held'), 5000, 'admitted');
  const cb = w.__claimColor('baeksu-b');
  ok(!$$('#claims-lanes .cl-q').length && color(cell('path:ui-repo', 'docs/')) === cb && color(cell('path:ui-repo', 'src/app.js')) === cb, '진입 → 대기 행이 내려와 그 백수 색으로 물듦');
  ok(cell('path:ui-repo', 'docs/').classList.contains('drop'), '닿을 때 떨어짐 연출(drop)');
  // 막힘: 일하는 중 더 청한 범위가 잡혀 있으면 blocked → 테두리 붉게
  const d3 = (await A('/api/delegations', { assignee: 'baeksu-c', title: '레인 일 3', spec: '-', claims: [P('lib/')] })).delegation;
  await A(`/api/delegations/${d2.id}/claims`, { claims: [P('lib/x.js')] });
  await until(() => cell('path:ui-repo', 'docs/')?.classList.contains('blocked'), 5000, 'blocked');
  ok(!cell('path:ui-repo', 'lib/').classList.contains('blocked'), '막힘(blocked) 위임의 블록만 붉은 테두리');
  // 장면 계산은 그리기와 따로(2안 3D 대비) — 순수 함수
  const sc = w.__claimScene([{ id: 'x', assignee: 'k', title: 't', spec: '', status: 'running', claims: [{ kind: 'path', repo: 'r', scope: '*', granted: true, released_at: null }] }]);
  ok(sc.lanes[0].cells[0].holder?.id === 'x' && sc.lanes[0].stack.length === 0, 'claimScene — DOM 없이 상태 → 장면');
  for (const d of [d2, d3]) await A(`/api/delegations/${d.id}/status`, { status: 'done' });
  $('aux-close').click();
}

// ── 요청 창구(마스터 #352): 출처 «요청» 배지 · «ALPHA → BETA» · 보류 → 머리 «보류된 요청 N» · 보조 패널 목록·사유·«확인함»
{
  const st = ctx.app.store;
  st.setRequestPair({ participant: st.getMaster(), via: 'cookie', scopes: ['admin'], actor: { id: 'cli:root', kind: 'cli' } }, 'alpha', 'beta', true);
  const rtok = st.createToken('beta', { label: 'rq-ui' }).token;
  const RB = (p, b) => fetch(base + p, { method: 'POST', headers: { Authorization: 'Bearer ' + rtok, 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then((r) => r.json());
  /** 그 스레드의 전달이 나올 때까지 앞 단계가 남긴 것은 마저 끝낸다 */
  const take = async (call, th) => {
    let c = (await call('/api/adapter/claim', {})).claim;
    while (c && c.trigger.thread_id !== th) {
      await call(`/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token });
      await call(`/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: '정리' });
      c = (await call('/api/adapter/claim', {})).claim;
    }
    await call(`/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token });
    return c;
  };
  const RT = (await M('POST', '/api/threads', { title: '요청 시험', members: ['alpha', 'beta'] })).thread.id;
  await w.__openThread(RT);
  await until(() => $('t-title').textContent === '요청 시험', 5000, 'rq thread');
  await M('POST', `/api/threads/${RT}/messages`, { client_key: 'rq-q', body: '알파, 조사해', recipients: ['alpha'] });
  const ac = await take(A, RT);
  await A(`/api/adapter/runs/${ac.run.id}/complete`, { run_token: ac.run.run_token, body: '조사 결과 셋\n요청→ BETA' });
  await until(() => msgs().length === 2 && msgs()[1].querySelector('.runlines')?.textContent.includes('전달 대기'), 5000, 'rq msg');
  ok(msgs()[1].querySelector('.head .badge.req')?.textContent === '요청', '요청 글 — 출처 배지 «요청»');
  ok(/실행 권한을 주지 않는다/.test(msgs()[1].querySelector('.head .badge.req')?.title ?? ''), '요청 배지 툴팁 — «요청은 실행 권한을 주지 않는다»');
  ok(msgs()[1].querySelector('.head .req-route')?.textContent === 'ALPHA → BETA', '요청 글 — «ALPHA → BETA»');
  ok(!msgs()[1].querySelector('.body').textContent.includes('요청→') && !msgs()[1].querySelector('.fwdbar button.fwd.primary-soft'), '신호 줄은 본문에서 사라지고 전달 버튼 없이 바로 BETA 전달 대기');
  const bc2 = await take(RB, RT);
  ok(bc2.trigger.seq === Number(msgs()[1].id.slice(1)) && bc2.trigger.source_kind === 'request', 'BETA claim 원인 = 요청 글(출처 request)');
  await RB(`/api/adapter/runs/${bc2.run.id}/complete`, { run_token: bc2.run.run_token, body: '서버 끄기는 마스터 몫\n보류: 마스터 방향과 어긋남' });
  await until(() => !!$('t-holds'), 5000, 'hold alert');
  ok($('t-holds').textContent.startsWith('보류된 요청 1') && !$('t-alert').hidden, '머리 경고줄 «보류된 요청 1»');
  await until(() => msgs()[1].querySelector('.runlines').textContent.includes('요청 보류'), 5000, 'hold line');
  ok(msgs().length === 2 && msgs()[1].querySelector('.runlines').textContent.includes('BETA — 마스터 방향과 어긋남'), '보류는 스레드에 글을 안 올림 · 요청 글 아래 «요청 보류 BETA — 사유»');
  $('t-holds').click();
  await until(() => !$('tab-runs').hidden && $$('#holds li[data-hold]').length === 1, 5000, 'holds panel');
  const li = $$('#holds li[data-hold]')[0];
  ok(li.textContent.includes('ALPHA → BETA') && li.textContent.includes('사유: 마스터 방향과 어긋남') && li.textContent.includes('서버 끄기는 마스터 몫') && !!li.querySelector('.hold-ack'), '보조 패널 «보류된 요청» — 짝·사유·설명·[확인함]');
  li.querySelector('.hold-ack').click();
  await until(() => !$('t-holds') && !$$('#holds .hold-ack').length, 5000, 'hold acked');
  ok($$('#holds li[data-hold]')[0].textContent.includes('확인 ') && msgs()[1].querySelector('.runlines').textContent.includes('확인함'), '«확인함» → 머리 경고 사라짐 · 목록·요청 글 줄에 «확인»');
  $('aux-close').click();
}

// ── 마크다운 ↔ 원문(마스터 #477): 렌더 · 위험한 링크는 글자로 · 대화 단위 전환 · 이 브라우저에 기억
{
  const R = w.__renderBody;
  const h = R('# 제목\n\n- 하나 **굵게**\n  - 안쪽\n- 둘\n\n1. 첫째\n2. 둘째\n\n> 인용 `코드`\n\n| 칸 | 값 |\n|---|--:|\n| a | 1 |\n\n[링크](https://x.example/a?b=1&c=2) [나쁨](javascript:alert(1)) https://y.example/p.\n\n```js\nconst a = "<b>";\n```\n---\n줄1\n줄2');
  ok(/<h1>제목<\/h1>/.test(h) && /<ul><li>하나 <strong>굵게<\/strong><ul><li>안쪽<\/li><\/ul><\/li><li>둘<\/li><\/ul>/.test(h), 'MD: 제목 · 중첩 목록 · 굵게');
  ok(/<ol><li>첫째<\/li><li>둘째<\/li><\/ol>/.test(h) && /<blockquote><p>인용 <code>코드<\/code><\/p><\/blockquote>/.test(h), 'MD: 번호 목록 · 인용 · 인라인 코드');
  ok(/<table><thead><tr><th>칸<\/th><th class="al-right">값<\/th><\/tr><\/thead><tbody><tr><td>a<\/td><td class="al-right">1<\/td><\/tr>/.test(h), 'MD: 표 · 정렬');
  ok(h.includes('<a href="https://x.example/a?b=1&amp;c=2"') && !h.includes('href="javascript') && h.includes('[나쁨](javascript:alert(1))'), 'MD: http 링크만 — javascript: 는 글자로');
  ok(h.includes('<a href="https://y.example/p" ') && h.includes('</a>.'), 'MD: 맨 주소 자동 링크 · 끝 마침표는 밖');
  ok(h.includes('<pre><code data-lang="js">const a = &quot;&lt;b&gt;&quot;;</code></pre>') && h.includes('<hr>') && h.includes('<p>줄1<br>줄2</p>'), 'MD: 코드 블록 이스케이프 · 가로줄 · 한 줄 바꿈은 <br>');
  ok(!R('<img src=x onerror=alert(1)> **b**').includes('<img'), 'MD: 태그는 이스케이프');

  const cur = w.__S.cur;
  const b0 = msgs()[0].querySelector('.body');
  ok($('t-md').textContent === '원문 보기' && b0.classList.contains('md'), '기본은 마크다운 · 버튼 «원문 보기»');
  $('t-md').click();
  ok($('t-md').textContent === '마크다운 보기' && $('t-md').getAttribute('aria-pressed') === 'true', '«원문 보기» 누르면 버튼이 «마크다운 보기»로');
  ok(msgs().every((m) => m.querySelector('.body').classList.contains('plain')) && w.localStorage.getItem(`bs.plain.${cur}`) === '1', '이 대화의 글 전부 원문 · 이 브라우저에 기억');
  ok(!msgs()[0].querySelector('.body').querySelector('strong,code,p'), '원문엔 태그 없음');
  w.location.hash = roomId === cur ? forkId : roomId;
  await until(() => w.__S.cur !== cur && w.__S.detail, 5000, 'other thread');
  ok($('t-md').textContent === '원문 보기', '다른 대화는 그대로 마크다운(대화 단위)');
  w.location.hash = cur;
  await until(() => w.__S.cur === cur && msgs().length > 0, 5000, 'back');
  ok($('t-md').textContent === '마크다운 보기' && msgs()[0].querySelector('.body').classList.contains('plain'), '돌아오면 원문 그대로');
  $('t-md').click();
  ok(msgs()[0].querySelector('.body').classList.contains('md') && w.localStorage.getItem(`bs.plain.${cur}`) === null, '다시 누르면 마크다운 · 기억 지움');
}

// ── 안 본 답 N 배지(마스터 #535): 보낸 뒤 그 대화를 안 보고 있으면 답이 왔을 때 목록에 N · 열면 지움
{
  const cur = w.__S.cur;
  const other = roomId === cur ? forkId : roomId;
  const item = (id) => w.document.querySelector(`.conv-item[data-id="${id}"]`);
  if (!w.document.querySelector('#recipients input[value="alpha"]').checked) pick('recipients', 'alpha');
  const n0 = msgs().length;
  $('body').value = 'N 배지 시험';
  submit('composer');
  await until(() => msgs().length === n0 + 1 && JSON.parse(w.localStorage.getItem('bs.await') || '{}')[cur] > 0, 6000, 'await mark');
  ok(!item(cur).querySelector('.new-badge'), '보낸 직후 — 보고 있는 대화엔 N 없음');
  w.location.hash = other;
  await until(() => w.__S.cur === other && w.__S.detail, 5000, 'leave');
  let cl;
  for (let i = 0; i < 10; i++) {
    cl = (await A('/api/adapter/claim', {})).claim;
    if (!cl) throw new Error('no claim for N badge');
    await A(`/api/adapter/deliveries/${cl.delivery.id}/ack`, { lease_token: cl.delivery.lease_token });
    if (cl.trigger.body === 'N 배지 시험' && cl.run.run_token) break;
  }
  await A(`/api/adapter/runs/${cl.run.id}/start`, { run_token: cl.run.run_token });
  await A(`/api/adapter/runs/${cl.run.id}/complete`, { run_token: cl.run.run_token, body: 'N 배지 답' });
  await until(() => item(cur)?.querySelector('.new-badge'), 5000, 'N badge');
  ok(item(cur).querySelector('.new-badge').textContent === 'N' && !item(other).querySelector('.new-badge'), '안 보는 사이 답이 오면 그 대화에만 N');
  w.location.hash = cur;
  await until(() => w.__S.cur === cur && msgs().some((m) => m.textContent.includes('N 배지 답')), 5000, 'open answered');
  await until(() => !item(cur).querySelector('.new-badge'), 3000, 'badge cleared');
  ok(JSON.parse(w.localStorage.getItem('bs.await') || '{}')[cur] === undefined, '열어서 답을 받으면 N 지움 · 기다림도 지움');
}

// ── 대면 모드(마스터 #581): 머리 단추 → 세 열 · 받는 이 칩 대신 한 줄 · 합의문(판·턴·바뀐 줄) · 쟁점 → ⚑ 안건 카드 → «이 판으로» · 결론 카드 승인 · 질문 카드 · 탭 · 끄기
{
  // 앞 절(에이전트 연결)에서 BETA 토큰을 폐기했다 — 이 절의 토큰을 새로 낸다
  const ftok = { alpha: ctx.app.store.createToken('alpha', { label: 'face-ui' }).token, beta: ctx.app.store.createToken('beta', { label: 'face-ui' }).token };
  const tokOf = (who) => ftok[who];
  const AG = (who, p, b) =>
    fetch(base + p, { method: 'POST', headers: { Authorization: 'Bearer ' + tokOf(who), 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then((r) => r.json());
  const fdoc = (note, lines) => `${note}\n\n\`\`\`합의문\n${lines.join('\n')}\n\`\`\``;
  const th = (await M('POST', '/api/threads', { title: '대면 시험', members: ['alpha', 'beta'] })).thread.id;
  async function agentTurn(who, body) {
    let cl;
    // 앞 절들이 남긴 이 에이전트 앞 배달(대량 복구 등)을 비워 가며 이 대화의 대면 턴을 찾는다
    for (let i = 0; i < 600; i++) {
      cl = (await AG(who, '/api/adapter/claim', {})).claim;
      if (!cl) {
        await sleep(60);
        continue;
      }
      await AG(who, `/api/adapter/deliveries/${cl.delivery.id}/ack`, { lease_token: cl.delivery.lease_token });
      if (cl.thread.id === th && cl.run.run_token && cl.face) break;
    }
    if (!cl?.face) throw new Error(`no face claim for ${who}`);
    await AG(who, `/api/adapter/runs/${cl.run.id}/start`, { run_token: cl.run.run_token });
    await AG(who, `/api/adapter/runs/${cl.run.id}/complete`, { run_token: cl.run.run_token, body });
    return cl;
  }
  await until(() => w.__S.threads.some((t) => t.id === th), 5000, 'face thread listed');
  w.location.hash = th;
  await until(() => w.__S.cur === th && w.__S.detail?.thread.id === th, 5000, 'open face thread');
  ok(!$('t-face').hidden && $('t-face').textContent === '대면 모드' && $('t-face').getAttribute('aria-pressed') === 'false', '대화 머리 «대면 모드» 단추(마스터 · 꺼짐)');
  $('t-face').click();
  await until(() => !$('face').hidden, 5000, 'face on');
  ok($('messages').hidden && $('t-face').getAttribute('aria-pressed') === 'true', '켜면 보통 목록 대신 세 열 · 단추 눌림');
  await until(() => $('recipients').textContent.includes('새 지시 → ALPHA부터'), 3000, 'face recipients note');
  ok(!$('recipients').querySelector('input'), '받는 이 칩 없음 — «새 지시 → ALPHA부터» 한 줄');
  ok($('face-left-h').textContent === 'ALPHA' && $('face-right-h').textContent === 'BETA', '왼쪽 초안 쪽 · 오른쪽 검토 쪽 이름');
  $('body').value = '대면 지시 — 개선안을 정리해';
  submit('composer');
  await until(() => $('face-orders').textContent.includes('대면 지시'), 5000, 'order shown');
  ok(true, '마스터 지시는 가운데 위');
  await until(() => $('face-cards').textContent.includes('ALPHA 차례 · 턴 1'), 5000, 'running card');
  ok(!!$('face-stop'), '진행 카드 «ALPHA 차례 · 턴 1» + [멈추기]');
  const c1 = await agentTurn('alpha', fdoc('초안을 씀', ['X', 'Y']));
  ok(c1.face.turn === 1 && c1.face.role === 'drafter', 'claim 에 대면 턴 1 · 초안 쪽');
  await until(() => $$('#face-doc li').length === 2, 5000, 'doc draft');
  ok($('face-doc-h').textContent.includes('판 1') && $('face-doc-h').textContent.includes('턴 1/4(→6)'), '합의문 머리 «판 1 · 턴 1/4(→6)»');
  await until(() => $('face-left-list').textContent.includes('초안을 씀'), 4000, 'left col');
  ok($('face-right-list').children.length === 0 && $('face-left-list').querySelector('.pill').textContent.includes('판 1'), '해설은 왼쪽 열 · «판 1» 표시 · 오른쪽은 비어 있음');
  await agentTurn('beta', fdoc('X 를 고침', ['X2', 'Y']));
  await until(() => $('face-doc-h').textContent.includes('판 2'), 5000, 'rev 2');
  ok($$('#face-doc li')[0].classList.contains('changed') && !$$('#face-doc li')[1].classList.contains('changed'), '바뀐 줄만 강조');
  ok($('face-right-list').textContent.includes('X 를 고침'), '검토 쪽 해설은 오른쪽 열');
  await agentTurn('alpha', fdoc('X 는 원래대로', ['X', 'Y']));
  await until(() => $('face-cards').textContent.includes('⚑ 안건 1'), 5000, 'issue card');
  ok($$('#face-doc li')[0].classList.contains('issue') && $$('#face-doc li')[0].textContent.includes('⚑ 안건 1'), '쟁점 줄 «⚑ 안건 1»');
  ok($('face-cards').textContent.includes('되돌림') && $('face-cards').textContent.includes('BETA안') && $('face-cards').textContent.includes('ALPHA안'), '안건 카드 — 각 쪽 판 · 되돌림 표시');
  await agentTurn('beta', fdoc('고칠 것 없음', ['X', 'Y']));
  await until(() => $('face-cards').textContent.includes('합의 · 안건 1'), 5000, 'agreed with issue');
  ok($('face-approve').disabled, '열린 안건이 있으면 [승인] 꺼짐');
  $('face-cards').querySelector('[data-pick="0"]').click();
  await until(() => $('face-approve') && !$('face-approve').disabled, 5000, 'decided');
  ok($$('#face-doc li')[0].textContent.startsWith('X2') && $('face-cards').textContent.includes('정함'), '«이 판으로» → 합의문 줄 교체 · 안건 «정함»');
  $('face-settle').value = '정산: 2026-11-01 · 실패율';
  $('face-approve').click();
  await until(() => $('face-cards').textContent.includes('승인됨'), 5000, 'approved');
  ok($('face-cards').textContent.includes('정산: 2026-11-01'), '승인 → «승인됨» + 정산 줄');
  // 질문 카드: 새 지시 → 초안 쪽이 질문으로 멈춤 → 작성란 한 줄이 «질문 답 → ALPHA»
  $('body').value = '두 번째 지시';
  submit('composer');
  await agentTurn('alpha', '확인할 것\n질문: 범위는 host-a 만인가?');
  await until(() => $('face-cards').textContent.includes('범위는 host-a 만인가?'), 5000, 'question card');
  ok($('face-doc-h').textContent.includes('질문'), '머리 상태 «질문 — 마스터 답 대기»');
  await until(() => $('recipients').textContent.includes('질문 답 → ALPHA'), 3000, 'question note');
  ok(true, '작성란 «질문 답 → ALPHA이(가) 이어 받습니다»');
  // 좁은 화면 탭
  $('face-tab-right').click();
  ok($('face').dataset.tab === 'right' && $('face-tab-right').getAttribute('aria-selected') === 'true', '탭(합의문 · 초안 쪽 · 검토 쪽) — 검토 쪽');
  $('face-tab-doc').click();
  // 끄기 → 확인 → 보통 목록 · 라운드 멈춤
  $('t-face').click();
  await until(() => !$('confirm').hidden, 3000, 'confirm off');
  $('confirm-ok').click();
  await until(() => $('face').hidden && !$('messages').hidden, 5000, 'face off');
  const fo = await M('GET', `/api/threads/${th}/face`);
  ok(fo.mode === 'chat' && fo.round.state === 'stopped' && fo.round.stop_reason === 'mode_off', '끄면 보통 대화 · 진행 중 대면은 멈춤(mode_off)');
  ok(!!$('recipients').querySelector('input[data-agent]'), '보통 대화로 돌아오면 수신 칩');
}

// ── 하위 스레드 합치기(마스터 #706): 머리 «⤴ 상위로 합치기 (N)» → 확인 → 상위 대화로 · 묶음 상자 · 펼치면 옮긴 글
{
  const parentId = w.__S.threads.find((t) => t.id === forkId).parent_thread_id;
  await M('POST', `/api/threads/${forkId}/messages`, { client_key: `merge-${Date.now()}`, body: '합칠 **글**', recipients: [] });
  w.location.hash = forkId;
  await until(() => w.__S.cur === forkId && w.__S.detail?.thread.id === forkId && !$('t-merge').hidden && w.__S.detail.unmerged > 0, 5000, 'merge btn');
  const n = w.__S.detail.unmerged;
  ok($('t-merge').textContent === `⤴ 상위로 합치기 (${n})` && !$('t-merge').disabled, '하위 스레드 머리에 «⤴ 상위로 합치기 (안 합친 글 수)»');
  $('t-merge').click();
  await until(() => !$('confirm').hidden, 3000, 'merge confirm');
  ok($('confirm-text').textContent.includes(`글 ${n}개`), '확인 상자: 옮길 글 수');
  $('confirm-ok').click();
  await until(() => w.__S.cur === parentId && $$('#messages .merge-box').length > 0, 6000, 'merged into parent');
  const box = $$('#messages .merge-box').at(-1);
  ok(box.textContent.includes(`글 ${n}개`) && box.querySelector('.merge-list').hidden, '상위 대화에 묶음 상자 하나(접힘) · 한 줄씩 흩어지지 않음');
  box.querySelector('.merge-h button').click();
  await until(() => box.querySelectorAll('.merge-item').length === n, 5000, 'merge items');
  ok([...box.querySelectorAll('.merge-item')].at(-1).querySelector('.body strong')?.textContent === '글', '펼치면 옮긴 글(마크다운 렌더)');
  ok($('t-merge').hidden, '상위(메인 채팅방)엔 합치기 버튼 없음');
  w.location.hash = forkId;
  await until(() => w.__S.detail?.thread.id === forkId && !$('t-merge').hidden, 5000, 'back to fork');
  ok($('t-merge').disabled && $('t-path').textContent.includes('상위로 합침 1번'), '합친 뒤 하위 스레드: 버튼 꺼짐 · 경로 줄에 합침 기록');
}

const bad = errors;
console.log('errors:', errors);
w.__S.ws && w.__S.ws.close();
w.close();
await ctx.close();
console.log(bad.length ? 'UI 스모크 실패' : 'UI 스모크 통과');
process.exit(bad.length ? 1 : 0);

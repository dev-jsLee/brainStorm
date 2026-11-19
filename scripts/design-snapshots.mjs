// 디자인 스냅숏: ui-smoke 와 같은 방식(jsdom + 실제 서버 · 임시 데이터)으로 화면을 그려
// 그 순간의 DOM 을 style.css 를 붙인 정적 HTML 로 굳힌다. JS 는 빼므로 브라우저로 열면 그 상태 그대로 보인다.
// 실행: npm run build && node scripts/design-snapshots.mjs <출력 폴더>
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import WS from 'ws';
import { setup, MASTER_PASS } from '../dist/test/helpers.js';

const OUT = path.resolve(process.argv[2] || 'snapshots');
fs.mkdirSync(OUT, { recursive: true });
const PUB = new URL('../public/', import.meta.url);
const fontsCss = fs.existsSync(new URL('fonts.css', PUB)) ? fs.readFileSync(new URL('fonts.css', PUB), 'utf8').replaceAll('url(/fonts/', 'url(' + new URL('fonts/', PUB).href) : '';
const css = fontsCss + '\n' + fs.readFileSync(new URL('style.css', PUB), 'utf8');

const ctx = await setup({ faceDrafter: 'alpha', faceReviewer: 'beta' });
const base = ctx.base;
const st = ctx.app.store;
const html = fs.readFileSync(new URL('index.html', PUB), 'utf8').replace(/<script[^>]*><\/script>/, '');
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
w.alert = () => {};
w.confirm = () => true;
w.prompt = () => null;
w.HTMLFormElement.prototype.requestSubmit = function () {
  this.dispatchEvent(new w.Event('submit', { cancelable: true }));
};
w.Element.prototype.scrollIntoView = () => {};
w.localStorage.setItem('bs.lang', process.env.BS_UI_LANG || 'ko');
w.eval(
  (await (await fetch(new URL('/i18n-dict.js', base))).text()) +
    '\n' +
    ['i18n.js', 'runs.js', 'admin.js', 'claims.js', 'face.js', 'questions.js', 'app.js'].map((f) => fs.readFileSync(new URL(f, PUB), 'utf8')).join('\n') +
    '\nwindow.__S = S;',
);
const $ = (id) => w.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000, what = '') => {
  const e = Date.now() + ms;
  const t = () => {
    try {
      return f();
    } catch {
      return false;
    }
  };
  while (!t()) {
    if (Date.now() > e) throw new Error('timeout: ' + what);
    await sleep(40);
  }
};
const submit = (id) => $(id).dispatchEvent(new w.Event('submit', { cancelable: true }));
const M = (method, p, b) =>
  fetch(base + p, { method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const tokOf = (who) => ctx.tokens[who].token;
const AG = (who, p, b) =>
  fetch(base + p, { method: 'POST', headers: { Authorization: 'Bearer ' + tokOf(who), 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then((r) => r.json());

const index = [];
function snap(name, title, note = '') {
  const doc = w.document.documentElement.cloneNode(true);
  doc.querySelectorAll('script, link[rel="stylesheet"], link[rel="manifest"]').forEach((n) => n.remove());
  const head = doc.querySelector('head');
  const style = w.document.createElement('style');
  style.textContent = css;
  head.appendChild(style);
  const out = '<!doctype html>\n<!-- brainStorm 디자인 스냅숏: ' + title + ' (JS 없음 · 정적) -->\n' + doc.outerHTML;
  fs.writeFileSync(path.join(OUT, name + '.html'), out);
  index.push({ name, title, note });
  console.log('  📸', name, '—', title);
}

// 에이전트 한 턴: claim → ack → start → (complete)
async function agentTurn(who, thread, body, { finish = true, match } = {}) {
  let cl;
  for (let i = 0; i < 300; i++) {
    cl = (await AG(who, '/api/adapter/claim', {})).claim;
    if (!cl) {
      await sleep(50);
      continue;
    }
    await AG(who, `/api/adapter/deliveries/${cl.delivery.id}/ack`, { lease_token: cl.delivery.lease_token });
    if (cl.thread.id === thread && cl.run?.run_token && (!match || match(cl))) break;
    cl = null;
  }
  if (!cl) throw new Error(`no claim for ${who}`);
  await AG(who, `/api/adapter/runs/${cl.run.id}/start`, { run_token: cl.run.run_token });
  if (finish) await AG(who, `/api/adapter/runs/${cl.run.id}/complete`, { run_token: cl.run.run_token, body });
  return cl;
}

// ── 1. 로그인
await until(() => !$('login-view').hidden, 8000, 'login');
snap('01-login', '로그인');
$('login-pass').value = MASTER_PASS;
submit('login-form');
await until(() => !$('app-view').hidden && $('conn').textContent === '연결됨', 8000, 'app');
await until(() => !$('thread').hidden && $('t-title').textContent === '메인 채팅방', 8000, 'room');
const roomId = w.__S.cur;

// ── 2. 메인 채팅방: 마스터 지시 → 에이전트 답(마크다운) → 진행 중 실행 하나
const post = (tid, key, body, recipients = []) => M('POST', `/api/threads/${tid}/messages`, { client_key: key, body, recipients });
await post(roomId, 'd1', '이번 주 배포 전에 점검할 것을 정리해 줘. 위험한 것부터.', ['alpha']);
await agentTurn(
  'alpha',
  roomId,
  [
    '점검 목록을 위험 순으로 정리했음.',
    '',
    '## 먼저 볼 것',
    '1. **DB 마이그레이션** — 되돌리는 스크립트가 아직 없음',
    '2. 인증서 만료 — `api.example.com` 이 9일 남음',
    '3. 백업 복구 시험 — 지난달 이후 안 돌렸음',
    '',
    '| 항목 | 위험 | 담당 |',
    '|---|---|---|',
    '| 마이그레이션 | 높음 | ALPHA |',
    '| 인증서 | 중간 | BETA |',
    '',
    '```bash',
    'npm run migrate -- --dry-run',
    '```',
    '',
    '> 백업 시험은 주말에 돌리는 것을 추천함.',
  ].join('\n'),
);
await post(roomId, 'd2', 'BETA는 인증서 갱신 절차를 확인해 줘.', ['beta']);
await agentTurn('beta', roomId, '인증서 갱신 절차 확인했음. 자동 갱신이 꺼져 있어서 켜는 설정 한 줄이 필요함.');
await post(roomId, 'd3', '좋아. ALPHA, 되돌리는 스크립트 초안 만들어 줘.', ['alpha']);
const running = await agentTurn('alpha', roomId, '', { finish: false });
await until(() => w.document.querySelectorAll('#messages .msg').length >= 5, 8000, 'room msgs');
await until(() => !$('wait-banner').hidden, 8000, 'wait banner');
await sleep(300);
snap('02-room', '메인 채팅방 — 대화 · 마크다운 답 · 응답 대기 중');

// ── 3. 보조 패널(실행·참여자)
$('aux-btn').click();
$('tabbtn-runs').click();
await until(() => !$('aux').hidden && $('runs').textContent.includes('실행 중'), 8000, 'aux runs');
snap('03-aux-runs', '보조 패널 — 실행 탭', '대화 오른쪽에 붙는 패널');
$('tabbtn-people').click();
await sleep(500);
snap('04-aux-people', '보조 패널 — 참여자 탭');
$('aux-close').click();
await AG('alpha', `/api/adapter/runs/${running.run.id}/complete`, { run_token: running.run.run_token, body: '초안을 올렸음. `scripts/rollback.sql` 에 있음.' });
await sleep(400);

// ── 4. 스레드 분기 + 맥락 + 트리
const msgSeq = (await M('GET', `/api/threads/${roomId}/messages?limit=50`)).messages?.find((m) => m.body?.startsWith('BETA는'))?.seq ?? 3;
const F = (await M('POST', `/api/threads/${roomId}/fork`, { from_seq: msgSeq, title: '인증서 자동 갱신', client_key: 'fk1', members: ['beta'] })).thread.id;
await post(F, 'f1', '설정 한 줄 바꾸면 어디에 영향이 가?', ['beta']);
await agentTurn('beta', F, '영향은 프록시 하나뿐임. 재시작 없이 다음 갱신 주기에 적용됨.\n\n- 바꿀 파일: `proxy.conf`\n- 되돌리기: 그 줄을 지우면 됨');
const F2 = (await M('POST', `/api/threads/${F}/fork`, { from_seq: 1, title: '갱신 실패 알림', client_key: 'fk2', members: ['beta'] })).thread.id;
await post(F2, 'f2', '갱신이 실패하면 어떻게 알 수 있어?');
for (let i = 1; i <= 3; i++) await M('POST', '/api/threads', { title: ['주간 회고', '백업 복구 시험', '모니터링 대시보드 정리'][i - 1], members: ['alpha', 'beta'] });
await until(() => w.__S.threads.some((t) => t.id === F2), 8000, 'threads listed');
w.location.hash = F;
await until(() => w.__S.cur === F && w.__S.detail?.thread.id === F, 8000, 'open fork');
await sleep(500);
if ($('context-box') && !$('context-box').hidden) $('context-box').open = true;
snap('05-thread-fork', '하위 스레드 — 분기 맥락 · 사이드바 분기 트리');

// ── 5. 대면 모드
const FT = (await M('POST', '/api/threads', { title: '배포 절차 개선안', members: ['alpha', 'beta'] })).thread.id;
await until(() => w.__S.threads.some((t) => t.id === FT), 8000, 'face listed');
w.location.hash = FT;
await until(() => w.__S.cur === FT && w.__S.detail?.thread.id === FT, 8000, 'open face');
$('t-face').click();
await until(() => !$('face').hidden, 8000, 'face on');
$('body').value = '배포 절차 개선안을 합의문으로 정리해.';
submit('composer');
const fdoc = (note, lines) => `${note}\n\n\`\`\`합의문\n${lines.join('\n')}\n\`\`\``;
const isFace = (cl) => !!cl.face;
await agentTurn('alpha', FT, fdoc('초안을 썼음.', ['배포 전 dry-run 필수', '마이그레이션은 되돌리기 스크립트와 함께', '배포 창은 평일 오후']), { match: isFace });
await until(() => w.document.querySelectorAll('#face-doc li').length === 3, 8000, 'draft');
await agentTurn('beta', FT, fdoc('배포 창을 고쳤음.', ['배포 전 dry-run 필수', '마이그레이션은 되돌리기 스크립트와 함께', '배포 창은 화·목 오전']), { match: isFace });
await until(() => $('face-doc-h').textContent.includes('판 2'), 8000, 'rev2');
await agentTurn('alpha', FT, fdoc('배포 창은 원래대로 두자.', ['배포 전 dry-run 필수', '마이그레이션은 되돌리기 스크립트와 함께', '배포 창은 평일 오후']), { match: isFace });
await until(() => $('face-cards').textContent.includes('⚑ 안건 1'), 8000, 'issue');
await sleep(300);
snap('06-face', '대면 모드 — 초안 쪽 · 합의문 · 검토 쪽 · 안건 카드', '두 에이전트가 합의문을 주고받는 세 열 화면');
await agentTurn('beta', FT, fdoc('고칠 것 없음.', ['배포 전 dry-run 필수', '마이그레이션은 되돌리기 스크립트와 함께', '배포 창은 평일 오후']), { match: isFace });
await until(() => $('face-cards').textContent.includes('합의'), 8000, 'agreed');
await sleep(300);
snap('07-face-agreed', '대면 모드 — 합의 · 승인 대기');

// ── 6. 메뉴 화면들
const menu = async (key, ready, name, title) => {
  w.document.querySelector(`.menu-item[data-menu="${key}"]`).click();
  await until(ready, 8000, key);
  await sleep(400);
  snap(name, title);
};
await menu('runs', () => !$('runs-page').hidden && $('rp-table').textContent.length > 0, '08-runs', '실행 상태 — 목록');
await menu('agents', () => !$('agents-page').hidden && $('ag-list').textContent.length > 0, '09-agents', '에이전트 연결');
await menu('members', () => !$('members-page').hidden, '10-members', '멤버 권한');
await menu('audit', () => !$('audit-page').hidden && $('au-table').textContent.length > 0, '11-audit', '감사 기록');
// 선점 레인에 보일 위임 몇 개
const P = (scope) => ({ kind: 'path', repo: 'web-app', scope });
const d1 = (await AG('alpha', '/api/delegations', { assignee: 'worker-a', title: '되돌리기 스크립트', spec: '마이그레이션 되돌리기', claims: [P('db/'), P('README.md'), { kind: 'resource', repo: 'deploy', scope: 'staging' }] })).delegation;
await AG('alpha', `/api/delegations/${d1.id}/status`, { status: 'running' });
const d2 = (await AG('alpha', '/api/delegations', { assignee: 'worker-b', title: '프록시 설정', spec: '자동 갱신 켜기', claims: [P('proxy/'), P('docs/')] })).delegation;
await AG('alpha', `/api/delegations/${d2.id}/status`, { status: 'running' });
await AG('alpha', '/api/delegations', { assignee: 'worker-c', title: '문서 갱신', spec: '배포 절차 문서', queue: true, claims: [P('docs/'), P('README.md')] });
w.location.hash = roomId;
await until(() => w.__S.cur === roomId, 8000, 'room again');
for (const k of ['sessions', 'people', 'claims']) {
  try {
    await menu(k, () => true, `12-${k}`, { sessions: '세션 교체', people: '참여자', claims: '선점(위임 대장)' }[k]);
  } catch (e) {
    console.log('  (건너뜀)', k, e.message);
  }
}

// ── 7. 확인 상자
w.location.hash = roomId;
await until(() => w.__S.cur === roomId, 8000, 'back');
$('st-archive')?.click();
await sleep(400);
if (!$('confirm').hidden) snap('13-confirm', '확인 상자(모달)');

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2));
await ctx.close();
w.close();
process.exit(0);

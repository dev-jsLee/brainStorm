// 한 사이드바 배치 검사(마스터 #1740 · Claude WebUI 꼴) — 실제 chromium 으로 폭 × 접힘 × 화면을 열어 자리를 재고(겹침·가로 스크롤·잘림) 단언한다.
// 실행: npm run build && node scripts/ui-layout.mjs [--shots 폴더]     (npm run test:layout)
// 브라우저는 scripts/perf-room.mjs 머리와 같은 수법 — brainstorm 의 package.json 에는 playwright 를 넣지 않고 gridbase 의 것을 빌린다
//   (PLAYWRIGHT_MODULE · GRIDBASE_BROWSER_LIBS 로 바꿀 수 있음). 없으면 «건너뜀»으로 끝난다(exit 0). 서버는 임시 setup() — 운영 안 건드림.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../dist/test/helpers.js';
const argv = process.argv.slice(2);
const SHOTS = argv.includes('--shots') ? path.resolve(argv[argv.indexOf('--shots') + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const PW = process.env.PLAYWRIGHT_MODULE ?? path.join(os.homedir(), 'workspace/gridbase/node_modules/playwright/index.mjs');
if (!fs.existsSync(PW)) {
  console.log(`배치 검사 건너뜀 — playwright 없음(${PW})`);
  process.exit(0);
}
const { chromium } = await import(PW);
async function launch() {
  const root = process.env.GRIDBASE_BROWSER_LIBS ?? path.join(os.homedir(), '.cache/gridbase-browser-libs/root');
  const lib = [path.join(root, 'usr/lib/x86_64-linux-gnu'), path.join(root, 'lib/x86_64-linux-gnu')].filter((p) => fs.existsSync(p)).join(':');
  const env = { ...process.env };
  if (lib) env.LD_LIBRARY_PATH = lib;
  const fonts = path.join(root, '..', 'fonts.conf');
  if (fs.existsSync(fonts)) env.FONTCONFIG_FILE = fonts;
  env.LC_ALL = 'C.UTF-8';
  return chromium.launch({ env });
}

const ctx = await setup();
let k = 0;
const key = () => `shot-${k++}`;
const threads = (await ctx.master('GET', '/api/threads')).json.threads;
const roomId = threads.find((t) => t.kind === 'room').id;
for (const name of ['전력', 'NAS', '장애']) await ctx.master('POST', '/api/tags', { name });
for (let i = 1; i <= 40; i++) {
  const b = i % 7 === 0 ? `#전력 #NAS\n${i}번 글 — 전력 측정 결과를 정리했음. 자세한 것은 #${Math.max(1, i - 2)} 참고.` : `${i}번 글 — 서버 실행 전달 어댑터 세션 커서 메시지 스레드 복구 측정 배포 시험 로그.\n\n- 항목 하나\n- 항목 둘`;
  const r = await ctx.master('POST', `/api/threads/${roomId}/messages`, { client_key: key(), body: b });
  if (r.status !== 201) throw new Error('post ' + r.status + JSON.stringify(r.json));
}
const titles = ['HQ 이전 점검', 'NAS 백업 경로 정리', 'C서버 전원 자동 내림', '태그별 차선 설계', '메인 채팅방 성능', '어댑터 재접속 버그', '감사 기록 묶음 상한', '대면 모드 검토'];
const made = [];
for (const title of titles) {
  const r = await ctx.master('POST', '/api/threads', { title, default_recipient: null, members: ['alpha'] });
  const id = r.json.thread.id;
  made.push(id);
  await ctx.master('POST', `/api/threads/${id}/messages`, { client_key: key(), body: `${title} — 첫 글` });
}
// 분기(트리)
const f1 = await ctx.master('POST', `/api/threads/${roomId}/fork`, { from_seq: 3, title: '방에서 갈라진 스레드', client_key: key() });
if (f1.json?.thread) await ctx.master('POST', `/api/threads/${f1.json.thread.id}/fork`, { from_seq: (await ctx.master('GET', `/api/threads/${f1.json.thread.id}/messages?tail=1&limit=1`)).json.messages?.at(-1)?.seq ?? 3, title: '재분기', client_key: key() });

const browser = await launch();
const u = new URL(ctx.base);
const [cn, cv] = ctx.cookie.split('=');
const results = [];
const problems = [];

async function shot({ w, h, collapsed, mode, scheme = 'light', drawer = false, aux = false, name }) {
  const bctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 1 });
  await bctx.addCookies([{ name: cn, value: cv, domain: u.hostname, path: '/' }]);
  await bctx.addInitScript(
    ([c, a]) => {
      localStorage.setItem('bs.lang', 'ko');
      if (c !== null) localStorage.setItem('bs.rail', c ? 'collapsed' : 'open');
      localStorage.setItem('bs.aux-open', a ? '1' : '0');
      localStorage.setItem('bs.aux-tab', 'runs');
    },
    [collapsed, aux],
  );
  const page = await bctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  const hash = mode === 'convo' ? roomId : mode === 'thread' ? made[0] : mode;
  await page.goto(`${ctx.base}/#${hash}`);
  if (mode === 'convo' || mode === 'thread') await page.waitForSelector('#messages .msg', { timeout: 20000 });
  else if (mode === 'runs') await page.waitForSelector('#runs-page:not([hidden])', { timeout: 20000 });
  else if (mode.startsWith('tag/')) await page.waitForSelector('#tag-page:not([hidden])', { timeout: 20000 });
  else await page.waitForSelector(`#${mode}-page:not([hidden])`, { timeout: 20000 });
  await page.waitForSelector('#thread-list .conv-item', { state: 'attached', timeout: 20000 });
  if (drawer) {
    await page.click('#menu-btn');
    await page.waitForTimeout(350);
  }
  // 대화는 조금 올려서 «가장 아래로» 단추가 뜨게
  if (mode === 'convo') {
    await page.evaluate(() => { const m = document.getElementById('messages'); m.scrollTop = Math.max(0, m.scrollHeight - m.clientHeight - 900); m.dispatchEvent(new Event('scroll')); });
  }
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => {
    const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const rect = (e) => { if (!vis(e)) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) }; };
    const $ = (s) => document.querySelector(s);
    const main = ['#convo', '#runs-page', '#tag-page', '#audit-page', '#agents-page', '#members-page'].map((s) => [s, $(s)]).find(([, e]) => vis(e));
    const tb = $('#to-bottom');
    return {
      docScrollX: document.documentElement.scrollWidth > window.innerWidth,
      nav: rect($('#nav')),
      menu: rect($('#menu')),
      sidebar: rect($('#sidebar')),
      threadList: vis($('#thread-list')) ? rect($('#thread-list')) : null,
      search: rect($('#search')),
      main: main ? [main[0], rect(main[1])] : null,
      aux: rect($('#aux')),
      toBottom: tb && !tb.hidden ? rect(tb) : null,
      messages: rect($('#messages')),
      sideScrollX: $('#sidebar').scrollWidth > $('#sidebar').clientWidth + 1,
      navScrollX: $('#nav').scrollWidth > $('#nav').clientWidth + 1,
      menuBtn: rect($('#menu-btn')),
      railBtn: rect($('#rail-btn')),
      bodyCls: document.body.className,
      lang: rect($('#lang-select')),
      backdrop: !$('#backdrop').hidden,
      threadsSec: rect($('.side-threads')),
      tagList: rect($('#tag-list')),
      menuItem: rect($('.menu-item[data-menu="runs"]')),
      label: rect($('.menu-item[data-menu="runs"] .mi-label')),
    };
  });
  const file = `${name}.png`;
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, file) });
  const p = [];
  if (info.docScrollX) p.push('문서 가로 스크롤');
  if (info.sideScrollX) p.push('사이드바 가로 스크롤');
  if (info.navScrollX) p.push('nav 가로 스크롤');
  if (errs.length) p.push('pageerror: ' + errs.join(' | '));
  // 겹침: 펼친 서랍이 아니면 nav 와 본문이 겹치면 안 됨
  if (!drawer && info.nav && info.main?.[1] && info.nav.r > info.main[1].x + 1 && w > 760) p.push(`nav(${info.nav.r}) 가 본문(${info.main[1].x}) 과 겹침`);
  // 꼴 단언(#1740)
  const open = !drawer && (w >= 1000 ? !collapsed : false);
  const nav = info.nav, side = info.sidebar;
  const listShown = !!side && side.w > 100 && side.x >= 0 && side.r <= w;
  if (w >= 1000) {
    if (collapsed) {
      if (nav.w !== 64) p.push(`접힘인데 nav 폭 ${nav.w}`);
      if (side) p.push('접힘인데 대화 목록이 보임');
      if (info.label && info.label.w > 2) p.push('접힘인데 메뉴 글자가 보임');
    } else {
      if (nav.w < 260 || nav.w > 284) p.push(`펼친 nav 폭 ${nav.w}(264~280 기대)`);
      if (!listShown) p.push('펼쳤는데 대화 목록이 안 보임');
      if (side && info.menu && info.menu.b > side.y + 1) p.push('메뉴가 대화 목록 위에 있지 않음');
    }
    if (info.main?.[1] && Math.abs(info.main[1].x - nav.r) > 1) p.push(`본문이 nav 오른쪽에 붙지 않음(${info.main[1].x} vs ${nav.r})`);
  } else if (w > 760) {
    if (!drawer) {
      if (nav.w !== 64) p.push(`761–999 닫힘 nav 폭 ${nav.w}`);
      if (side) p.push('761–999 닫힘인데 목록이 보임');
    } else {
      if (!listShown || nav.w < 280) p.push('761–999 서랍에 목록이 없음');
      if (!info.backdrop) p.push('서랍인데 바깥 막 없음');
      if (side && info.menu && info.menu.b > side.y + 1) p.push('서랍: 메뉴가 목록 위가 아님');
    }
  } else {
    if (!drawer && nav.r > 0) p.push('≤760 닫힘인데 서랍이 화면에 걸침');
    if (drawer) {
      if (nav.x !== 0 || !listShown) p.push('≤760 서랍에 메뉴+목록이 안 나옴');
      if (side && info.menu && info.menu.b > side.y + 1) p.push('≤760 서랍: 메뉴가 목록 위가 아님');
      if (!info.backdrop) p.push('서랍인데 바깥 막 없음');
    }
  }
  if ((mode === 'runs' || mode === 'audit') && (open || drawer) && !info.threadList) p.push('페이지 화면에서 스레드 목록이 안 보임');
  if (mode.startsWith('tag/') && (info.search || info.threadsSec || !info.tagList)) p.push('태그 방: 검색·스레드 절 숨김 · 태그 절 보임 기대');
  if (info.lang && nav && (info.lang.r > nav.r + 1)) p.push('언어 고르기가 nav 밖으로 나감');
  if (info.toBottom && info.messages && (info.toBottom.r > info.messages.r || info.toBottom.x < info.messages.x || info.toBottom.b > info.messages.b)) p.push('가장 아래로 단추가 대화 칸 밖');
  results.push({ name, w, h, collapsed, mode, scheme, drawer, info, problems: p });
  if (p.length) problems.push(`${name}: ${p.join(' · ')}`);
  await bctx.close();
}

const W = [1440, 1100, 900, 390];
for (const w of W) {
  const h = w === 390 ? 844 : 900;
  for (const mode of ['convo', 'runs']) {
    if (w > 999) {
      for (const collapsed of [false, true]) await shot({ w, h, collapsed, mode, name: `${w}-${mode}-${collapsed ? 'collapsed' : 'open'}` });
    } else {
      await shot({ w, h, collapsed: null, mode, name: `${w}-${mode}-closed` });
      await shot({ w, h, collapsed: null, mode, drawer: true, name: `${w}-${mode}-drawer` });
    }
  }
}
// 태그 방 · 다크 · 키 낮은 창 · 보조 패널
const tags = (await ctx.master('GET', '/api/tags')).json.tags;
await shot({ w: 1440, h: 900, collapsed: false, mode: `tag/${tags[0].id}`, name: '1440-tag-open' });
await shot({ w: 1440, h: 900, collapsed: false, mode: 'convo', scheme: 'dark', name: '1440-convo-open-dark' });
await shot({ w: 1440, h: 900, collapsed: true, mode: 'runs', scheme: 'dark', name: '1440-runs-collapsed-dark' });
await shot({ w: 390, h: 844, collapsed: null, mode: 'convo', scheme: 'dark', drawer: true, name: '390-convo-drawer-dark' });
await shot({ w: 900, h: 900, collapsed: null, mode: 'runs', scheme: 'dark', drawer: true, name: '900-runs-drawer-dark' });
await shot({ w: 1440, h: 900, collapsed: false, mode: 'convo', aux: true, name: '1440-convo-open-aux' });
await shot({ w: 1440, h: 620, collapsed: false, mode: 'convo', name: '1440x620-convo-open-short' });
await shot({ w: 1100, h: 900, collapsed: false, mode: 'audit', name: '1100-audit-open' });

await browser.close();
if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'layout.json'), JSON.stringify(results, null, 1));
console.log(results.map((r) => `${r.name}\tnav=${JSON.stringify(r.info.nav)}\tside=${r.info.sidebar ? r.info.sidebar.w + 'x' + r.info.sidebar.h : '숨김'}\tlist=${r.info.threadList ? 'O' : 'X'}\tmain=${r.info.main?.[0]}@${r.info.main?.[1]?.x}\ttoBottom=${JSON.stringify(r.info.toBottom)}`).join('\n'));
await ctx.close();
if (problems.length) {
  console.error('배치 검사 실패:\n' + problems.join('\n'));
  process.exit(1);
}
console.log(`배치 검사 통과 — ${results.length}장면`);
process.exit(0);

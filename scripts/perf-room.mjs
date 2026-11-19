// 메인 채팅방 성능 측정(마스터 #1732) — 실제 chromium 으로 방 열기·새 글·실행 알림 폭주·스크롤·타이핑을 잰다.
//
// 실행(작업 사본의 저장소 폴더에서):
//   npm run build && node scripts/perf-room.mjs                 # 글 250 · 1500 두 가지
//   node scripts/perf-room.mjs --n 1500 --cpu 4 --profile        # 한 가지만 · CPU 4배 느리게 · 상위 함수(CPU profile)
//   node scripts/perf-room.mjs --json out.json                   # 숫자를 파일로
//
// 브라우저: brainstorm 의 package.json 에는 playwright 를 넣지 않는다 — gridbase 의 것을 절대 경로로 빌린다
//   (PLAYWRIGHT_MODULE 로 바꿀 수 있음). 이 몸엔 시스템 라이브러리가 없어 ~/.cache/gridbase-browser-libs/root 의
//   사용자 공간 사본을 LD_LIBRARY_PATH·FONTCONFIG_FILE 로 넘기고 LC_ALL=C.UTF-8 (gridbase/test/browser.ts 와 같은 수법).
// 서버: dist/test/helpers.js 의 setup()(임시 디렉터리 · 마스터 + 에이전트 alpha·beta). 운영 서버·DB 는 안 건드린다.
// 심는 것: 방에 글 N개(본문 = 마크다운·코드블록·표 섞어 평균 ~600자 · 절반은 에이전트 답 글) · 마스터 글마다 전달 하나 →
//   alpha/beta 가 claim·start·complete 로 답 = 실행(성공) · 일부는 실패 · 첨부 없음. 끝에 실행 중 둘(1초 타이머·실행 줄용).
// 잴 것(각 시나리오의 «메인 스레드 점유» = CDP Performance.getMetrics TaskDuration 차이):
//   open.cold   새로 고침부터 마지막 글이 그려질 때까지(ms) + 첫 글이 보일 때까지
//   open.switch 다른 스레드에서 방으로 돌아올 때(ms · 점유)
//   newmsg      WS 로 새 글 하나(에이전트 답) 도착 → 화면에 붙을 때까지(ms · 점유)
//   runburst    실행 중 run 의 경과(heartbeat progress) 20번을 50ms 간격으로 → 점유 · 긴 작업(50ms+) 수
//   idle        실행 중 run 이 있는 채로 5초 가만히 → 점유(1초 타이머 등)
//   scroll      위로 3000px 굴리는 동안 프레임 간격 p95 · 33ms 넘은 프레임 수
//   typing      입력칸에 40글자 → 키 하나의 입력→다음 프레임 지연 평균·최대
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../dist/test/helpers.js';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i < 0 ? d : argv[i + 1];
};
const flag = (k) => argv.includes(`--${k}`);
const SIZES = opt('n', null) ? [Number(opt('n'))] : [250, 1500];
const CPU = Number(opt('cpu', 1));
const PROFILE = flag('profile');
const JSON_OUT = opt('json', null);

const PW = process.env.PLAYWRIGHT_MODULE ?? path.join(os.homedir(), 'workspace/gridbase/node_modules/playwright/index.mjs');
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

// ───── 글감: 마크다운·코드블록·표 섞어 평균 ~600자 ─────
let rnd = 1;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rand() * a.length)];
const WORDS = '서버 실행 전달 어댑터 세션 커서 메시지 스레드 복구 측정 배포 시험 로그 설정 토큰 경로 화면 목록 상태 결과 원인 확인'.split(' ');
const sentence = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ') + '.';
function body(i) {
  const parts = [`**${i}번 글** — ${sentence(8)} \`npm test\` 를 돌렸음.`];
  const k = i % 4;
  if (k === 0) parts.push('```js\n' + Array.from({ length: 6 }, (_, j) => `const v${j} = await api('GET', '/api/x/${j}'); // ${pick(WORDS)}`).join('\n') + '\n```');
  if (k === 1) parts.push('| 항목 | 전 | 후 |\n|---|---|---|\n' + Array.from({ length: 5 }, (_, j) => `| ${pick(WORDS)} | ${j * 13} | ${j * 7} |`).join('\n'));
  if (k === 2) parts.push(Array.from({ length: 5 }, () => `- ${sentence(6)}`).join('\n'));
  parts.push(sentence(14), sentence(12), `자세한 것은 #${Math.max(1, i - 3)} 참고.`);
  return parts.join('\n\n');
}

let keyN = 0;
const key = () => `perf-${process.pid}-${keyN++}`;

async function seed(ctx, roomId, n) {
  const t0 = Date.now();
  let made = 0;
  let i = 0;
  while (made < n) {
    i++;
    const who = i % 2 ? 'alpha' : 'beta';
    // 마스터 글(전달 하나) → 에이전트 claim·start·complete → 답 글(에이전트) + 실행 하나
    const p = await ctx.master('POST', `/api/threads/${roomId}/messages`, { client_key: key(), body: body(made + 1), recipients: [who] });
    if (p.status !== 201) throw new Error(`post ${p.status} ${JSON.stringify(p.json)}`);
    made++;
    if (made >= n) break;
    const c = (await ctx.agent(who, 'POST', '/api/adapter/claim', { worker: 'perf' })).json.claim;
    if (!c) throw new Error('claim 없음');
    await ctx.agent(who, 'POST', `/api/adapter/deliveries/${c.delivery.id}/ack`, { lease_token: c.delivery.lease_token });
    await ctx.agent(who, 'POST', `/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token });
    if (i % 17 === 0) {
      await ctx.agent(who, 'POST', `/api/adapter/runs/${c.run.id}/fail`, { run_token: c.run.run_token, error: 'adapter_error' });
      continue; // 실패 줄이 남는 글(답 없음)
    }
    const d = await ctx.agent(who, 'POST', `/api/adapter/runs/${c.run.id}/complete`, { run_token: c.run.run_token, body: body(made + 1) });
    if (d.status !== 200) throw new Error(`complete ${d.status} ${JSON.stringify(d.json)}`);
    made++;
  }
  return Date.now() - t0;
}

/** 실행 중 run 하나를 만든다(마스터 글 → claim → start) — {run, token, who} */
async function liveRun(ctx, roomId, who, text) {
  await ctx.master('POST', `/api/threads/${roomId}/messages`, { client_key: key(), body: text, recipients: [who] });
  const c = (await ctx.agent(who, 'POST', '/api/adapter/claim', { worker: 'perf' })).json.claim;
  await ctx.agent(who, 'POST', `/api/adapter/deliveries/${c.delivery.id}/ack`, { lease_token: c.delivery.lease_token });
  await ctx.agent(who, 'POST', `/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token });
  return { id: c.run.id, token: c.run.run_token, who };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (x) => Math.round(x * 10) / 10;

async function metric(cdp) {
  const m = (await cdp.send('Performance.getMetrics')).metrics;
  const g = (k) => m.find((x) => x.name === k)?.value ?? 0;
  return { task: g('TaskDuration') * 1000, script: g('ScriptDuration') * 1000, layout: g('LayoutDuration') * 1000, style: g('RecalcStyleDuration') * 1000 };
}
const diff = (a, b) => ({ task: r1(b.task - a.task), script: r1(b.script - a.script), layout: r1(b.layout - a.layout), style: r1(b.style - a.style) });

/** 화면이 조용해질 때까지(긴 작업 없이 quietMs) 기다린다 */
async function settle(page, quietMs = 300, maxMs = 15000) {
  await page.evaluate(
    ([q, max]) =>
      new Promise((ok) => {
        const start = performance.now();
        let last = performance.now(); // 마지막으로 바빴던 때
        let prev = 0;
        const tick = (t) => {
          if (prev && t - prev > 40) last = t; // 프레임이 늦게 왔다 = 바빴다
          prev = t;
          if (performance.now() - last > q || performance.now() - start > max) return ok();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    [quietMs, maxMs],
  );
}

const profAgg = new Map();
let curN = 0;
async function profiled(cdp, label, fn) {
  if (!PROFILE) return fn();
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const out = await fn();
  const { profile } = await cdp.send('Profiler.stop');
  const dt = (profile.endTime - profile.startTime) / profile.samples.length / 1000; // ms per sample(평균)
  const self = new Map();
  const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
  for (const s of profile.samples) {
    const nd = byId.get(s);
    const cf = nd.callFrame;
    const k = `${cf.functionName || '(anon)'} ${cf.url ? path.basename(cf.url) + ':' + (cf.lineNumber + 1) : ''}`.trim();
    self.set(k, (self.get(k) ?? 0) + dt);
  }
  const top = [...self].filter(([k]) => !/^\((idle|program)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => [k, r1(v)]);
  profAgg.set(`${curN}:${label}`, top);
  return out;
}

async function measure(n) {
  rnd = 1;
  curN = n;
  const ctx = await setup({ runLeaseMs: 3_600_000, deliveryLeaseMs: 3_600_000 }); // 실행 중 run 이 측정 도중 unknown 이 되지 않게
  const roomId = (await ctx.master('GET', '/api/threads')).json.threads.find((t) => t.kind === 'room').id;
  const seedMs = await seed(ctx, roomId, n);
  // 실행 중 둘(1초 타이머가 도는 «응답 생성 중» 줄) — 방 열기 전에 만든다
  const live = [await liveRun(ctx, roomId, 'alpha', '실행 중으로 남길 글 A'), await liveRun(ctx, roomId, 'beta', '실행 중으로 남길 글 B')];
  // 다른 스레드(전환 측정용)
  const other = (await ctx.master('POST', '/api/threads', { title: '다른 스레드', default_recipient: null, members: ['alpha'] })).json.thread.id;
  await ctx.master('POST', `/api/threads/${other}/messages`, { client_key: key(), body: '다른 스레드 글' });
  const info = (await ctx.master('GET', `/api/threads/${roomId}`)).json.thread;
  const lastSeq = info.last_seq;
  const roomMsgs = (await ctx.master('GET', `/api/threads/${roomId}/messages?after=0&limit=500`)).json;
  const runs = (await ctx.master('GET', `/api/threads/${roomId}/runs`)).json.runs.length;
  const dels = (await ctx.master('GET', `/api/threads/${roomId}/deliveries`)).json.deliveries.length;

  const browser = await launch();
  const bctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const u = new URL(ctx.base);
  const [cn, cv] = ctx.cookie.split('=');
  await bctx.addCookies([{ name: cn, value: cv, domain: u.hostname, path: '/' }]);
  await bctx.addInitScript(() => {
    localStorage.setItem('bs.lang', 'ko');
    window.__long = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__long.push({ start: e.startTime, dur: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch {}
  });
  const page = await bctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  const cdp = await bctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  const res = { n, seedMs, roomMsgs: null, lastSeq, runs, deliveries: dels, cpu: CPU };

  // ── 방 열기(새로 고침) ──
  const longSince = (t) => page.evaluate((t0) => window.__long.filter((x) => x.start >= t0), t);
  await profiled(cdp, 'open.cold', async () => {
    const m0 = Date.now();
    await page.goto(`${ctx.base}/#${roomId}`);
    await page.waitForSelector('#messages .msg', { timeout: 60000 });
    const first = Date.now() - m0;
    await page.waitForSelector(`#m${lastSeq}`, { state: 'attached', timeout: 60000 });
    const all = Date.now() - m0;
    await settle(page);
    const settled = Date.now() - m0;
    const nav = await page.evaluate(() => performance.now());
    const lt = await longSince(0);
    res.open_cold = { first_ms: first, all_ms: all, settled_ms: settled, long_n: lt.length, long_max: r1(Math.max(0, ...lt.map((x) => x.dur))), long_sum: r1(lt.reduce((s, x) => s + x.dur, 0)), nav_ms: r1(nav) };
  });
  // 열고 나서 바닥에 붙어 있나(px · 80 안이면 바닥)
  const gap = () => page.evaluate(() => {
    const m = document.getElementById('messages');
    return Math.round(m.scrollHeight - m.scrollTop - m.clientHeight);
  });
  res.open_cold.bottom_gap = await gap();
  res.domMsgs = await page.evaluate(() => document.querySelectorAll('#messages .msg').length);
  res.domNodes = await page.evaluate(() => document.getElementsByTagName('*').length);

  // ── 방 다시 열기(다른 스레드 → 방) ──
  await page.evaluate((id) => (location.hash = id), other);
  await page.waitForFunction((id) => S.cur === id && S.detail?.thread?.id === id, other);
  await settle(page);
  await profiled(cdp, 'open.switch', async () => {
    const a = await metric(cdp);
    const t0 = await page.evaluate(() => performance.now());
    const m0 = Date.now();
    await page.evaluate((id) => (location.hash = id), roomId);
    await page.waitForSelector(`#m${lastSeq}`, { state: 'attached', timeout: 60000 });
    const all = Date.now() - m0;
    await settle(page);
    const b = await metric(cdp);
    const lt = await longSince(t0);
    res.open_switch = { all_ms: all, busy: diff(a, b), long_n: lt.length, long_max: r1(Math.max(0, ...lt.map((x) => x.dur))) };
  });
  await page.evaluate(() => {
    const m = document.getElementById('messages');
    m.scrollTop = m.scrollHeight;
  });
  await settle(page);

  // ── 가만히 5초(실행 중 run 둘 · 1초 타이머) ──
  {
    const a = await metric(cdp);
    await sleep(5000);
    const b = await metric(cdp);
    res.idle5s = diff(a, b);
  }

  // ── 새 글 하나(WS) — 실행 중 run 하나가 끝나며 답 글 ──
  await profiled(cdp, 'newmsg', async () => {
    const a = await metric(cdp);
    const t0 = await page.evaluate(() => performance.now());
    const m0 = Date.now();
    const done = await ctx.agent(live[0].who, 'POST', `/api/adapter/runs/${live[0].id}/complete`, { run_token: live[0].token, body: body(9999) });
    const seq = done.json.message?.seq;
    if (!seq) throw new Error('complete: ' + done.status + ' ' + JSON.stringify(done.json));
    await page.waitForSelector(`#m${seq}`, { state: 'attached', timeout: 30000 });
    const shown = Date.now() - m0;
    await settle(page, 500);
    const b = await metric(cdp);
    const lt = await longSince(t0);
    res.newmsg = { shown_ms: shown, busy: diff(a, b), long_n: lt.length, long_max: r1(Math.max(0, ...lt.map((x) => x.dur))) };
  });

  // ── 실행 알림 폭주: 경과 20번 · 50ms 간격 ──
  await profiled(cdp, 'runburst', async () => {
    await settle(page);
    const a = await metric(cdp);
    const t0 = await page.evaluate(() => performance.now());
    for (let i = 0; i < 20; i++) {
      await ctx.agent(live[1].who, 'POST', `/api/adapter/runs/${live[1].id}/heartbeat`, { run_token: live[1].token, progress: `단계 ${i} — 파일 읽는 중` });
      await sleep(50);
    }
    await settle(page, 600);
    const b = await metric(cdp);
    const lt = await longSince(t0);
    res.runburst = { busy: diff(a, b), long_n: lt.length, long_max: r1(Math.max(0, ...lt.map((x) => x.dur))), long_sum: r1(lt.reduce((s, x) => s + x.dur, 0)) };
  });

  // ── 스크롤: 위로 3000px(휠 60번) ──
  await settle(page);
  await page.mouse.move(800, 400);
  await page.evaluate(() => {
    window.__frames = [];
    window.__fon = true;
    const f = (t) => {
      window.__frames.push(t);
      if (window.__fon) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, -50);
    await sleep(16);
  }
  await sleep(300);
  const fr = await page.evaluate(() => ((window.__fon = false), window.__frames));
  const gaps = fr.slice(1).map((x, i) => x - fr[i]).sort((a, b) => a - b);
  res.scroll = { frames: gaps.length, p95: r1(gaps[Math.floor(gaps.length * 0.95)] ?? 0), max: r1(gaps[gaps.length - 1] ?? 0), over33: gaps.filter((g) => g > 33.4).length };

  // ── 타이핑: 40글자 · 키 → 다음 프레임 ──
  await page.evaluate(() => {
    const m = document.getElementById('messages');
    m.scrollTop = m.scrollHeight;
  });
  await settle(page);
  await page.focus('#body');
  await page.evaluate(() => {
    window.__lat = [];
    document.getElementById('body').addEventListener('keydown', (e) => {
      const t0 = e.timeStamp;
      requestAnimationFrame(() => setTimeout(() => window.__lat.push(performance.now() - t0), 0));
    });
  });
  for (const ch of 'abcdefghij klmnopqrst uvwxyz 0123456789 ') {
    await page.keyboard.press(ch === ' ' ? 'Space' : ch);
    await sleep(30);
  }
  await sleep(300);
  const lat = await page.evaluate(() => window.__lat);
  res.typing = { keys: lat.length, avg: r1(lat.reduce((s, x) => s + x, 0) / Math.max(1, lat.length)), max: r1(Math.max(0, ...lat)) };

  // ── 옛 글 이어 받기(v0.37.0 뒤에만 의미): 맨 위로 굴려 한 쪽씩 · 전부 받은 뒤 실행 알림 20번 다시 ──
  const hasOlder = () => page.evaluate(() => typeof S.hasOlder === 'boolean' && S.hasOlder);
  if (await hasOlder()) {
    const pages = [];
    while (await hasOlder()) {
      const before = await page.evaluate(() => document.querySelectorAll('#messages .msg').length);
      const a = await metric(cdp);
      const m0 = Date.now();
      // 맨 위로 굴리고 같은 순간 화면 안 글 하나의 자리를 잡아 둔다 → 스크롤 이벤트가 옛 글을 앞에 붙인 뒤 그 글이 움직였나(px)
      const pin = await page.evaluate(() => {
        const sc = document.getElementById('messages');
        sc.scrollTop = 0;
        const top = sc.getBoundingClientRect().top;
        const e = [...sc.querySelectorAll('.msg')].find((x) => x.getBoundingClientRect().top - top > 50);
        return e ? { id: e.id, y: e.getBoundingClientRect().top - top } : null;
      });
      await page.waitForFunction((b) => document.querySelectorAll('#messages .msg').length > b && !S.olderLoading, before, { timeout: 30000 });
      const ms = Date.now() - m0;
      await settle(page);
      const b = await metric(cdp);
      // 앞에 붙인 뒤 보던 글이 그 자리에 있나(맨 위 글이 화면 안)
      const drift = pin
        ? await page.evaluate((p) => {
            const sc = document.getElementById('messages');
            return Math.round(document.getElementById(p.id).getBoundingClientRect().top - sc.getBoundingClientRect().top - p.y);
          }, pin)
        : null;
      pages.push({ ms, busy: r1(b.task - a.task), drift });
    }
    res.older = { pages: pages.length, avg_ms: r1(pages.reduce((s, x) => s + x.ms, 0) / pages.length), max_ms: Math.max(...pages.map((x) => x.ms)), avg_busy: r1(pages.reduce((s, x) => s + x.busy, 0) / pages.length), drift: pages.map((x) => x.drift) };
    res.domMsgsAll = await page.evaluate(() => document.querySelectorAll('#messages .msg').length);
    await settle(page);
    const a = await metric(cdp);
    for (let i = 0; i < 20; i++) {
      await ctx.agent(live[1].who, 'POST', `/api/adapter/runs/${live[1].id}/heartbeat`, { run_token: live[1].token, progress: `둘째 단계 ${i}` });
      await sleep(50);
    }
    await settle(page, 600);
    const b = await metric(cdp);
    res.runburst_all = { busy: diff(a, b) };
  }
  res.errors = errs;

  await browser.close();
  await ctx.close();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  return res;
}

const out = [];
for (const n of SIZES) {
  const r = await measure(n);
  out.push(r);
  console.log(`\n=== 글 ${n}개 (방 마지막 seq ${r.lastSeq} · runs ${r.runs} · deliveries ${r.deliveries} · CPU ×${r.cpu} · 심기 ${r.seedMs}ms) ===`);
  console.log(`DOM: 그린 글 ${r.domMsgs} · 노드 ${r.domNodes}`);
  console.log(`방 열기(새로 고침): 첫 글 ${r.open_cold.first_ms}ms · 전부 ${r.open_cold.all_ms}ms · 조용해짐 ${r.open_cold.settled_ms}ms · 바닥까지 ${r.open_cold.bottom_gap}px · 긴 작업 ${r.open_cold.long_n}개(최대 ${r.open_cold.long_max} · 합 ${r.open_cold.long_sum}ms)`);
  console.log(`방 다시 열기: 전부 ${r.open_switch.all_ms}ms · 점유 ${JSON.stringify(r.open_switch.busy)} · 긴 작업 ${r.open_switch.long_n}(최대 ${r.open_switch.long_max})`);
  console.log(`가만히 5초: 점유 ${JSON.stringify(r.idle5s)}`);
  console.log(`새 글(WS): 보임 ${r.newmsg.shown_ms}ms · 점유 ${JSON.stringify(r.newmsg.busy)} · 긴 작업 ${r.newmsg.long_n}(최대 ${r.newmsg.long_max})`);
  console.log(`실행 알림 20번: 점유 ${JSON.stringify(r.runburst.busy)} · 긴 작업 ${r.runburst.long_n}(최대 ${r.runburst.long_max} · 합 ${r.runburst.long_sum})`);
  console.log(`스크롤: 프레임 ${r.scroll.frames} · p95 ${r.scroll.p95}ms · 최대 ${r.scroll.max}ms · 33ms 넘음 ${r.scroll.over33}`);
  console.log(`타이핑: ${r.typing.keys}키 · 평균 ${r.typing.avg}ms · 최대 ${r.typing.max}ms`);
  if (r.older) console.log(`옛 글 이어 받기: ${r.older.pages}쪽 · 평균 ${r.older.avg_ms}ms(최대 ${r.older.max_ms}) · 쪽당 점유 ${r.older.avg_busy}ms · 보던 글 밀림(px) ${r.older.drift.join(',')} · 다 받은 뒤 글 ${r.domMsgsAll} · 실행 알림 20번 점유 ${JSON.stringify(r.runburst_all.busy)}`);
  if (r.errors.length) console.log('페이지 오류:', r.errors);
}
if (PROFILE)
  for (const [k, top] of profAgg) {
    console.log(`\n--- 상위 함수(자기 시간 ms) · ${k} ---`);
    for (const [f, ms] of top) console.log(`${String(ms).padStart(8)}  ${f}`);
  }
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ runs: out, profile: Object.fromEntries(profAgg) }, null, 2));
process.exit(0);

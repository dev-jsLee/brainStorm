// herdr 어댑터: 변환 함수 + 실제 brainStorm 서버 + 가짜 herdr 실행 파일.
//   가짜 herdr 는 상태 파일(JSON)로 창 상태·Claude 세션 UUID·cwd 를 흉내 낸다. `agent prompt` 를 받으면 가짜 세션 기록(jsonl)에
//   user 줄을 붙이고, 할 일(pending)을 적어 둔다 — 다음 `agent get` 때 시각이 된 일을 한다(답 줄 붙이기 · 상태 바꾸기).
//   프롬프트 글자로 갈래를 고른다: SLEEP · BLOCK · CLEAR · NOMARK · TOOLS · CUT · CUTEMPTY.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { findByTitle, headOf, locateTranscript, makeHerdrRunner, parseAgent, Tail, TranscriptReader } from '../adapter/herdr/runner.js';
import { BrainstormWorker } from '../adapter/openclaw-channel/src/worker.js';
import { newThread, post, setup, waitFor, type Ctx } from './helpers.js';

const asst = (id: string, content: unknown[], stop: string, model = 'claude-fake-1') =>
  JSON.stringify({ type: 'assistant', uuid: id + Math.random(), message: { id, role: 'assistant', model, content, stop_reason: stop, usage: { input_tokens: 3, output_tokens: 4 } } });

describe('herdr 어댑터: 변환', () => {
  test('agent get → 상태·세션·cwd · 모르는 상태는 unknown', () => {
    const a = parseAgent({ agent: { pane_id: 'w1:p2', agent: 'claude', agent_status: 'working', agent_session: { value: 'u-1' }, cwd: '/w' }, type: 'agent_info' });
    assert.deepEqual(a, { paneId: 'w1:p2', status: 'working', sessionId: 'u-1', cwd: '/w', agent: 'claude' });
    assert.equal(parseAgent({ agent: { pane_id: 'x', agent_status: 'weird' } }).status, 'unknown');
    assert.throws(() => parseAgent({}), /모양/);
  });

  test('창 제목 → pane id · 없거나 둘이면 던진다', () => {
    const list = { agents: [{ pane_id: 'w1:p1', terminal_title_stripped: '가 창' }, { pane_id: 'w1:p2', terminal_title_stripped: '나 창' }, { pane_id: 'w2:p1', terminal_title_stripped: '나 창' }] };
    assert.equal(findByTitle(list, '가 창'), 'w1:p1');
    assert.throws(() => findByTitle(list, '나 창'), /2개/);
    assert.throws(() => findByTitle(list, '다 창'), /0개/);
  });

  test('앞머리: run id(표지) · 스레드 제목 · 보낸 이', () => {
    const h = headOf({ runId: 'run_X', threadTitle: '배포\n계획', sender: { id: 'm', name: '마스터', isMaster: true }, lang: 'ko' });
    assert.match(h, /^\[brainStorm run_X · 스레드 «배포 계획» · 보낸 이 마스터\]\n/);
    assert.match(h, /마지막 답/);
  });

  test('기록 읽기: 표지 전은 무시 · 표지 뒤 end_turn 메시지의 text 만 답 · end_turn 뒤 이어지면 다음 것', () => {
    const r = new TranscriptReader('run_M');
    r.feed(asst('a0', [{ type: 'text', text: '옛 답' }], 'end_turn'));
    assert.equal(r.markerSeen, false);
    r.feed(JSON.stringify({ type: 'user', message: { role: 'user', content: '[brainStorm run_M · …]\n글' } }));
    assert.equal(r.markerSeen, true);
    r.feed(asst('a1', [{ type: 'text', text: '보는 중' }], 'tool_use'));
    r.feed(asst('a1', [{ type: 'tool_use', name: 'Bash', input: {} }], 'tool_use'));
    r.feed(JSON.stringify({ type: 'assistant', isSidechain: true, message: { id: 'sc', content: [{ type: 'text', text: '곁가지' }], stop_reason: 'end_turn' } }));
    assert.equal(r.answer(), '');
    r.feed(asst('a2', [{ type: 'thinking', thinking: '' }], 'end_turn'));
    r.feed(asst('a2', [{ type: 'text', text: '결론' }], 'end_turn'));
    assert.equal(r.answer(), '결론');
    r.feed(asst('a3', [{ type: 'tool_use', name: 'Read', input: {} }], 'tool_use'));
    assert.equal(r.answer(), '');
    r.feed(asst('a4', [{ type: 'text', text: '최종' }], 'end_turn', 'm2'));
    assert.equal(r.answer(), '최종');
    assert.equal(r.final?.model, 'm2');
    // 배열 content 의 표지도 읽는다
    const r2 = new TranscriptReader('run_N');
    r2.feed(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'x run_N y' }] } }));
    assert.equal(r2.markerSeen, true);
  });

  test('꼬리: 새로 붙은 완결된 줄만 · 반쪽 줄은 다음에', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-tail-'));
    const f = path.join(d, 'x.jsonl');
    fs.writeFileSync(f, 'old\n');
    const tl = Tail.atEnd(f);
    assert.deepEqual(tl.read(), []);
    fs.appendFileSync(f, 'a\nb');
    assert.deepEqual(tl.read(), ['a']);
    fs.appendFileSync(f, 'c\n');
    assert.deepEqual(tl.read(), ['bc']);
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('세션 기록 자리: cwd 인코딩 자리 · 없으면 projects/* 에서 UUID 로', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-loc-'));
    fs.mkdirSync(path.join(d, 'projects', '-w-a'), { recursive: true });
    fs.mkdirSync(path.join(d, 'projects', '-other'), { recursive: true });
    fs.writeFileSync(path.join(d, 'projects', '-w-a', 'u1.jsonl'), '');
    fs.writeFileSync(path.join(d, 'projects', '-other', 'u2.jsonl'), '');
    assert.equal(locateTranscript(d, '/w/a', 'u1'), path.join(d, 'projects', '-w-a', 'u1.jsonl'));
    assert.equal(locateTranscript(d, '/w/a', 'u2'), path.join(d, 'projects', '-other', 'u2.jsonl'));
    assert.equal(locateTranscript(d, '/w/a', 'u3'), null);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('herdr 어댑터: 작업자 (가짜 herdr)', () => {
  let ctx: Ctx;
  let dir: string;
  let bin: string;
  let stateFile: string;
  const quiet = { info() {}, warn() {}, error() {} };
  const cfg = () => path.join(dir, 'cfg');
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const setState = (patch: Record<string, unknown>) => fs.writeFileSync(stateFile, JSON.stringify({ ...state(), ...patch }));
  const calls = () => state().calls as { args: string[] }[];
  const prompts = () => calls().filter((c) => c.args[0] === 'agent' && c.args[1] === 'prompt');

  before(async () => {
    ctx = await setup();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-herdr-'));
    bin = path.join(dir, 'herdr');
    stateFile = path.join(dir, 'state.json');
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const SF = ${JSON.stringify(path.join(dir, 'state.json'))};
const st = JSON.parse(fs.readFileSync(SF, 'utf8'));
const argv = process.argv.slice(2);
if (argv[0] !== '--session' || argv[1] !== 'bs-test') { process.stderr.write(JSON.stringify({ error: { code: 'no_session', message: 'bad session ' + argv[1] } })); process.exit(1); }
const a = argv.slice(2);
st.calls.push({ args: a });
const save = () => fs.writeFileSync(SF, JSON.stringify(st));
const tfile = (u) => { const d = path.join(st.cfg, 'projects', st.cwd.replace(/[^a-zA-Z0-9]/g, '-')); fs.mkdirSync(d, { recursive: true }); return path.join(d, u + '.jsonl'); };
const append = (l) => fs.appendFileSync(tfile(st.session), l + '\\n');
const asst = (id, content, stop) => JSON.stringify({ type: 'assistant', uuid: id + Math.random(), message: { id, role: 'assistant', model: 'claude-fake-1', content, stop_reason: stop, usage: { input_tokens: 3, output_tokens: 4 } } });
const now = Date.now();
// 시각이 된 할 일
const left = [];
for (const p of st.pending) {
  if (p.at > now) { left.push(p); continue; }
  if (p.status) st.status = p.status;
  for (const l of p.lines || []) append(l);
}
st.pending = left;
const info = () => ({ pane_id: 'w1:p1', agent: 'claude', agent_status: st.status, agent_session: { agent: 'claude', kind: 'id', value: st.session }, cwd: st.cwd, terminal_title_stripped: '시험 창' });
const fail = (code) => { save(); process.stderr.write(JSON.stringify({ error: { code, message: code } })); process.exit(1); };
const out = (r) => { save(); process.stdout.write(JSON.stringify({ id: 'cli', result: r })); process.exit(0); };
if (a[0] === 'agent' && a[1] === 'list') out({ agents: [info()] });
if (a[0] === 'agent' && a[2] !== 'w1:p1' && a[2] !== 'tester') fail('agent_not_found');
if (a[1] === 'get') out({ agent: info(), type: 'agent_info' });
if (a[1] === 'send-keys') { st.status = 'idle'; st.pending = []; out({}); }
if (a[1] === 'prompt') {
  if (st.status === 'blocked') fail('agent_blocked');
  const text = a[3];
  if (text.includes('CLEAR')) st.session = st.session + '-new';
  if (!text.includes('NOMARK')) append(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }));
  const ans = '받음 ' + ((text.match(/▶ #\\d+/) || [''])[0]) + '\\n\\n답변시각:';
  st.status = 'working';
  if (text.includes('SLEEP')) st.pending.push({ at: now + 60000, status: 'idle', lines: [asst('z', [{ type: 'text', text: ans }], 'end_turn')] });
  else if (text.includes('BLOCK')) { st.status = 'blocked'; st.pending.push({ at: now + 400, status: 'working' }, { at: now + 800, status: 'idle', lines: [asst('b', [{ type: 'text', text: ans }], 'end_turn')] }); }
  else if (text.includes('TOOLS')) st.pending.push({ at: now + 100, lines: [asst('t1', [{ type: 'text', text: '보는 중' }], 'tool_use'), asst('t1', [{ type: 'tool_use', name: 'Bash', input: { command: 'ls', description: '목록 보기' } }], 'tool_use')] }, { at: now + 500, status: 'idle', lines: [asst('t2', [{ type: 'text', text: ans }], 'end_turn')] });
  else if (text.includes('CUTEMPTY')) st.pending.push({ at: now + 100, status: 'idle', lines: [asst('c', [{ type: 'tool_use', name: 'Bash', input: {} }], 'tool_use')] });
  else if (text.includes('CUT')) st.pending.push({ at: now + 100, status: 'idle', lines: [asst('c', [{ type: 'text', text: '하다 만 답' }], 'tool_use')] });
  else if (!text.includes('NOMARK')) st.pending.push({ at: now + 100, status: 'idle', lines: [asst('ok', [{ type: 'thinking', thinking: '' }], 'end_turn'), asst('ok', [{ type: 'text', text: ans }], 'end_turn')] });
  out({ type: 'agent_prompt' });
}
fail('unknown_command');
`,
      { mode: 0o755 },
    );
  });
  beforeEach(() => {
    fs.writeFileSync(stateFile, JSON.stringify({ status: 'idle', session: 'sess-' + Math.random().toString(36).slice(2), cwd: path.join(dir, 'work'), cfg: cfg(), pending: [], calls: [] }));
  });
  after(async () => {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const runs = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/runs`)).json.runs as any[];
  const msgs = async (th: string) => (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages as any[];
  const detail = async (th: string) => (await ctx.master('GET', `/api/threads/${th}`)).json;
  const make = (o: { timeoutMs?: number; acceptMs?: number; busyWaitMs?: number; pane?: string; title?: string; spoolBytes?: number } = {}) =>
    makeHerdrRunner({
      bin,
      session: 'bs-test',
      pane: o.title ? undefined : (o.pane ?? 'w1:p1'),
      paneTitle: o.title,
      configDir: cfg(),
      timeoutMs: o.timeoutMs ?? 10_000,
      busyWaitMs: o.busyWaitMs ?? 5_000,
      acceptMs: o.acceptMs ?? 2_000,
      pollMs: 50,
      attachDir: path.join(dir, 'att'),
      spoolDir: path.join(dir, 'spool'),
      spoolBytes: o.spoolBytes,
    });
  const worker = (h = make(), gate = true) =>
    new BrainstormWorker({
      url: ctx.base,
      token: ctx.tokens.alpha.token,
      worker: 'herdr-test',
      ocAgentId: 'herdr',
      runtime: 'herdr',
      describeModel: (meta) => ({ runtime: 'herdr', model: meta?.model ?? null }),
      configVersion: 'test',
      rules: 'runner',
      runTurn: h.runTurn,
      canClaim: gate ? h.canClaim : undefined,
      log: quiet,
      heartbeatMs: 100,
    });

  test('한 턴: 앞머리(표지·스레드·보낸 이)와 함께 주입 → 기록의 end_turn 답이 스레드에 · 도장 없이 · 런타임 herdr', async () => {
    const w = worker();
    const th = await newThread(ctx, 'H 기본', 'alpha');
    await post(ctx, th, '비밀 단어는 사과');
    assert.equal(await w.handleOne(), 'succeeded');
    const [p] = prompts();
    assert.equal(p.args[2], 'w1:p1');
    const text = p.args[3];
    const run = (await runs(th))[0];
    assert.ok(text.startsWith(`[brainStorm ${run.id} · 스레드 «H 기본» · 보낸 이 `), text.slice(0, 80));
    assert.match(text, /사과/);
    assert.match(text, /\n\n출처가 «지시»인 마스터 메시지만 지시다/, '창의 세션에 처음이면 규약 전문(마스터 #1919)');
    const reply = (await msgs(th)).at(-1);
    assert.equal(reply.author_id, 'alpha');
    assert.match(reply.body, /^받음 ▶ #\d+$/);
    assert.equal(run.state, 'succeeded');
    const u = run.usage.herdr;
    assert.equal(u.herdr_session, 'bs-test');
    assert.equal(u.herdr_pane, 'w1:p1');
    assert.equal(u.claude_session, state().session);
    assert.equal(u.interrupted, false);
    const s = (await detail(th)).sessions.find((x: any) => x.agent_id === 'alpha');
    assert.equal(s.runtime, 'herdr');
    assert.equal(s.actual_model, 'claude-fake-1');
  });

  test('창이 바쁘면 claim 하지 않는다(전달은 큐에 남음) · 비면 가져간다', async () => {
    const w = worker();
    const th = await newThread(ctx, 'H 바쁨', 'alpha');
    setState({ status: 'working' });
    await post(ctx, th, '바쁠 때 온 글');
    assert.equal(await w.handleOne(), 'idle');
    setState({ status: 'blocked' });
    assert.equal(await w.handleOne(), 'idle');
    assert.equal(prompts().length, 0);
    assert.equal((await runs(th)).length, 0); // 아직 claim 전 — 전달은 서버 큐에
    setState({ status: 'done' });
    assert.equal(await w.handleOne(), 'succeeded');
  });

  test('claim 뒤 창이 바빠졌으면 «사용 중» 경과를 올리고 비기를 기다린다', async () => {
    const w = worker(make(), false);
    const th = await newThread(ctx, 'H 경합', 'alpha');
    setState({ status: 'working', pending: [{ at: Date.now() + 700, status: 'idle' }] });
    await post(ctx, th, '경합');
    const p = w.handleOne();
    await waitFor(async () => (await runs(th)).find((x) => x.progress === '창이 사용 중 — 비기를 기다림'));
    assert.equal(await p, 'succeeded');
  });

  test('claim 뒤 창이 계속 바쁘면 busyWait 뒤 실패', async () => {
    const w = worker(make({ busyWaitMs: 300 }), false);
    const th = await newThread(ctx, 'H 계속 바쁨', 'alpha');
    setState({ status: 'working' });
    await post(ctx, th, '경합');
    assert.equal(await w.handleOne(), 'failed');
    assert.match(String((await runs(th))[0].error), /^herdr: 창이 사용 중\(working\)/);
    assert.equal(prompts().length, 0);
  });

  test('도구 사건은 경과로 · 중간 text 는 답이 아니다', async () => {
    const w = worker();
    const th = await newThread(ctx, 'H 도구', 'alpha');
    await post(ctx, th, 'TOOLS 써 봐');
    const p = w.handleOne();
    await waitFor(async () => (await runs(th)).find((x) => x.progress === '도구 Bash — 목록 보기'));
    assert.equal(await p, 'succeeded');
    assert.match((await msgs(th)).at(-1).body, /^받음/);
  });

  test('blocked: 자동으로 답하지 않고 «승인 기다림» 경과 · 풀리면 이어서 답', async () => {
    const w = worker();
    const th = await newThread(ctx, 'H 승인', 'alpha');
    await post(ctx, th, 'BLOCK 걸어');
    const p = w.handleOne();
    await waitFor(async () => (await runs(th)).find((x) => x.progress === '창이 승인을 기다림 — herdr 창에서 답해야 함'));
    assert.equal(await p, 'succeeded');
    assert.equal(calls().filter((c) => c.args[1] === 'send-keys').length, 0);
  });

  test('취소 → 창에 Esc 한 번 · 중단 확인 · 답 없음', async () => {
    const w = worker();
    const th = await newThread(ctx, 'H 취소', 'alpha');
    await post(ctx, th, 'SLEEP 오래');
    const p = w.handleOne();
    const r = await waitFor(async () => (await runs(th)).find((x) => x.state === 'running'));
    await waitFor(async () => prompts().length > 0);
    assert.equal((await ctx.master('POST', `/api/runs/${r.id}/cancel`)).status, 200);
    assert.equal(await p, 'cancelled');
    assert.deepEqual(calls().filter((c) => c.args[1] === 'send-keys').map((c) => c.args.slice(2)), [['w1:p1', 'esc']]);
    assert.equal((await runs(th))[0].cancel_outcome, 'acked');
    assert.equal((await msgs(th)).length, 1);
  });

  test('어댑터가 내려가면 창은 건드리지 않는다(Esc 없음)', async () => {
    const w = worker();
    const th = await newThread(ctx, 'H 내려감', 'alpha');
    await post(ctx, th, 'SLEEP 내려감');
    const stop = new AbortController();
    const p = w.handleOne(stop.signal);
    await waitFor(async () => prompts().length > 0);
    stop.abort();
    assert.equal(await p, 'lost');
    assert.equal(calls().filter((c) => c.args[1] === 'send-keys').length, 0);
  });

  test('시간 초과 → Esc 로 멈추고 failed', async () => {
    const w = worker(make({ timeoutMs: 500 }));
    const th = await newThread(ctx, 'H 시간', 'alpha');
    await post(ctx, th, 'SLEEP 시간 초과');
    assert.equal(await w.handleOne(), 'failed');
    assert.match(String((await runs(th))[0].error), /timeout 500ms/);
    assert.equal(calls().filter((c) => c.args[1] === 'send-keys').length, 1);
  });

  test('세션 UUID 가 바뀌어도(/clear) 새 기록에서 표지를 찾아 답한다', async () => {
    const w = worker();
    const th = await newThread(ctx, 'H 클리어', 'alpha');
    const before = state().session;
    await post(ctx, th, 'CLEAR 뒤 답');
    assert.equal(await w.handleOne(), 'succeeded');
    const r = (await runs(th))[0];
    assert.equal(r.usage.herdr.claude_session, before + '-new');
    assert.match((await msgs(th)).at(-1).body, /^받음/);
  });

  test('주입한 글이 기록에 안 보이면 acceptMs 뒤 실패', async () => {
    const w = worker(make({ acceptMs: 300 }));
    const th = await newThread(ctx, 'H 표지 없음', 'alpha');
    await post(ctx, th, 'NOMARK');
    assert.equal(await w.handleOne(), 'failed');
    assert.match(String((await runs(th))[0].error), /세션 기록에 안 보인다/);
  });

  test('창에서 끊김: 하다 만 text 가 있으면 그것을 올림(interrupted) · 없으면 실패', async () => {
    const w = worker();
    const th = await newThread(ctx, 'H 끊김', 'alpha');
    await post(ctx, th, 'CUT');
    assert.equal(await w.handleOne(), 'succeeded');
    assert.equal((await msgs(th)).at(-1).body, '하다 만 답');
    assert.equal((await runs(th))[0].usage.herdr.interrupted, true);
    const th2 = await newThread(ctx, 'H 빈 끊김', 'alpha');
    await post(ctx, th2, 'CUTEMPTY');
    assert.equal(await w.handleOne(), 'failed');
    assert.match(String((await runs(th2))[0].error), /답이 없다/);
  });

  test('창 제목으로 찾기 · 긴 글은 파일로 넘긴다(600)', async () => {
    const w = worker(make({ title: '시험 창', spoolBytes: 200 }));
    const th = await newThread(ctx, 'H 제목', 'alpha');
    await post(ctx, th, '긴 글 '.repeat(100));
    assert.equal(await w.handleOne(), 'succeeded');
    const [p] = prompts();
    assert.equal(p.args[2], 'w1:p1');
    const m = /먼저 이 파일을 Read 하고 그 안의 글에 답한다: (\S+)/.exec(p.args[3]);
    assert.ok(m, p.args[3]);
    assert.match(fs.readFileSync(m[1], 'utf8'), /긴 글 긴 글/);
    assert.equal(fs.statSync(m[1]).mode & 0o777, 0o600);
    assert.equal((await msgs(th)).at(-1).body, '받음');
  });
});
